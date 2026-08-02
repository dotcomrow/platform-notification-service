import { JsonRecord } from "../lib/json.js";

export type NotificationSeverity = "debug" | "info" | "success" | "warning" | "error" | "critical";
export type NotificationPriority = "low" | "normal" | "high" | "urgent";
export type NotificationStatus = "queued" | "processing" | "sent" | "partially_sent" | "failed" | "canceled";
export type NotificationChannel = "in_app" | "browser_push" | "mobile_push" | "email" | "sms" | "voice" | "webhook";

export type NotificationRecipientHint = {
  type: "user" | "role" | "group" | "organization" | "app" | "browser_subscription" | "email" | "phone" | "topic" | "webhook";
  id?: string;
  address?: string;
  display_name?: string;
  locale?: string;
  channels?: NotificationChannel[];
  data?: JsonRecord;
};

export type NotificationRequestInput = {
  event_key: string;
  source: string;
  severity: NotificationSeverity;
  priority: NotificationPriority;
  organization_id?: string;
  app_id?: string;
  actor_user_id?: string;
  template_key?: string;
  locale?: string;
  channels: NotificationChannel[];
  recipients: NotificationRecipientHint[];
  subject?: string;
  body?: string;
  data: JsonRecord;
  metadata: JsonRecord;
  dedupe_key?: string;
  idempotency_key?: string;
  correlation_id: string;
  scheduled_for?: string;
  expires_at?: string;
};

export type PlatformOrganization = {
  id: string;
  organization_key?: string | null;
  name?: string | null;
  status?: string | null;
  default_domain?: string | null;
  default_keycloak_realm?: string | null;
};

export type PlatformApp = {
  id: string;
  organization_id?: string | PlatformOrganization | null;
  app_key?: string | null;
  display_name?: string | null;
  site_key?: string | null;
  keycloak_realm?: string | null;
  production_url?: string | null;
  preview_url?: string | null;
  deployment_status?: string | null;
};

export type NotificationContext = {
  organization?: PlatformOrganization;
  app?: PlatformApp;
};

export type NotificationRequestRecord = {
  id: string;
  event_key: string;
  source: string;
  severity: NotificationSeverity | string;
  priority: NotificationPriority | string;
  status: NotificationStatus | string;
  correlation_id?: string | null;
  idempotency_key?: string | null;
  organization_id?: string | PlatformOrganization | null;
  app_id?: string | PlatformApp | null;
  actor_user_id?: string | null;
  template_key?: string | null;
  locale?: string | null;
  requested_channels_json?: NotificationChannel[] | null;
  recipients_json?: NotificationRecipientHint[] | null;
  data_json?: JsonRecord | null;
  context_json?: NotificationContext | null;
  metadata_json?: JsonRecord | null;
  queue_topic?: string | null;
  requested_at?: string | null;
  queued_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  last_message?: string | null;
  error_message?: string | null;
};

export type NotificationDeliveryAttemptInput = {
  channel: NotificationChannel;
  provider_key?: string;
  recipient_json: JsonRecord;
  message_json?: JsonRecord;
  status: "queued" | "sending" | "sent" | "failed" | "skipped";
  provider_message_id?: string;
  request_payload_json?: JsonRecord;
  response_json?: JsonRecord;
  error_message?: string;
};

export type BrowserNotificationFallbackChannel = "email" | "sms";

export type BrowserPushSubscriptionInput = {
  source: string;
  browser_installation_id?: string;
  user_id?: string;
  user_email?: string;
  user_phone?: string;
  user_agent?: string;
  organization_id?: string;
  app_id?: string;
  permission: "granted" | "denied" | "default" | "unsupported";
  supported: boolean;
  fallback_channels: BrowserNotificationFallbackChannel[];
  capabilities: JsonRecord;
  subscription?: {
    endpoint: string;
    expirationTime?: number | null;
    keys: {
      p256dh: string;
      auth: string;
    };
  };
};

export type BrowserPushSubscriptionRecord = {
  id: string;
  source?: string | null;
  browser_installation_id?: string | null;
  endpoint?: string | null;
  endpoint_hash?: string | null;
  expiration_time?: string | null;
  p256dh?: string | null;
  auth?: string | null;
  user_id?: string | null;
  user_email?: string | null;
  user_phone?: string | null;
  organization_id?: string | PlatformOrganization | null;
  app_id?: string | PlatformApp | null;
  status?: string | null;
  permission?: "granted" | "denied" | "default" | "unsupported" | null;
  capabilities_json?: JsonRecord | null;
  fallback_channels_json?: BrowserNotificationFallbackChannel[] | null;
  user_agent?: string | null;
  metadata_json?: JsonRecord | null;
  last_seen_at?: string | null;
  date_created?: string | null;
  date_updated?: string | null;
};
