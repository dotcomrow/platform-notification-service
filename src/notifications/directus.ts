import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";
import { DirectusItemResponse, DirectusListResponse, directusJson, queryString } from "../lib/directus.js";
import { asRecord, asString, JsonRecord, redactJsonRecord, truncate } from "../lib/json.js";
import {
  NotificationContext,
  NotificationDeliveryAttemptInput,
  NotificationRequestInput,
  NotificationRequestRecord,
  NotificationStatus,
  BrowserPushSubscriptionInput,
  BrowserPushSubscriptionRecord,
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

  return {
    input: {
      ...input,
      organization_id: organizationId || input.organization_id
    },
    context
  };
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
  params.set("fields", "id,browser_installation_id,endpoint_hash,status,user_id,organization_id,app_id,permission,fallback_channels_json,last_seen_at,date_created,date_updated");
  params.set("filter[endpoint_hash][_eq]", endpointHash);
  params.set("sort", "-last_seen_at,-date_updated,-date_created");
  params.set("limit", "1");
  const response = await directusJson<DirectusListResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}?${params.toString()}`
  );
  return response.data?.[0] ?? null;
}

async function findBrowserSubscriptionByInstallationId(browserInstallationId: string): Promise<BrowserPushSubscriptionRecord | null> {
  const params = new URLSearchParams();
  params.set("fields", "id,browser_installation_id,endpoint_hash,status,user_id,organization_id,app_id,permission,fallback_channels_json,last_seen_at,date_created,date_updated");
  params.set("filter[browser_installation_id][_eq]", browserInstallationId);
  params.set("sort", "-last_seen_at,-date_updated,-date_created");
  params.set("limit", "1");
  const response = await directusJson<DirectusListResponse<BrowserPushSubscriptionRecord>>(
    `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}?${params.toString()}`
  );
  return response.data?.[0] ?? null;
}

export async function upsertBrowserPushSubscription(input: BrowserPushSubscriptionInput): Promise<BrowserPushSubscriptionRecord> {
  const now = new Date().toISOString();
  const subscription = input.subscription;
  if (!subscription?.endpoint) {
    if (!input.browser_installation_id) {
      return {
        id: "",
        browser_installation_id: null,
        status: input.permission === "granted" && input.supported ? "missing_subscription" : "fallback",
        permission: input.permission,
        fallback_channels_json: input.fallback_channels
      };
    }

    const existing = await findBrowserSubscriptionByInstallationId(input.browser_installation_id);
    const payload = {
      source: input.source,
      browser_installation_id: input.browser_installation_id,
      endpoint: null,
      endpoint_hash: null,
      expiration_time: null,
      p256dh: null,
      auth: null,
      user_id: input.user_id || null,
      user_email: input.user_email || null,
      user_phone: input.user_phone || null,
      organization_id: input.organization_id || null,
      app_id: input.app_id || null,
      permission: input.permission,
      capabilities_json: redactJsonRecord(input.capabilities),
      fallback_channels_json: input.fallback_channels,
      user_agent: input.user_agent || asString(input.capabilities.user_agent) || null,
      metadata_json: {},
      status: input.permission === "granted" && input.supported ? "missing_subscription" : "fallback",
      last_seen_at: now
    };

    if (existing?.id) {
      const response = await directusJson<DirectusItemResponse<BrowserPushSubscriptionRecord>>(
        `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}/${encodeURIComponent(existing.id)}`,
        {
          method: "PATCH",
          body: payload
        }
      );
      return response.data?.id ? response.data : { ...existing, ...payload };
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
  const existing = await findBrowserSubscriptionByEndpointHash(endpointHash);
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
    organization_id: input.organization_id || null,
    app_id: input.app_id || null,
    permission: input.permission,
    capabilities_json: redactJsonRecord(input.capabilities),
    fallback_channels_json: input.fallback_channels,
    user_agent: input.user_agent || asString(input.capabilities.user_agent) || null,
    metadata_json: {},
    status: input.permission === "granted" ? "active" : "disabled",
    last_seen_at: now
  };

  if (existing?.id) {
    const response = await directusJson<DirectusItemResponse<BrowserPushSubscriptionRecord>>(
      `/items/${encodeURIComponent(config.notificationBrowserSubscriptionCollection)}/${encodeURIComponent(existing.id)}`,
      {
        method: "PATCH",
        body: payload
      }
    );
    return response.data?.id ? response.data : { ...existing, ...payload };
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
    throw new Error("Directus did not return a browser push subscription id.");
  }
  return response.data;
}
