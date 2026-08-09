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
  notification_key?: string;
  template_key?: string;
  locale?: string;
  channels: NotificationChannel[];
  recipients: NotificationRecipientHint[];
  subject?: string;
  body?: string;
  parameters: JsonRecord;
  message?: RenderedNotificationMessage;
  data: JsonRecord;
  metadata: JsonRecord;
  dedupe_key?: string;
  idempotency_key?: string;
  correlation_id: string;
  scheduled_for?: string;
  expires_at?: string;
};

export type NotificationTemplateRecord = {
  id: string;
  notification_key?: string | null;
  name?: string | null;
  description?: string | null;
  status?: string | null;
  locale?: string | null;
  channels_json?: NotificationChannel[] | null;
  required_parameters_json?: JsonRecord | unknown[] | null;
  sample_parameters_json?: JsonRecord | null;
  subject_template?: string | null;
  title_template?: string | null;
  body_template?: string | null;
  text_template?: string | null;
  html_template?: string | null;
  data_template_json?: JsonRecord | null;
  options_template_json?: JsonRecord | null;
  assets_json?: unknown[] | JsonRecord | null;
  stylesheets_json?: unknown[] | JsonRecord | null;
  metadata_json?: JsonRecord | null;
  date_created?: string | null;
  date_updated?: string | null;
};

export type RenderedNotificationMessage = {
  notification_key?: string;
  template_key?: string;
  template_id?: string;
  locale?: string;
  subject?: string;
  title?: string;
  body?: string;
  text?: string;
  html?: string;
  data: JsonRecord;
  options: JsonRecord;
  parameters: JsonRecord;
  assets?: unknown[] | JsonRecord | null;
  stylesheets?: unknown[] | JsonRecord | null;
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
  domain?: string | null;
  production_hostname?: string | null;
  preview_hostname?: string | null;
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
  notification_key?: string | null;
  template_key?: string | null;
  locale?: string | null;
  requested_channels_json?: NotificationChannel[] | null;
  recipients_json?: NotificationRecipientHint[] | null;
  template_parameters_json?: JsonRecord | null;
  rendered_message_json?: RenderedNotificationMessage | JsonRecord | null;
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

export type NotificationDeliveryAttemptRecord = NotificationDeliveryAttemptInput & {
  id: string;
  notification_request_id?: string | NotificationRequestRecord | null;
  attempted_at?: string | null;
  finished_at?: string | null;
  date_created?: string | null;
  date_updated?: string | null;
};

export type BrowserNotificationFallbackChannel = "email" | "sms";

export type BrowserPushSubscriptionInput = {
  source: string;
  browser_subscription_id?: string;
  browser_installation_id?: string;
  browser_subscription_client_secret?: string;
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
  metadata?: JsonRecord;
  subscription?: {
    endpoint: string;
    expirationTime?: number | null;
    keys: {
      p256dh: string;
      auth: string;
    };
  };
};

export type BrowserPushSubscriptionSearchField = "all" | "id" | "user_id" | "email" | "name";

export type BrowserPushSubscriptionSearchInput = {
  query?: string;
  field?: BrowserPushSubscriptionSearchField;
  organization_id: string;
  app_id: string;
  status?: string;
  limit?: number;
};

export type BrowserPushSubscriptionSearchResult = {
  id: string;
  browser_installation_id?: string | null;
  user_id?: string | null;
  user_email?: string | null;
  display_name?: string | null;
  organization_id?: string | null;
  app_id?: string | null;
  status?: string | null;
  permission?: string | null;
  last_seen_at?: string | null;
  date_created?: string | null;
  date_updated?: string | null;
};

export type BrowserPushSubscriptionBrowseField =
  | BrowserPushSubscriptionSearchField
  | "browser_installation_id"
  | "source";

export type BrowserPushSubscriptionDateField =
  | "last_seen_at"
  | "date_created"
  | "date_updated"
  | "expiration_time";

export type BrowserPushSubscriptionBrowseSort =
  | "last_seen_at_desc"
  | "last_seen_at_asc"
  | "created_desc"
  | "created_asc"
  | "updated_desc"
  | "updated_asc";

export type BrowserPushSubscriptionStatsBucket = "hour" | "day" | "week";

export type BrowserPushSubscriptionBrowseInput = {
  query?: string;
  field?: BrowserPushSubscriptionBrowseField;
  name_prefix?: string;
  organization_id?: string;
  app_id?: string;
  source?: string;
  browser_installation_id?: string;
  status?: string;
  statuses?: string[];
  permission?: string;
  persistent?: boolean;
  has_endpoint?: boolean;
  date_field?: BrowserPushSubscriptionDateField;
  date_start?: string;
  date_end?: string;
  sort?: BrowserPushSubscriptionBrowseSort;
  limit?: number;
  offset?: number;
  scan_limit?: number;
};

export type BrowserPushSubscriptionStatsInput = Omit<
  BrowserPushSubscriptionBrowseInput,
  "limit" | "offset" | "sort"
> & {
  bucket?: BrowserPushSubscriptionStatsBucket;
};

export type BrowserPushSubscriptionBrowseResult = BrowserPushSubscriptionSearchResult & {
  source?: string | null;
  user_agent?: string | null;
  has_endpoint: boolean;
  endpoint_hash_prefix?: string | null;
  expiration_time?: string | null;
  fallback_channels?: BrowserNotificationFallbackChannel[] | null;
  persistent?: boolean | null;
  notification_link?: JsonRecord | null;
  capability_reason?: string | null;
  registration_status?: string | null;
  fallback_required?: boolean | null;
  disabled_by_user?: boolean | null;
};

export type BrowserPushSubscriptionStats = {
  total_records: number;
  matching_records: number;
  matching_records_exact: boolean;
  scanned_records: number;
  scan_limit: number;
  scan_truncated: boolean;
  unique_display_names: number;
  unique_browser_installations: number;
  unique_user_ids: number;
  unique_user_emails: number;
  status_counts: Record<string, number>;
  permission_counts: Record<string, number>;
  source_counts: Record<string, number>;
  persistent_counts: {
    persistent: number;
    non_persistent: number;
    unknown: number;
  };
  display_name_initial_counts: Record<string, number>;
  date_buckets?: Record<string, number>;
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

export type BrowserPushSubscriptionLifecycleStatus =
  | "active"
  | "disabled"
  | "expired"
  | "fallback"
  | "inactive"
  | "missing_subscription"
  | "stale"
  | "superseded";

export type BrowserPushSubscriptionLifecyclePatchInput = {
  status: BrowserPushSubscriptionLifecycleStatus;
  reason?: string;
  message?: string;
  provider_status_code?: number;
  metadata?: JsonRecord;
};

export type BrowserPushSubscriptionCleanupInput = {
  stale_days?: number;
  limit?: number;
  dry_run?: boolean;
};
