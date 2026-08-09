import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { DirectusItemResponse, DirectusListResponse, directusJson, queryString } from "../lib/directus.js";
import { asBoolean, asRecord, asString, JsonRecord, redactJsonRecord, truncate } from "../lib/json.js";
import {
  NotificationContext,
  NotificationDeliveryAttemptInput,
  NotificationDeliveryAttemptRecord,
  NotificationRecipientHint,
  NotificationRequestInput,
  NotificationRequestRecord,
  NotificationStatus,
  NotificationTemplateRecord,
  RenderedNotificationMessage,
  BrowserPushSubscriptionBrowseInput,
  BrowserPushSubscriptionBrowseResult,
  BrowserPushSubscriptionCleanupInput,
  BrowserPushSubscriptionInput,
  BrowserPushSubscriptionLifecyclePatchInput,
  BrowserPushSubscriptionRecord,
  BrowserPushSubscriptionSearchInput,
  BrowserPushSubscriptionSearchResult,
  BrowserPushSubscriptionStats,
  BrowserPushSubscriptionStatsInput,
  PlatformApp,
  PlatformOrganization
} from "./types.js";

type DirectusListMeta = {
  filter_count?: number | string;
  total_count?: number | string;
};

type DirectusMetaListResponse<T> = DirectusListResponse<T> & {
  meta?: DirectusListMeta;
};

function idFromRelation(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = asRecord(value);
  return asString(record?.id);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function browserSubscriptionProofHash(secret: string): string {
  return sha256(`platform-notification-browser-subscription:${secret}`);
}

function browserSubscriptionStoredProofHash(record: BrowserPushSubscriptionRecord | null | undefined): string {
  const metadata = asRecord(record?.metadata_json);
  return asString(metadata?.browser_link_proof_hash);
}

function browserSubscriptionProofMatches(
  record: BrowserPushSubscriptionRecord | null | undefined,
  secret: string | undefined
): boolean {
  const storedHash = browserSubscriptionStoredProofHash(record);
  const suppliedSecret = asString(secret);
  return Boolean(storedHash && suppliedSecret && safeEqual(storedHash, browserSubscriptionProofHash(suppliedSecret)));
}

function assertBrowserSubscriptionCanUpdate(
  record: BrowserPushSubscriptionRecord | null | undefined,
  input: BrowserPushSubscriptionInput
): void {
  if (record?.id && browserSubscriptionStoredProofHash(record) && !browserSubscriptionProofMatches(record, input.browser_subscription_client_secret)) {
    throw Object.assign(new Error("Browser subscription ownership proof is required."), { status: 403 });
  }
}

function assertBrowserSubscriptionMatchesInstallation(
  record: BrowserPushSubscriptionRecord | null | undefined,
  input: BrowserPushSubscriptionInput
): void {
  const recordInstallationId = asString(record?.browser_installation_id);
  if (
    record?.id &&
    recordInstallationId &&
    input.browser_installation_id &&
    recordInstallationId !== input.browser_installation_id
  ) {
    throw Object.assign(new Error("Browser subscription ownership proof is required."), { status: 403 });
  }
}

function browserSubscriptionMetadata(
  input: BrowserPushSubscriptionInput,
  existing?: BrowserPushSubscriptionRecord | null
): JsonRecord {
  const metadata = redactJsonRecord(input.metadata ?? {});
  delete metadata.browser_link_proof_hash;
  delete metadata.browser_link_proof_version;
  const storedProofHash = browserSubscriptionStoredProofHash(existing);
  const suppliedSecret = asString(input.browser_subscription_client_secret);
  const proofHash = storedProofHash || (suppliedSecret ? browserSubscriptionProofHash(suppliedSecret) : "");
  return {
    ...metadata,
    ...(proofHash ? {
      browser_link_proof_hash: proofHash,
      browser_link_proof_version: "v1"
    } : {})
  };
}

function hasOwnRecordField(record: BrowserPushSubscriptionRecord | null | undefined, field: keyof BrowserPushSubscriptionRecord): boolean {
  return Boolean(record && Object.prototype.hasOwnProperty.call(record, field));
}

function browserSubscriptionRelationPayload(
  input: BrowserPushSubscriptionInput,
  existing?: BrowserPushSubscriptionRecord | null
): Record<string, string | null> {
  const payload: Record<string, string | null> = {};
  const existingOrganizationId = idFromRelation(existing?.organization_id);
  const existingAppId = idFromRelation(existing?.app_id);

  if (input.organization_id) {
    payload.organization_id = input.organization_id;
  } else if (hasOwnRecordField(existing, "organization_id")) {
    payload.organization_id = existingOrganizationId || null;
  }

  if (input.app_id) {
    payload.app_id = input.app_id;
  } else if (hasOwnRecordField(existing, "app_id")) {
    payload.app_id = existingAppId || null;
  }

  return payload;
}

function isEndpointHashUniqueError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("endpoint_hash")
    && (message.includes("unique") || message.includes("duplicate"));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addDirectusReadCacheBust(params: URLSearchParams): void {
  params.set("_", `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
}

const browserSubscriptionUpsertLocks = new Map<string, Promise<BrowserPushSubscriptionRecord>>();

async function withBrowserSubscriptionUpsertLock(
  keys: string[],
  run: () => Promise<BrowserPushSubscriptionRecord>
): Promise<BrowserPushSubscriptionRecord> {
  const lockKeys = Array.from(new Set(keys)).sort();
  const existing = lockKeys
    .map((key) => browserSubscriptionUpsertLocks.get(key))
    .filter((promise): promise is Promise<BrowserPushSubscriptionRecord> => Boolean(promise));
  if (existing.length > 0) {
    await Promise.all(existing.map((promise) => promise.catch(() => undefined)));
  }

  const promise = run();
  for (const key of lockKeys) {
    browserSubscriptionUpsertLocks.set(key, promise);
  }
  try {
    return await promise;
  } finally {
    for (const key of lockKeys) {
      if (browserSubscriptionUpsertLocks.get(key) === promise) {
        browserSubscriptionUpsertLocks.delete(key);
      }
    }
  }
}

function browserSubscriptionUpsertLockKeys(input: BrowserPushSubscriptionInput): string[] {
  const keys: string[] = [];
  const endpoint = input.subscription?.endpoint;
  if (input.browser_installation_id) {
    keys.push(`installation:${input.browser_installation_id}`);
  }
  if (endpoint) {
    keys.push(`endpoint:${sha256(endpoint)}`);
  }
  return keys.length ? keys : [`source:${input.source}`];
}

export async function getPlatformOrganization(organizationId: string): Promise<PlatformOrganization | null> {
  const fields = "id,organization_key,name,status,default_domain,default_keycloak_realm";
  const response = await directusJson<DirectusItemResponse<PlatformOrganization>>(
    `/items/${encodeURIComponent(config.platformOrganizationsCollection)}/${encodeURIComponent(organizationId)}${queryString({ fields })}`
  );
  return response.data?.id ? response.data : null;
}

export async function getPlatformApp(appId: string): Promise<PlatformApp | null> {
  const fields = [
    "id",
    "organization_id.id",
    "organization_id.organization_key",
    "organization_id.name",
    "organization_id.status",
    "organization_id.default_domain",
    "organization_id.default_keycloak_realm",
    "app_key",
    "display_name",
    "site_key",
    "keycloak_realm",
    "production_url",
    "preview_url",
    "deployment_status"
  ].join(",");
  const response = await directusJson<DirectusItemResponse<PlatformApp>>(
    `/items/${encodeURIComponent(config.platformAppsCollection)}/${encodeURIComponent(appId)}${queryString({ fields })}`
  );
  return response.data?.id ? response.data : null;
}

function notificationTemplateKey(input: NotificationRequestInput): string {
  return asString(input.notification_key) || asString(input.template_key);
}

function isActiveNotificationTemplate(template: NotificationTemplateRecord): boolean {
  const status = asString(template.status, "draft").toLowerCase();
  return status === "published" || status === "active";
}

function localeRank(template: NotificationTemplateRecord, requestedLocale: string): number {
  const locale = asString(template.locale).toLowerCase();
  const requested = requestedLocale.toLowerCase();
  if (requested && locale === requested) {
    return 0;
  }
  if (!locale || locale === "default" || locale === "en" || locale === "en-us") {
    return 1;
  }
  return 2;
}

async function getNotificationTemplate(
  notificationKey: string,
  locale?: string
): Promise<NotificationTemplateRecord | null> {
  const params = new URLSearchParams();
  params.set("fields", [
    "id",
    "notification_key",
    "name",
    "description",
    "status",
    "locale",
    "channels_json",
    "required_parameters_json",
    "sample_parameters_json",
    "subject_template",
    "title_template",
    "body_template",
    "text_template",
    "html_template",
    "data_template_json",
    "options_template_json",
    "assets_json",
    "stylesheets_json",
    "metadata_json",
    "date_created",
    "date_updated"
  ].join(","));
  params.set("filter[notification_key][_eq]", notificationKey);
  params.set("sort", "-date_updated,-date_created");
  params.set("limit", "50");
  addDirectusReadCacheBust(params);
  const response = await directusJson<DirectusListResponse<NotificationTemplateRecord>>(
    `/items/${encodeURIComponent(config.notificationTemplateCollection)}?${params.toString()}`
  );
  const requestedLocale = asString(locale);
  return (response.data ?? [])
    .filter(isActiveNotificationTemplate)
    .sort((left, right) => {
      const localeCompare = localeRank(left, requestedLocale) - localeRank(right, requestedLocale);
      if (localeCompare !== 0) {
        return localeCompare;
      }
      return asString(right.date_updated || right.date_created).localeCompare(asString(left.date_updated || left.date_created));
    })[0] ?? null;
}

function parameterValue(parameters: JsonRecord, path: string): unknown {
  const parts = path.split(".").map((part) => part.trim()).filter(Boolean);
  let current: unknown = parameters;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(part, 10);
      current = Number.isFinite(index) ? current[index] : undefined;
      continue;
    }
    const record = asRecord(current);
    if (!record || !(part in record)) {
      return undefined;
    }
    current = record[part];
  }
  return current;
}

function renderTemplatePrimitive(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function renderTemplateString(template: string | null | undefined, parameters: JsonRecord): string {
  const source = asString(template);
  if (!source) {
    return "";
  }
  return source.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    return renderTemplatePrimitive(parameterValue(parameters, key));
  });
}

function renderTemplateJson(value: unknown, parameters: JsonRecord): unknown {
  if (typeof value === "string") {
    return renderTemplateString(value, parameters);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renderTemplateJson(entry, parameters));
  }
  const record = asRecord(value);
  if (record) {
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, renderTemplateJson(entry, parameters)])
    );
  }
  return value;
}

function deliveryDryRunRequested(input: NotificationRequestInput): boolean {
  const metadata = asRecord(input.metadata) ?? {};
  const data = asRecord(input.data) ?? {};
  const runtimeCanary = asRecord(metadata.runtime_canary) ?? asRecord(metadata.canary);
  return asBoolean(metadata.dry_run)
    || asBoolean(metadata.dryRun)
    || asBoolean(data.dry_run)
    || asBoolean(data.dryRun)
    || asBoolean(runtimeCanary?.dry_run)
    || asBoolean(runtimeCanary?.dryRun);
}

function buildNotificationTemplateParameters(
  input: NotificationRequestInput,
  context: NotificationContext
): JsonRecord {
  return {
    ...(asRecord(input.data) ?? {}),
    ...(asRecord(input.parameters) ?? {}),
    data: redactJsonRecord(asRecord(input.data) ?? {}),
    metadata: redactJsonRecord(asRecord(input.metadata) ?? {}),
    context,
    organization: context.organization ?? null,
    app: context.app ?? null,
    notification: {
      event_key: input.event_key,
      source: input.source,
      severity: input.severity,
      priority: input.priority,
      notification_key: notificationTemplateKey(input),
      locale: input.locale || null,
      correlation_id: input.correlation_id
    }
  };
}

function fallbackRenderedMessage(
  input: NotificationRequestInput,
  parameters: JsonRecord
): RenderedNotificationMessage | undefined {
  const subject = renderTemplateString(input.subject, parameters);
  const body = renderTemplateString(input.body, parameters);
  if (!subject && !body) {
    return undefined;
  }
  return {
    notification_key: notificationTemplateKey(input) || undefined,
    template_key: input.template_key || input.notification_key,
    locale: input.locale,
    subject,
    title: subject,
    body,
    text: body,
    data: {},
    options: deliveryDryRunRequested(input) ? { dry_run: true } : {},
    parameters
  };
}

async function renderNotificationMessage(
  input: NotificationRequestInput,
  context: NotificationContext
): Promise<NotificationRequestInput> {
  const notificationKey = notificationTemplateKey(input);
  const parameters = buildNotificationTemplateParameters(input, context);
  if (!notificationKey) {
    const fallback = fallbackRenderedMessage(input, parameters);
    return {
      ...input,
      parameters,
      ...(fallback ? { message: fallback } : {})
    };
  }

  const template = await getNotificationTemplate(notificationKey, input.locale);
  if (!template?.id) {
    throw Object.assign(new Error(`Notification template ${notificationKey} was not found or is not active.`), { status: 404 });
  }

  const subject = renderTemplateString(template.subject_template, parameters);
  const title = renderTemplateString(template.title_template, parameters) || subject;
  const body = renderTemplateString(template.body_template, parameters);
  const text = renderTemplateString(template.text_template, parameters) || body;
  const html = renderTemplateString(template.html_template, parameters);
  const data = asRecord(renderTemplateJson(template.data_template_json ?? {}, parameters)) ?? {};
  const options = asRecord(renderTemplateJson(template.options_template_json ?? {}, parameters)) ?? {};
  const deliveryOptions = {
    ...options,
    ...(deliveryDryRunRequested(input) ? { dry_run: true } : {})
  };

  return {
    ...input,
    notification_key: notificationKey,
    template_key: input.template_key || notificationKey,
    channels: input.channels.length ? input.channels : (template.channels_json ?? []),
    parameters,
    message: {
      notification_key: notificationKey,
      template_key: input.template_key || notificationKey,
      template_id: template.id,
      locale: asString(template.locale) || input.locale,
      subject,
      title,
      body,
      text,
      html,
      data: redactJsonRecord(data),
      options: redactJsonRecord(deliveryOptions),
      parameters: redactJsonRecord(parameters),
      assets: template.assets_json ?? null,
      stylesheets: template.stylesheets_json ?? null
    }
  };
}

export async function enrichNotificationRequest(input: NotificationRequestInput): Promise<{ input: NotificationRequestInput; context: NotificationContext }> {
  const context: NotificationContext = {};
  let organizationId = input.organization_id;

  if (input.app_id) {
    const app = await getPlatformApp(input.app_id);
    if (!app) {
      throw Object.assign(new Error(`Platform app ${input.app_id} was not found.`), { status: 404 });
    }
    context.app = app;
    organizationId ||= idFromRelation(app.organization_id);
    const embeddedOrganization = asRecord(app.organization_id) as PlatformOrganization | null;
    if (embeddedOrganization?.id) {
      context.organization = embeddedOrganization;
    }
  }

  if (organizationId && !context.organization) {
    const organization = await getPlatformOrganization(organizationId);
    if (!organization) {
      throw Object.assign(new Error(`Platform organization ${organizationId} was not found.`), { status: 404 });
    }
    context.organization = organization;
  }

  const normalizedInput = {
    ...input,
    organization_id: organizationId || input.organization_id
  };

  return {
    input: await renderNotificationMessage(await resolveBrowserPushRecipients(normalizedInput), context),
    context
  };
}

function recipientChannels(input: NotificationRequestInput, recipient: NotificationRecipientHint): string[] {
  return recipient.channels?.length ? recipient.channels : input.channels;
}

function recipientWantsBrowserPush(input: NotificationRequestInput, recipient: NotificationRecipientHint): boolean {
  return recipientChannels(input, recipient).includes("browser_push");
}

function recipientUserId(recipient: NotificationRecipientHint): string {
  if (recipient.type !== "user") {
    return "";
  }
  return asString(recipient.id) || asString(recipient.data?.user_id) || asString(recipient.data?.userId);
}

function recipientEmail(recipient: NotificationRecipientHint): string {
  if (recipient.type === "email") {
    return asString(recipient.address) || asString(recipient.id);
  }
  return asString(recipient.address) || asString(recipient.data?.email) || asString(recipient.data?.user_email);
}

function browserSubscriptionRecipient(
  input: NotificationRequestInput,
  source: NotificationRecipientHint,
  subscription: BrowserPushSubscriptionRecord
): NotificationRecipientHint {
  return {
    type: "browser_subscription",
    id: subscription.id,
    display_name: source.display_name,
    locale: source.locale,
    channels: ["browser_push"],
    data: {
      ...(source.data ?? {}),
      resolved_from_type: source.type,
      resolved_from_id: source.id || undefined,
      resolved_from_address: source.address || undefined,
      browser_installation_id: subscription.browser_installation_id || undefined,
      browser_subscription_id: subscription.id,
      user_id: subscription.user_id || undefined,
      user_email: subscription.user_email || undefined,
      organization_id: idFromRelation(subscription.organization_id) || input.organization_id || undefined,
      app_id: idFromRelation(subscription.app_id) || input.app_id || undefined
    }
  };
}

async function listActiveBrowserSubscriptionsForFilter(
  field: "user_id" | "user_email",
  value: string,
  input: NotificationRequestInput,
  limit = 25
): Promise<BrowserPushSubscriptionRecord[]> {
  const params = new URLSearchParams();
  params.set("fields", "id,browser_installation_id,endpoint_hash,status,user_id,user_email,organization_id,app_id,permission,fallback_channels_json,last_seen_at,date_created,date_updated,capabilities_json,metadata_json");
  params.set("filter[status][_eq]", "active");
  params.set(`filter[${field}][_eq]`, value);
  if (input.organization_id) {
    params.set("filter[organization_id][_eq]", input.organization_id);
  }
  if (input.app_id) {
    params.set("filter[app_id][_eq]", input.app_id);
  }
  params.set("sort", "-last_seen_at,-date_updated,-date_created");
  params.set("limit", String(limit));
  const response = await directusJson<DirectusListResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}?${params.toString()}`
  );
  return response.data ?? [];
}

async function resolveBrowserPushRecipient(
  input: NotificationRequestInput,
  recipient: NotificationRecipientHint
): Promise<NotificationRecipientHint> {
  if (!recipientWantsBrowserPush(input, recipient) || recipient.type === "browser_subscription") {
    return recipient;
  }
  if (recipient.type !== "user" && recipient.type !== "email") {
    return recipient;
  }

  const userId = recipientUserId(recipient);
  const email = recipientEmail(recipient);
  let candidates: BrowserPushSubscriptionRecord[] = [];
  if (userId) {
    candidates = await listActiveBrowserSubscriptionsForFilter("user_id", userId, input);
  }
  if (candidates.length === 0 && email) {
    candidates = await listActiveBrowserSubscriptionsForFilter("user_email", email, input);
  }

  const subscription = preferredBrowserSubscriptionRecord(candidates);
  if (!subscription?.id) {
    const target = userId || email || recipient.id || recipient.address || recipient.type;
    throw Object.assign(new Error(`No active browser push subscription was found for notification recipient ${target}.`), { status: 404 });
  }
  return browserSubscriptionRecipient(input, recipient, subscription);
}

async function resolveBrowserPushRecipients(input: NotificationRequestInput): Promise<NotificationRequestInput> {
  if (!input.channels.includes("browser_push")) {
    return input;
  }
  const recipients: NotificationRecipientHint[] = [];
  for (const recipient of input.recipients) {
    recipients.push(await resolveBrowserPushRecipient(input, recipient));
  }
  return { ...input, recipients };
}

export async function findRequestByIdempotencyKey(source: string, idempotencyKey: string): Promise<NotificationRequestRecord | null> {
  if (!idempotencyKey) {
    return null;
  }
  const params = new URLSearchParams();
  params.set("fields", "id,event_key,source,status,correlation_id,idempotency_key,queue_topic,queued_at,requested_at,last_message,error_message");
  params.set("filter[source][_eq]", source);
  params.set("filter[idempotency_key][_eq]", idempotencyKey);
  params.set("sort", "-requested_at,-date_created");
  params.set("limit", "1");
  params.set("_cb", randomUUID());
  const response = await directusJson<DirectusListResponse<NotificationRequestRecord>>(
    `/items/${encodeURIComponent(config.notificationRequestCollection)}?${params.toString()}`
  );
  return response.data?.[0] ?? null;
}

export async function createNotificationRequest(
  input: NotificationRequestInput,
  context: NotificationContext
): Promise<NotificationRequestRecord> {
  const now = new Date().toISOString();
  const response = await directusJson<DirectusItemResponse<NotificationRequestRecord>>(
    `/items/${encodeURIComponent(config.notificationRequestCollection)}`,
    {
      method: "POST",
      body: {
        id: randomUUID(),
        event_key: input.event_key,
        source: input.source,
        severity: input.severity,
        priority: input.priority,
        status: "queued",
        organization_id: input.organization_id || null,
        app_id: input.app_id || null,
        actor_user_id: input.actor_user_id || null,
        notification_key: input.notification_key || input.template_key || null,
        template_key: input.template_key || input.notification_key || null,
        locale: input.locale || null,
        subject_hint: input.message?.subject || input.subject || null,
        body_hint: input.message?.body || input.body || null,
        requested_channels_json: input.channels,
        recipients_json: input.recipients,
        template_parameters_json: redactJsonRecord(input.parameters),
        rendered_message_json: input.message ? redactJsonRecord(input.message as unknown as JsonRecord) : {},
        data_json: redactJsonRecord(input.data),
        metadata_json: redactJsonRecord(input.metadata),
        context_json: context,
        dedupe_key: input.dedupe_key || null,
        idempotency_key: input.idempotency_key || null,
        correlation_id: input.correlation_id,
        scheduled_for: input.scheduled_for || null,
        expires_at: input.expires_at || null,
        requested_at: now,
        queued_at: null,
        queue_topic: config.notificationRequestedTopic,
        last_message: "Notification request accepted.",
        error_message: null
      }
    }
  );
  if (!response.data?.id) {
    throw new Error("Directus did not return a notification request id.");
  }
  return response.data;
}

export async function getNotificationRequest(id: string): Promise<NotificationRequestRecord> {
  const fields = [
    "id",
    "event_key",
    "source",
    "severity",
    "priority",
    "status",
    "correlation_id",
    "idempotency_key",
    "organization_id",
    "app_id",
    "actor_user_id",
    "notification_key",
    "template_key",
    "locale",
    "requested_channels_json",
    "recipients_json",
    "template_parameters_json",
    "rendered_message_json",
    "data_json",
    "context_json",
    "metadata_json",
    "queue_topic",
    "requested_at",
    "queued_at",
    "started_at",
    "finished_at",
    "last_message",
    "error_message"
  ].join(",");
  const response = await directusJson<DirectusItemResponse<NotificationRequestRecord>>(
    `/items/${encodeURIComponent(config.notificationRequestCollection)}/${encodeURIComponent(id)}${queryString({ fields })}`
  );
  if (!response.data?.id) {
    throw Object.assign(new Error(`Notification request ${id} was not found.`), { status: 404 });
  }
  return response.data;
}

export async function getBrowserPushSubscription(id: string): Promise<BrowserPushSubscriptionRecord> {
  const fields = [
    "id",
    "source",
    "browser_installation_id",
    "endpoint",
    "endpoint_hash",
    "expiration_time",
    "p256dh",
    "auth",
    "user_id",
    "user_email",
    "user_phone",
    "organization_id",
    "app_id",
    "permission",
    "capabilities_json",
    "fallback_channels_json",
    "user_agent",
    "metadata_json",
    "status",
    "last_seen_at",
    "date_created",
    "date_updated"
  ].join(",");
  const response = await directusJson<DirectusItemResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}/${encodeURIComponent(id)}${queryString({ fields })}`
  );
  if (!response.data?.id) {
    throw Object.assign(new Error(`Browser push subscription ${id} was not found.`), { status: 404 });
  }
  return response.data;
}

export async function updateNotificationRequest(id: string, patch: JsonRecord): Promise<void> {
  await directusJson<DirectusItemResponse<NotificationRequestRecord>>(
    `/items/${encodeURIComponent(config.notificationRequestCollection)}/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: patch
    }
  );
}

export async function markRequestQueued(id: string): Promise<void> {
  await updateNotificationRequest(id, {
    status: "queued",
    queued_at: new Date().toISOString(),
    last_message: "Notification request was published to the communication queue.",
    queue_topic: config.notificationRequestedTopic,
    error_message: null
  });
}

export async function markRequestQueueFailed(id: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : "Failed to publish notification request.";
  await updateNotificationRequest(id, {
    status: "failed",
    finished_at: new Date().toISOString(),
    last_message: "Notification request could not be published to the communication queue.",
    error_message: truncate(message, 4000)
  });
}

export async function patchNotificationStatus(
  id: string,
  values: {
    status: NotificationStatus;
    message?: string;
    result_json?: JsonRecord;
    error_message?: string;
    started_at?: string;
    finished_at?: string;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const terminal = values.status === "sent" || values.status === "partially_sent" || values.status === "failed" || values.status === "canceled";
  await updateNotificationRequest(id, {
    status: values.status,
    last_message: values.message || null,
    result_json: values.result_json ? redactJsonRecord(values.result_json) : undefined,
    error_message: values.error_message || null,
    started_at: values.started_at || (values.status === "processing" ? now : undefined),
    finished_at: values.finished_at || (terminal ? now : undefined)
  });
}

export async function createDeliveryAttempt(
  requestId: string,
  input: NotificationDeliveryAttemptInput
): Promise<JsonRecord> {
  const now = new Date().toISOString();
  const response = await directusJson<DirectusItemResponse<JsonRecord>>(
    `/items/${encodeURIComponent(config.notificationDeliveryCollection)}`,
    {
      method: "POST",
      body: {
        id: randomUUID(),
        notification_request_id: requestId,
        channel: input.channel,
        provider_key: input.provider_key || null,
        recipient_json: redactJsonRecord(input.recipient_json),
        message_json: input.message_json ? redactJsonRecord(input.message_json) : {},
        status: input.status,
        provider_message_id: input.provider_message_id || null,
        request_payload_json: input.request_payload_json ? redactJsonRecord(input.request_payload_json) : {},
        response_json: input.response_json ? redactJsonRecord(input.response_json) : {},
        error_message: input.error_message || null,
        attempted_at: now,
        finished_at: ["sent", "failed", "skipped"].includes(input.status) ? now : null
      }
    }
  );
  if (!response.data?.id) {
    throw new Error("Directus did not return a delivery attempt id.");
  }
  return response.data;
}

export async function listDeliveryAttemptsForRequest(requestId: string): Promise<NotificationDeliveryAttemptRecord[]> {
  const fields = [
    "id",
    "notification_request_id",
    "channel",
    "provider_key",
    "recipient_json",
    "message_json",
    "status",
    "provider_message_id",
    "request_payload_json",
    "response_json",
    "error_message",
    "attempted_at",
    "finished_at",
    "date_created",
    "date_updated"
  ].join(",");
  const params = new URLSearchParams();
  params.set("fields", fields);
  params.set("filter[notification_request_id][_eq]", requestId);
  params.set("sort", "attempted_at,date_created");
  params.set("limit", "50");
  const response = await directusJson<DirectusListResponse<NotificationDeliveryAttemptRecord>>(
    `/items/${encodeURIComponent(config.notificationDeliveryCollection)}?${params.toString()}`
  );
  return response.data ?? [];
}

async function findBrowserSubscriptionByEndpointHash(endpointHash: string): Promise<BrowserPushSubscriptionRecord | null> {
  const params = new URLSearchParams();
  params.set("fields", "id,browser_installation_id,endpoint_hash,status,user_id,permission,fallback_channels_json,last_seen_at,date_created,date_updated,metadata_json");
  params.set("filter[endpoint_hash][_eq]", endpointHash);
  params.set("sort", "-last_seen_at,-date_updated,-date_created");
  params.set("limit", "1");
  addDirectusReadCacheBust(params);
  const response = await directusJson<DirectusListResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}?${params.toString()}`
  );
  return response.data?.[0] ?? null;
}

async function findBrowserSubscriptionById(id: string): Promise<BrowserPushSubscriptionRecord | null> {
  const params = new URLSearchParams();
  params.set("fields", "id,browser_installation_id,endpoint_hash,status,user_id,permission,fallback_channels_json,last_seen_at,date_created,date_updated,metadata_json");
  params.set("filter[id][_eq]", id);
  params.set("limit", "1");
  addDirectusReadCacheBust(params);
  const response = await directusJson<DirectusListResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}?${params.toString()}`
  );
  return response.data?.[0] ?? null;
}

function browserSubscriptionTime(record: BrowserPushSubscriptionRecord): number {
  const parsed = Date.parse(record.last_seen_at || record.date_updated || record.date_created || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function browserSubscriptionRank(record: BrowserPushSubscriptionRecord): number {
  if (record.status === "active" && record.endpoint_hash) {
    return 4;
  }
  if (record.endpoint_hash) {
    return 3;
  }
  if (record.status === "active") {
    return 2;
  }
  return 1;
}

function preferredBrowserSubscriptionRecord(records: BrowserPushSubscriptionRecord[]): BrowserPushSubscriptionRecord | null {
  let selected: BrowserPushSubscriptionRecord | null = null;
  for (const record of records) {
    if (!selected) {
      selected = record;
      continue;
    }
    const rank = browserSubscriptionRank(record);
    const selectedRank = browserSubscriptionRank(selected);
    if (rank > selectedRank || (rank === selectedRank && browserSubscriptionTime(record) > browserSubscriptionTime(selected))) {
      selected = record;
    }
  }
  return selected;
}

async function patchBrowserSubscription(
  id: string,
  payload: Record<string, unknown>
): Promise<BrowserPushSubscriptionRecord | null> {
  const response = await directusJson<DirectusItemResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: payload
    }
  );
  return response.data?.id ? response.data : null;
}

function browserSubscriptionLifecyclePayload(
  input: BrowserPushSubscriptionLifecyclePatchInput,
  now = new Date().toISOString()
): Record<string, unknown> {
  return {
    status: input.status,
    metadata_json: redactJsonRecord({
      ...(input.metadata ?? {}),
      lifecycle_reason: input.reason || input.status,
      lifecycle_message: input.message || undefined,
      lifecycle_provider_status_code: input.provider_status_code ?? undefined,
      lifecycle_updated_at: now
    })
  };
}

export async function patchBrowserPushSubscriptionLifecycle(
  id: string,
  input: BrowserPushSubscriptionLifecyclePatchInput
): Promise<BrowserPushSubscriptionRecord> {
  const patched = await patchBrowserSubscription(id, browserSubscriptionLifecyclePayload(input));
  if (!patched?.id) {
    throw new Error("Directus did not return a browser subscription lifecycle record.");
  }
  return patched;
}

function browserSubscriptionDisplayName(record: BrowserPushSubscriptionRecord): string {
  const metadata = asRecord(record.metadata_json);
  const capabilities = asRecord(record.capabilities_json);
  const metadataLink = asRecord(metadata?.notification_link);
  const capabilityLink = asRecord(capabilities?.notification_link);
  return asString(metadataLink?.display_name) ||
    asString(capabilityLink?.display_name) ||
    asString(record.user_email) ||
    asString(record.user_id);
}

function searchHaystack(record: BrowserPushSubscriptionRecord, field: string): string[] {
  const displayName = browserSubscriptionDisplayName(record);
  if (field === "id") {
    return [record.id];
  }
  if (field === "user_id") {
    return [asString(record.user_id)];
  }
  if (field === "email") {
    return [asString(record.user_email)];
  }
  if (field === "browser_installation_id") {
    return [asString(record.browser_installation_id)];
  }
  if (field === "source") {
    return [asString(record.source)];
  }
  if (field === "name") {
    return [displayName];
  }
  return [
    record.id,
    asString(record.browser_installation_id),
    asString(record.user_id),
    asString(record.user_email),
    asString(record.source),
    displayName
  ];
}

function subscriptionMatchesSearch(record: BrowserPushSubscriptionRecord, query: string, field: string): boolean {
  if (!query) {
    return true;
  }
  const normalizedQuery = query.toLowerCase();
  return searchHaystack(record, field).some((value) => value.toLowerCase().includes(normalizedQuery));
}

function browserSubscriptionSearchResult(record: BrowserPushSubscriptionRecord): BrowserPushSubscriptionSearchResult {
  return {
    id: record.id,
    browser_installation_id: record.browser_installation_id || null,
    user_id: record.user_id || null,
    user_email: record.user_email || null,
    display_name: browserSubscriptionDisplayName(record) || null,
    organization_id: idFromRelation(record.organization_id) || null,
    app_id: idFromRelation(record.app_id) || null,
    status: record.status || null,
    permission: record.permission || null,
    last_seen_at: record.last_seen_at || null,
    date_created: record.date_created || null,
    date_updated: record.date_updated || null
  };
}

export async function searchBrowserPushSubscriptions(
  input: BrowserPushSubscriptionSearchInput
): Promise<BrowserPushSubscriptionSearchResult[]> {
  const query = asString(input.query).toLowerCase();
  const field = asString(input.field, "all");
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 25)));
  const params = new URLSearchParams();
  params.set("fields", "id,browser_installation_id,status,user_id,user_email,organization_id,app_id,permission,last_seen_at,date_created,date_updated,capabilities_json,metadata_json");
  params.set("filter[status][_eq]", asString(input.status, "active"));
  params.set("filter[organization_id][_eq]", input.organization_id);
  params.set("filter[app_id][_eq]", input.app_id);
  if (query && field === "user_id") {
    params.set("filter[user_id][_icontains]", query);
  }
  if (query && field === "email") {
    params.set("filter[user_email][_icontains]", query);
  }
  params.set("sort", "-last_seen_at,-date_updated,-date_created");
  params.set("limit", String(field === "name" || field === "all" || field === "id" ? Math.min(500, limit * 20) : limit));
  const response = await directusJson<DirectusListResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}?${params.toString()}`
  );
  return (response.data ?? [])
    .filter((record) => subscriptionMatchesSearch(record, query, field))
    .slice(0, limit)
    .map(browserSubscriptionSearchResult);
}

const BROWSER_SUBSCRIPTION_BROWSE_FIELDS = [
  "id",
  "source",
  "browser_installation_id",
  "endpoint_hash",
  "expiration_time",
  "user_id",
  "user_email",
  "organization_id",
  "app_id",
  "permission",
  "capabilities_json",
  "fallback_channels_json",
  "user_agent",
  "metadata_json",
  "status",
  "last_seen_at",
  "date_created",
  "date_updated"
].join(",");

function normalizedStringList(values: Array<string | undefined> | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const trimmed = asString(value);
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function browserSubscriptionStatuses(input: BrowserPushSubscriptionBrowseInput | BrowserPushSubscriptionStatsInput): string[] {
  return normalizedStringList([input.status, ...(input.statuses ?? [])]);
}

function browserSubscriptionSort(sort: BrowserPushSubscriptionBrowseInput["sort"]): string {
  switch (sort) {
    case "last_seen_at_asc":
      return "last_seen_at,date_updated,date_created";
    case "created_desc":
      return "-date_created,-last_seen_at,-date_updated";
    case "created_asc":
      return "date_created,last_seen_at,date_updated";
    case "updated_desc":
      return "-date_updated,-last_seen_at,-date_created";
    case "updated_asc":
      return "date_updated,last_seen_at,date_created";
    case "last_seen_at_desc":
    default:
      return "-last_seen_at,-date_updated,-date_created";
  }
}

function addBrowserSubscriptionDirectFilters(
  params: URLSearchParams,
  input: BrowserPushSubscriptionBrowseInput | BrowserPushSubscriptionStatsInput
): void {
  if (input.organization_id) {
    params.set("filter[organization_id][_eq]", input.organization_id);
  }
  if (input.app_id) {
    params.set("filter[app_id][_eq]", input.app_id);
  }
  if (input.source) {
    params.set("filter[source][_eq]", input.source);
  }
  if (input.browser_installation_id) {
    params.set("filter[browser_installation_id][_eq]", input.browser_installation_id);
  }

  const statuses = browserSubscriptionStatuses(input);
  if (statuses.length === 1) {
    params.set("filter[status][_eq]", statuses[0]);
  }
  if (input.permission) {
    params.set("filter[permission][_eq]", input.permission);
  }
  if (typeof input.has_endpoint === "boolean") {
    params.set(input.has_endpoint ? "filter[endpoint_hash][_nnull]" : "filter[endpoint_hash][_null]", "true");
  }

  const dateField = asString(input.date_field, "last_seen_at");
  if (input.date_start) {
    params.set(`filter[${dateField}][_gte]`, input.date_start);
  }
  if (input.date_end) {
    params.set(`filter[${dateField}][_lt]`, input.date_end);
  }

  const query = asString(input.query);
  const field = asString(input.field, "all");
  if (!query) {
    return;
  }
  if (field === "id") {
    params.set("filter[id][_icontains]", query);
  } else if (field === "user_id") {
    params.set("filter[user_id][_icontains]", query);
  } else if (field === "email") {
    params.set("filter[user_email][_icontains]", query);
  } else if (field === "browser_installation_id") {
    params.set("filter[browser_installation_id][_icontains]", query);
  } else if (field === "source") {
    params.set("filter[source][_icontains]", query);
  }
}

function browserSubscriptionNeedsServiceSideFiltering(
  input: BrowserPushSubscriptionBrowseInput | BrowserPushSubscriptionStatsInput
): boolean {
  const query = asString(input.query);
  const field = asString(input.field, "all");
  return browserSubscriptionStatuses(input).length > 1
    || Boolean(query && (field === "all" || field === "name"))
    || Boolean(asString(input.name_prefix))
    || typeof input.persistent === "boolean";
}

function browserSubscriptionPersistentFlag(record: BrowserPushSubscriptionRecord): boolean | null {
  const link = browserSubscriptionNotificationLink(record);
  return typeof link?.persistent === "boolean" ? link.persistent : null;
}

function subscriptionMatchesBrowse(
  record: BrowserPushSubscriptionRecord,
  input: BrowserPushSubscriptionBrowseInput | BrowserPushSubscriptionStatsInput
): boolean {
  const statuses = browserSubscriptionStatuses(input);
  if (statuses.length > 0 && !statuses.includes(asString(record.status))) {
    return false;
  }

  if (typeof input.persistent === "boolean" && browserSubscriptionPersistentFlag(record) !== input.persistent) {
    return false;
  }

  const namePrefix = asString(input.name_prefix).toLowerCase();
  if (namePrefix && !browserSubscriptionDisplayName(record).toLowerCase().startsWith(namePrefix)) {
    return false;
  }

  const query = asString(input.query).toLowerCase();
  const field = asString(input.field, "all");
  if (query && !subscriptionMatchesSearch(record, query, field)) {
    return false;
  }

  return true;
}

function directusMetaCount(meta: DirectusListMeta | undefined): number {
  const raw = meta?.filter_count ?? meta?.total_count ?? 0;
  const count = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

async function countBrowserPushSubscriptions(
  input: BrowserPushSubscriptionBrowseInput | BrowserPushSubscriptionStatsInput
): Promise<number> {
  const params = new URLSearchParams();
  params.set("limit", "0");
  params.set("meta", "filter_count");
  addBrowserSubscriptionDirectFilters(params, input);
  addDirectusReadCacheBust(params);
  const response = await directusJson<DirectusMetaListResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}?${params.toString()}`
  );
  return directusMetaCount(response.meta);
}

async function fetchBrowserSubscriptionPage(
  input: BrowserPushSubscriptionBrowseInput | BrowserPushSubscriptionStatsInput,
  limit: number,
  offset: number,
  sort: string
): Promise<BrowserPushSubscriptionRecord[]> {
  const params = new URLSearchParams();
  params.set("fields", BROWSER_SUBSCRIPTION_BROWSE_FIELDS);
  params.set("sort", sort);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  addBrowserSubscriptionDirectFilters(params, input);
  addDirectusReadCacheBust(params);
  const response = await directusJson<DirectusListResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}?${params.toString()}`
  );
  return response.data ?? [];
}

function resolveScanLimit(
  input: BrowserPushSubscriptionBrowseInput | BrowserPushSubscriptionStatsInput,
  fallback: number
): number {
  const requested = Math.floor(input.scan_limit ?? fallback);
  return Math.max(1, Math.min(20000, requested));
}

async function scanBrowserSubscriptions(
  input: BrowserPushSubscriptionBrowseInput | BrowserPushSubscriptionStatsInput,
  totalRecords: number,
  scanLimit: number,
  sort: string
): Promise<{ records: BrowserPushSubscriptionRecord[]; scannedRecords: number; scanTruncated: boolean }> {
  const records: BrowserPushSubscriptionRecord[] = [];
  const pageSize = Math.min(500, scanLimit);
  let offset = 0;
  while (records.length < scanLimit) {
    const limit = Math.min(pageSize, scanLimit - records.length);
    const page = await fetchBrowserSubscriptionPage(input, limit, offset, sort);
    records.push(...page);
    offset += page.length;
    if (page.length < limit) {
      break;
    }
  }
  return {
    records,
    scannedRecords: records.length,
    scanTruncated: totalRecords > records.length
  };
}

function browserSubscriptionBrowseResult(record: BrowserPushSubscriptionRecord): BrowserPushSubscriptionBrowseResult {
  const capabilities = asRecord(record.capabilities_json);
  const notificationLink = browserSubscriptionNotificationLink(record);
  const fallbackChannels = Array.isArray(record.fallback_channels_json)
    ? record.fallback_channels_json
    : null;
  return {
    ...browserSubscriptionSearchResult(record),
    source: record.source || null,
    user_agent: record.user_agent || null,
    has_endpoint: Boolean(record.endpoint_hash),
    endpoint_hash_prefix: record.endpoint_hash ? record.endpoint_hash.slice(0, 12) : null,
    expiration_time: record.expiration_time || null,
    fallback_channels: fallbackChannels,
    persistent: browserSubscriptionPersistentFlag(record),
    notification_link: notificationLink,
    capability_reason: asString(capabilities?.reason) || null,
    registration_status: asString(capabilities?.registration_status) || null,
    fallback_required: typeof capabilities?.fallback_required === "boolean" ? capabilities.fallback_required : null,
    disabled_by_user: typeof capabilities?.disabled_by_user === "boolean" ? capabilities.disabled_by_user : null
  };
}

export async function browseBrowserPushSubscriptions(
  input: BrowserPushSubscriptionBrowseInput
): Promise<{
  browser_subscriptions: BrowserPushSubscriptionBrowseResult[];
  total_records: number;
  matching_records: number;
  matching_records_exact: boolean;
  count: number;
  limit: number;
  offset: number;
  next_offset: number | null;
  scanned_records: number;
  scan_limit: number;
  scan_truncated: boolean;
}> {
  const limit = Math.max(1, Math.min(250, Math.floor(input.limit ?? 50)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const sort = browserSubscriptionSort(input.sort);
  const totalRecords = await countBrowserPushSubscriptions(input);
  const serviceSideFiltering = browserSubscriptionNeedsServiceSideFiltering(input);

  if (!serviceSideFiltering) {
    const records = await fetchBrowserSubscriptionPage(input, limit, offset, sort);
    const nextOffset = offset + records.length < totalRecords ? offset + records.length : null;
    return {
      browser_subscriptions: records.map(browserSubscriptionBrowseResult),
      total_records: totalRecords,
      matching_records: totalRecords,
      matching_records_exact: true,
      count: records.length,
      limit,
      offset,
      next_offset: nextOffset,
      scanned_records: records.length,
      scan_limit: limit,
      scan_truncated: false
    };
  }

  const scanLimit = resolveScanLimit(input, Math.max(1000, offset + limit));
  const scanned = await scanBrowserSubscriptions(input, totalRecords, scanLimit, sort);
  const matching = scanned.records.filter((record) => subscriptionMatchesBrowse(record, input));
  const page = matching.slice(offset, offset + limit);
  const hasMore = matching.length > offset + limit || scanned.scanTruncated;
  return {
    browser_subscriptions: page.map(browserSubscriptionBrowseResult),
    total_records: totalRecords,
    matching_records: matching.length,
    matching_records_exact: !scanned.scanTruncated,
    count: page.length,
    limit,
    offset,
    next_offset: hasMore && page.length > 0 ? offset + page.length : null,
    scanned_records: scanned.scannedRecords,
    scan_limit: scanLimit,
    scan_truncated: scanned.scanTruncated
  };
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function displayNameInitial(displayName: string): string {
  const first = displayName.trim()[0]?.toUpperCase();
  if (!first) {
    return "(blank)";
  }
  return /^[A-Z0-9]$/.test(first) ? first : "#";
}

function dateBucketKey(value: string | null | undefined, bucket: BrowserPushSubscriptionStatsInput["bucket"]): string | null {
  if (!bucket || !value) {
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  if (bucket === "hour") {
    date.setUTCMinutes(0, 0, 0);
    return date.toISOString();
  }
  if (bucket === "day") {
    date.setUTCHours(0, 0, 0, 0);
    return date.toISOString().slice(0, 10);
  }
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + mondayOffset);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

function recordDateField(record: BrowserPushSubscriptionRecord, field: string): string | null | undefined {
  if (field === "date_created") {
    return record.date_created;
  }
  if (field === "date_updated") {
    return record.date_updated;
  }
  if (field === "expiration_time") {
    return record.expiration_time;
  }
  return record.last_seen_at;
}

export async function getBrowserPushSubscriptionStats(
  input: BrowserPushSubscriptionStatsInput
): Promise<BrowserPushSubscriptionStats> {
  const sort = browserSubscriptionSort("last_seen_at_desc");
  const totalRecords = await countBrowserPushSubscriptions(input);
  const scanLimit = resolveScanLimit(input, 5000);
  const scanned = await scanBrowserSubscriptions(input, totalRecords, scanLimit, sort);
  const matching = scanned.records.filter((record) => subscriptionMatchesBrowse(record, input));
  const serviceSideFiltering = browserSubscriptionNeedsServiceSideFiltering(input);
  const uniqueDisplayNames = new Set<string>();
  const uniqueBrowserInstallations = new Set<string>();
  const uniqueUserIds = new Set<string>();
  const uniqueUserEmails = new Set<string>();
  const statusCounts: Record<string, number> = {};
  const permissionCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  const displayNameInitialCounts: Record<string, number> = {};
  const persistentCounts = { persistent: 0, non_persistent: 0, unknown: 0 };
  const dateBuckets: Record<string, number> = {};

  for (const record of matching) {
    const displayName = browserSubscriptionDisplayName(record);
    if (displayName) {
      uniqueDisplayNames.add(displayName.toLowerCase());
    }
    const browserInstallationId = asString(record.browser_installation_id);
    if (browserInstallationId) {
      uniqueBrowserInstallations.add(browserInstallationId);
    }
    const userId = asString(record.user_id);
    if (userId) {
      uniqueUserIds.add(userId);
    }
    const userEmail = asString(record.user_email).toLowerCase();
    if (userEmail) {
      uniqueUserEmails.add(userEmail);
    }

    incrementCount(statusCounts, asString(record.status, "(blank)"));
    incrementCount(permissionCounts, asString(record.permission, "(blank)"));
    incrementCount(sourceCounts, asString(record.source, "(blank)"));
    incrementCount(displayNameInitialCounts, displayNameInitial(displayName));

    const persistent = browserSubscriptionPersistentFlag(record);
    if (persistent === true) {
      persistentCounts.persistent += 1;
    } else if (persistent === false) {
      persistentCounts.non_persistent += 1;
    } else {
      persistentCounts.unknown += 1;
    }

    const bucketKey = dateBucketKey(recordDateField(record, asString(input.date_field, "last_seen_at")), input.bucket);
    if (bucketKey) {
      incrementCount(dateBuckets, bucketKey);
    }
  }

  return {
    total_records: totalRecords,
    matching_records: serviceSideFiltering ? matching.length : totalRecords,
    matching_records_exact: !serviceSideFiltering || !scanned.scanTruncated,
    scanned_records: scanned.scannedRecords,
    scan_limit: scanLimit,
    scan_truncated: scanned.scanTruncated,
    unique_display_names: uniqueDisplayNames.size,
    unique_browser_installations: uniqueBrowserInstallations.size,
    unique_user_ids: uniqueUserIds.size,
    unique_user_emails: uniqueUserEmails.size,
    status_counts: statusCounts,
    permission_counts: permissionCounts,
    source_counts: sourceCounts,
    persistent_counts: persistentCounts,
    display_name_initial_counts: displayNameInitialCounts,
    ...(input.bucket ? { date_buckets: dateBuckets } : {})
  };
}

async function findBrowserSubscriptionByInstallationId(browserInstallationId: string): Promise<BrowserPushSubscriptionRecord | null> {
  const params = new URLSearchParams();
  params.set("fields", "id,browser_installation_id,endpoint_hash,status,user_id,permission,fallback_channels_json,last_seen_at,date_created,date_updated,metadata_json");
  params.set("filter[browser_installation_id][_eq]", browserInstallationId);
  params.set("sort", "-last_seen_at,-date_updated,-date_created");
  params.set("limit", "25");
  addDirectusReadCacheBust(params);
  const response = await directusJson<DirectusListResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}?${params.toString()}`
  );
  return preferredBrowserSubscriptionRecord(response.data ?? []);
}

async function findBrowserSubscriptionAfterEndpointConflict(
  endpointHash: string,
  browserInstallationId?: string
): Promise<BrowserPushSubscriptionRecord | null> {
  const delays = [0, 100, 250, 500, 1000];
  for (const delay of delays) {
    if (delay > 0) {
      await wait(delay);
    }

    const byEndpoint = await findBrowserSubscriptionByEndpointHash(endpointHash);
    if (byEndpoint?.id) {
      return byEndpoint;
    }

    if (browserInstallationId) {
      const byInstallation = await findBrowserSubscriptionByInstallationId(browserInstallationId);
      if (byInstallation?.id && byInstallation.endpoint_hash === endpointHash) {
        return byInstallation;
      }
    }
  }
  return null;
}

export async function upsertBrowserPushSubscription(input: BrowserPushSubscriptionInput): Promise<BrowserPushSubscriptionRecord> {
  return withBrowserSubscriptionUpsertLock(
    browserSubscriptionUpsertLockKeys(input),
    () => upsertBrowserPushSubscriptionUnlocked(input)
  );
}

async function upsertBrowserPushSubscriptionUnlocked(input: BrowserPushSubscriptionInput): Promise<BrowserPushSubscriptionRecord> {
  const now = new Date().toISOString();
  const subscription = input.subscription;
  const disabledByUser =
    input.capabilities.disabled_by_user === true ||
    asString(input.capabilities.registration_status) === "disabled" ||
    asString(input.capabilities.reason) === "disabled_by_user";
  if (!subscription?.endpoint) {
    if (!input.browser_installation_id) {
      return {
        id: "",
        browser_installation_id: null,
        status: disabledByUser ? "disabled" : input.permission === "granted" && input.supported ? "missing_subscription" : "fallback",
        permission: input.permission,
        fallback_channels_json: input.fallback_channels
      };
    }

    const existingById = input.browser_subscription_id
      ? await findBrowserSubscriptionById(input.browser_subscription_id)
      : null;
    assertBrowserSubscriptionMatchesInstallation(existingById, input);
    const existing = existingById ?? await findBrowserSubscriptionByInstallationId(input.browser_installation_id);
    assertBrowserSubscriptionCanUpdate(existing, input);
    const commonPayload = {
      source: input.source,
      browser_installation_id: input.browser_installation_id,
      user_id: input.user_id || null,
      user_email: input.user_email || null,
      user_phone: input.user_phone || null,
      ...browserSubscriptionRelationPayload(input, existing),
      permission: input.permission,
      capabilities_json: redactJsonRecord(input.capabilities),
      fallback_channels_json: input.fallback_channels,
      user_agent: input.user_agent || asString(input.capabilities.user_agent) || null,
      metadata_json: browserSubscriptionMetadata(input, existing),
      last_seen_at: now
    };
    const preserveActiveEndpoint = Boolean(existing?.endpoint_hash) && !disabledByUser && input.permission === "granted" && input.supported;
    if (existing?.endpoint_hash && !preserveActiveEndpoint && !browserSubscriptionProofMatches(existing, input.browser_subscription_client_secret)) {
      throw Object.assign(new Error("Browser subscription ownership proof is required."), { status: 403 });
    }
    const payload = preserveActiveEndpoint
      ? {
          ...commonPayload,
          status: "active"
        }
      : {
          ...commonPayload,
          endpoint: null,
          endpoint_hash: null,
          expiration_time: null,
          p256dh: null,
          auth: null,
          status: disabledByUser ? "disabled" : input.permission === "granted" && input.supported ? "missing_subscription" : "fallback"
        };

    if (existing?.id) {
      const patched = await patchBrowserSubscription(existing.id, payload);
      const result = patched ?? { ...existing, ...payload };
      await supersedeOtherBrowserSubscriptions(result);
      return result;
    }

    const response = await directusJson<DirectusItemResponse<BrowserPushSubscriptionRecord>>(
      `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}`,
      {
        method: "POST",
        body: {
          id: randomUUID(),
          ...payload,
          date_created: now
        }
      }
    );
    if (!response.data?.id) {
      throw new Error("Directus did not return a browser capability record id.");
    }
    await supersedeOtherBrowserSubscriptions(response.data);
    return response.data;
  }

  const endpointHash = sha256(subscription.endpoint);
  const byId = input.browser_subscription_id
    ? await findBrowserSubscriptionById(input.browser_subscription_id)
    : null;
  assertBrowserSubscriptionMatchesInstallation(byId, input);
  assertBrowserSubscriptionCanUpdate(byId, input);
  const byEndpoint = byId ? null : await findBrowserSubscriptionByEndpointHash(endpointHash);
  assertBrowserSubscriptionCanUpdate(byEndpoint, input);
  const byInstallation = !byId && !byEndpoint && input.browser_installation_id
    ? await findBrowserSubscriptionByInstallationId(input.browser_installation_id)
    : null;
  const existing = byId ?? byEndpoint ??
    (browserSubscriptionProofMatches(byInstallation, input.browser_subscription_client_secret) ? byInstallation : null);
  const payload = {
    source: input.source,
    browser_installation_id: input.browser_installation_id || null,
    endpoint: subscription.endpoint,
    endpoint_hash: endpointHash,
    expiration_time: typeof subscription.expirationTime === "number" && Number.isFinite(subscription.expirationTime)
      ? new Date(subscription.expirationTime).toISOString()
      : null,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    user_id: input.user_id || null,
    user_email: input.user_email || null,
    user_phone: input.user_phone || null,
    ...browserSubscriptionRelationPayload(input, existing),
    permission: input.permission,
    capabilities_json: redactJsonRecord(input.capabilities),
    fallback_channels_json: input.fallback_channels,
    user_agent: input.user_agent || asString(input.capabilities.user_agent) || null,
    metadata_json: browserSubscriptionMetadata(input, existing),
    status: input.permission === "granted" ? "active" : "disabled",
    last_seen_at: now
  };

  if (existing?.id) {
    const patched = await patchBrowserSubscription(existing.id, payload);
    const result = patched ?? { ...existing, ...payload };
    await supersedeOtherBrowserSubscriptions(result);
    return result;
  }

  try {
    const response = await directusJson<DirectusItemResponse<BrowserPushSubscriptionRecord>>(
      `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}`,
      {
        method: "POST",
        body: {
          id: randomUUID(),
          ...payload,
          date_created: now
        }
      }
    );
    if (!response.data?.id) {
      throw new Error("Directus did not return a browser push subscription id.");
    }
    await supersedeOtherBrowserSubscriptions(response.data);
    return response.data;
  } catch (error) {
    if (isEndpointHashUniqueError(error)) {
      const raced = await findBrowserSubscriptionAfterEndpointConflict(endpointHash, input.browser_installation_id);
      if (raced?.id) {
        assertBrowserSubscriptionCanUpdate(raced, input);
        const patched = await patchBrowserSubscription(raced.id, payload);
        const result = patched ?? { ...raced, ...payload };
        await supersedeOtherBrowserSubscriptions(result);
        return result;
      }
      throw Object.assign(
        new Error("Browser push subscription endpoint is already registered. Reset the browser push subscription and try again."),
        { status: 409 }
      );
    }
    throw error;
  }
}

type BrowserSubscriptionCleanupSummary = {
  expired: number;
  stale: number;
  superseded: number;
  dry_run: boolean;
  stale_days: number;
  limit: number;
};

async function listExpiredBrowserSubscriptions(now: string, limit: number): Promise<BrowserPushSubscriptionRecord[]> {
  const params = new URLSearchParams();
  params.set("fields", "id,status,expiration_time,last_seen_at,browser_installation_id,endpoint_hash,capabilities_json,metadata_json");
  params.set("filter[status][_eq]", "active");
  params.set("filter[expiration_time][_lte]", now);
  params.set("sort", "expiration_time,last_seen_at,date_created");
  params.set("limit", String(limit));
  const response = await directusJson<DirectusListResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}?${params.toString()}`
  );
  return response.data ?? [];
}

async function listStaleBrowserSubscriptions(cutoff: string, limit: number): Promise<BrowserPushSubscriptionRecord[]> {
  const params = new URLSearchParams();
  params.set("fields", "id,status,expiration_time,last_seen_at,browser_installation_id,endpoint_hash,capabilities_json,metadata_json");
  params.set("filter[status][_eq]", "active");
  params.set("filter[last_seen_at][_lte]", cutoff);
  params.set("sort", "last_seen_at,date_created");
  params.set("limit", String(limit));
  const response = await directusJson<DirectusListResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}?${params.toString()}`
  );
  return response.data ?? [];
}

function isCurrentBrowserSubscriptionState(record: BrowserPushSubscriptionRecord): boolean {
  const status = asString(record.status).toLowerCase();
  return status === "active"
    || status === "fallback"
    || status === "missing_subscription"
    || status === "disabled"
    || status === "inactive";
}

async function listBrowserSubscriptionsForDedupe(limit: number): Promise<BrowserPushSubscriptionRecord[]> {
  const params = new URLSearchParams();
  params.set("fields", "id,status,browser_installation_id,endpoint_hash,last_seen_at,date_created,date_updated,capabilities_json,metadata_json");
  params.set("sort", "browser_installation_id,-last_seen_at,-date_updated,-date_created");
  params.set("limit", String(limit));
  const response = await directusJson<DirectusListResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}?${params.toString()}`
  );
  return (response.data ?? []).filter(isCurrentBrowserSubscriptionState);
}

async function listBrowserSubscriptionsForInstallation(
  browserInstallationId: string,
  limit = 100
): Promise<BrowserPushSubscriptionRecord[]> {
  const params = new URLSearchParams();
  params.set("fields", "id,status,browser_installation_id,endpoint_hash,last_seen_at,date_created,date_updated,capabilities_json,metadata_json");
  params.set("filter[browser_installation_id][_eq]", browserInstallationId);
  params.set("sort", "-last_seen_at,-date_updated,-date_created");
  params.set("limit", String(Math.max(1, Math.min(500, Math.floor(limit)))));
  addDirectusReadCacheBust(params);
  const response = await directusJson<DirectusListResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}?${params.toString()}`
  );
  return (response.data ?? []).filter(isCurrentBrowserSubscriptionState);
}

async function supersedeOtherBrowserSubscriptions(current: BrowserPushSubscriptionRecord): Promise<void> {
  const browserInstallationId = asString(current.browser_installation_id);
  if (!current.id || !browserInstallationId) {
    return;
  }

  const duplicates = (await listBrowserSubscriptionsForInstallation(browserInstallationId))
    .filter((record) => record.id && record.id !== current.id);
  await markLifecycleRows(duplicates, {
    status: "superseded",
    reason: "browser_installation_id_replaced",
    message: "A newer browser subscription state replaced this browser installation record."
  }, false);
}

function newerBrowserSubscription(left: BrowserPushSubscriptionRecord, right: BrowserPushSubscriptionRecord): BrowserPushSubscriptionRecord {
  const leftRank = browserSubscriptionRank(left);
  const rightRank = browserSubscriptionRank(right);
  if (leftRank !== rightRank) {
    return leftRank > rightRank ? left : right;
  }

  const leftTime = Date.parse(left.last_seen_at || left.date_updated || left.date_created || "");
  const rightTime = Date.parse(right.last_seen_at || right.date_updated || right.date_created || "");
  return (Number.isFinite(leftTime) ? leftTime : 0) >= (Number.isFinite(rightTime) ? rightTime : 0)
    ? left
    : right;
}

function supersededBrowserSubscriptions(records: BrowserPushSubscriptionRecord[]): BrowserPushSubscriptionRecord[] {
  const latestByInstallation = new Map<string, BrowserPushSubscriptionRecord>();
  for (const record of records.filter(isCurrentBrowserSubscriptionState)) {
    const installationId = asString(record.browser_installation_id);
    if (!installationId || !record.id) {
      continue;
    }
    const existing = latestByInstallation.get(installationId);
    latestByInstallation.set(installationId, existing ? newerBrowserSubscription(existing, record) : record);
  }

  return records.filter((record) => {
    if (!isCurrentBrowserSubscriptionState(record)) {
      return false;
    }
    const installationId = asString(record.browser_installation_id);
    const latest = installationId ? latestByInstallation.get(installationId) : null;
    return Boolean(latest?.id && record.id && latest.id !== record.id);
  });
}

function browserSubscriptionNotificationLink(record: BrowserPushSubscriptionRecord): JsonRecord | null {
  const metadata = asRecord(record.metadata_json);
  const capabilities = asRecord(record.capabilities_json);
  return asRecord(metadata?.notification_link) ?? asRecord(capabilities?.notification_link);
}

function isPersistentBrowserSubscription(record: BrowserPushSubscriptionRecord): boolean {
  return browserSubscriptionNotificationLink(record)?.persistent === true;
}

async function markLifecycleRows(
  records: BrowserPushSubscriptionRecord[],
  input: BrowserPushSubscriptionLifecyclePatchInput,
  dryRun: boolean
): Promise<number> {
  if (dryRun) {
    return records.length;
  }
  let count = 0;
  for (const record of records) {
    if (!record.id) {
      continue;
    }
    await patchBrowserPushSubscriptionLifecycle(record.id, input);
    count += 1;
  }
  return count;
}

export async function cleanupBrowserPushSubscriptions(input: BrowserPushSubscriptionCleanupInput = {}): Promise<BrowserSubscriptionCleanupSummary> {
  const now = new Date();
  const nowIso = now.toISOString();
  const staleDays = Math.max(1, Math.floor(input.stale_days ?? config.browserSubscriptionStaleDays));
  const limit = Math.max(1, Math.min(5000, Math.floor(input.limit ?? config.browserSubscriptionCleanupLimit)));
  const dryRun = input.dry_run === true;
  const cutoff = new Date(now.getTime() - staleDays * 24 * 60 * 60 * 1000).toISOString();

  const expiredRecords = (await listExpiredBrowserSubscriptions(nowIso, limit))
    .filter((record) => !isPersistentBrowserSubscription(record));
  const expiredIds = new Set(expiredRecords.map((record) => record.id));
  const expired = await markLifecycleRows(expiredRecords, {
    status: "expired",
    reason: "expiration_time_elapsed",
    message: `Browser push subscription expiration_time is before ${nowIso}`
  }, dryRun);

  const staleRecords = (await listStaleBrowserSubscriptions(cutoff, limit))
    .filter((record) => !expiredIds.has(record.id) && !isPersistentBrowserSubscription(record));
  const stale = await markLifecycleRows(staleRecords, {
    status: "stale",
    reason: "last_seen_at_stale",
    message: `Browser push subscription last_seen_at is older than ${staleDays} days`
  }, dryRun);

  const dedupeRecords = supersededBrowserSubscriptions(await listBrowserSubscriptionsForDedupe(limit))
    .filter((record) => !expiredIds.has(record.id));
  const superseded = await markLifecycleRows(dedupeRecords, {
    status: "superseded",
    reason: "browser_installation_id_duplicate",
    message: "A newer browser subscription state exists for the same browser installation."
  }, dryRun);

  return {
    expired,
    stale,
    superseded,
    dry_run: dryRun,
    stale_days: staleDays,
    limit
  };
}
