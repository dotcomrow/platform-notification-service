import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { DirectusItemResponse, DirectusListResponse, directusJson, queryString } from "../lib/directus.js";
import { asRecord, asString, JsonRecord, redactJsonRecord, truncate } from "../lib/json.js";
import {
  NotificationContext,
  NotificationDeliveryAttemptInput,
  NotificationRecipientHint,
  NotificationRequestInput,
  NotificationRequestRecord,
  NotificationStatus,
  BrowserPushSubscriptionCleanupInput,
  BrowserPushSubscriptionInput,
  BrowserPushSubscriptionLifecyclePatchInput,
  BrowserPushSubscriptionRecord,
  BrowserPushSubscriptionSearchInput,
  BrowserPushSubscriptionSearchResult,
  PlatformApp,
  PlatformOrganization
} from "./types.js";

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
    input: await resolveBrowserPushRecipients(normalizedInput),
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
        template_key: input.template_key || null,
        locale: input.locale || null,
        subject_hint: input.subject || null,
        body_hint: input.body || null,
        requested_channels_json: input.channels,
        recipients_json: input.recipients,
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
    "template_key",
    "locale",
    "requested_channels_json",
    "recipients_json",
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
  if (field === "name") {
    return [displayName];
  }
  return [
    record.id,
    asString(record.browser_installation_id),
    asString(record.user_id),
    asString(record.user_email),
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
      return patched ?? { ...existing, ...payload };
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
    await supersedeOtherActiveBrowserSubscriptions(result);
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
    await supersedeOtherActiveBrowserSubscriptions(response.data);
    return response.data;
  } catch (error) {
    if (isEndpointHashUniqueError(error)) {
      const raced = await findBrowserSubscriptionAfterEndpointConflict(endpointHash, input.browser_installation_id);
      if (raced?.id) {
        assertBrowserSubscriptionCanUpdate(raced, input);
        const patched = await patchBrowserSubscription(raced.id, payload);
        const result = patched ?? { ...raced, ...payload };
        await supersedeOtherActiveBrowserSubscriptions(result);
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

async function listActiveBrowserSubscriptionsForDedupe(limit: number): Promise<BrowserPushSubscriptionRecord[]> {
  const params = new URLSearchParams();
  params.set("fields", "id,status,browser_installation_id,endpoint_hash,last_seen_at,date_created,date_updated,capabilities_json,metadata_json");
  params.set("filter[status][_eq]", "active");
  params.set("sort", "browser_installation_id,-last_seen_at,-date_updated,-date_created");
  params.set("limit", String(limit));
  const response = await directusJson<DirectusListResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}?${params.toString()}`
  );
  return response.data ?? [];
}

async function listActiveBrowserSubscriptionsForInstallation(
  browserInstallationId: string,
  limit = 100
): Promise<BrowserPushSubscriptionRecord[]> {
  const params = new URLSearchParams();
  params.set("fields", "id,status,browser_installation_id,endpoint_hash,last_seen_at,date_created,date_updated,capabilities_json,metadata_json");
  params.set("filter[status][_eq]", "active");
  params.set("filter[browser_installation_id][_eq]", browserInstallationId);
  params.set("sort", "-last_seen_at,-date_updated,-date_created");
  params.set("limit", String(Math.max(1, Math.min(500, Math.floor(limit)))));
  addDirectusReadCacheBust(params);
  const response = await directusJson<DirectusListResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}?${params.toString()}`
  );
  return response.data ?? [];
}

async function supersedeOtherActiveBrowserSubscriptions(current: BrowserPushSubscriptionRecord): Promise<void> {
  const browserInstallationId = asString(current.browser_installation_id);
  if (!current.id || !browserInstallationId) {
    return;
  }

  const duplicates = (await listActiveBrowserSubscriptionsForInstallation(browserInstallationId))
    .filter((record) => record.id && record.id !== current.id);
  await markLifecycleRows(duplicates, {
    status: "superseded",
    reason: "browser_installation_id_replaced",
    message: "A newer active browser push subscription replaced this browser installation endpoint."
  }, false);
}

function newerBrowserSubscription(left: BrowserPushSubscriptionRecord, right: BrowserPushSubscriptionRecord): BrowserPushSubscriptionRecord {
  const leftTime = Date.parse(left.last_seen_at || left.date_updated || left.date_created || "");
  const rightTime = Date.parse(right.last_seen_at || right.date_updated || right.date_created || "");
  return (Number.isFinite(leftTime) ? leftTime : 0) >= (Number.isFinite(rightTime) ? rightTime : 0)
    ? left
    : right;
}

function supersededBrowserSubscriptions(records: BrowserPushSubscriptionRecord[]): BrowserPushSubscriptionRecord[] {
  const latestByInstallation = new Map<string, BrowserPushSubscriptionRecord>();
  for (const record of records) {
    const installationId = asString(record.browser_installation_id);
    if (!installationId || !record.id) {
      continue;
    }
    const existing = latestByInstallation.get(installationId);
    latestByInstallation.set(installationId, existing ? newerBrowserSubscription(existing, record) : record);
  }

  return records.filter((record) => {
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

  const dedupeRecords = supersededBrowserSubscriptions(await listActiveBrowserSubscriptionsForDedupe(limit))
    .filter((record) => !expiredIds.has(record.id));
  const superseded = await markLifecycleRows(dedupeRecords, {
    status: "superseded",
    reason: "browser_installation_id_duplicate",
    message: "A newer active browser push subscription exists for the same browser installation."
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
