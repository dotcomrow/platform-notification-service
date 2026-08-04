import { randomUUID } from "node:crypto";
import { z } from "zod";
import { asRecord, JsonRecord } from "../lib/json.js";
import {
  BrowserPushSubscriptionCleanupInput,
  BrowserPushSubscriptionInput,
  BrowserPushSubscriptionLifecyclePatchInput,
  BrowserPushSubscriptionSearchInput,
  NotificationDeliveryAttemptInput,
  NotificationRequestInput
} from "./types.js";

const channelSchema = z.enum(["in_app", "browser_push", "mobile_push", "email", "sms", "voice", "webhook"]);
const severitySchema = z.enum(["debug", "info", "success", "warning", "error", "critical"]).default("info");
const prioritySchema = z.enum(["low", "normal", "high", "urgent"]).default("normal");

const jsonRecordSchema = z.record(z.unknown()).default({});

const recipientHintSchema = z.object({
  type: z.enum(["user", "role", "group", "organization", "app", "browser_subscription", "email", "phone", "topic", "webhook"]),
  id: z.string().trim().min(1).optional(),
  address: z.string().trim().min(1).optional(),
  display_name: z.string().trim().min(1).optional(),
  locale: z.string().trim().min(1).optional(),
  channels: z.array(channelSchema).min(1).optional(),
  data: jsonRecordSchema.optional()
}).superRefine((value, ctx) => {
  if (!value.id && !value.address) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "recipient hints must include id or address"
    });
  }
});

const notificationRequestSchema = z.object({
  event_key: z.string().trim().min(1),
  source: z.string().trim().min(1).default("unknown"),
  severity: severitySchema,
  priority: prioritySchema,
  organization_id: z.string().trim().min(1).optional(),
  app_id: z.string().trim().min(1).optional(),
  actor_user_id: z.string().trim().min(1).optional(),
  template_key: z.string().trim().min(1).optional(),
  locale: z.string().trim().min(1).optional(),
  channels: z.array(channelSchema).default([]),
  recipients: z.array(recipientHintSchema).default([]),
  subject: z.string().trim().min(1).optional(),
  body: z.string().trim().min(1).optional(),
  data: jsonRecordSchema,
  metadata: jsonRecordSchema,
  dedupe_key: z.string().trim().min(1).optional(),
  idempotency_key: z.string().trim().min(1).optional(),
  correlation_id: z.string().trim().min(1).default(() => randomUUID()),
  scheduled_for: z.string().datetime({ offset: true }).optional(),
  expires_at: z.string().datetime({ offset: true }).optional()
}).passthrough();

const statusSchema = z.enum(["queued", "processing", "sent", "partially_sent", "failed", "canceled"]);

export const notificationStatusPatchSchema = z.object({
  status: statusSchema,
  message: z.string().trim().min(1).optional(),
  result_json: jsonRecordSchema.optional(),
  error_message: z.string().trim().optional(),
  started_at: z.string().datetime({ offset: true }).optional(),
  finished_at: z.string().datetime({ offset: true }).optional()
});

export const deliveryAttemptSchema = z.object({
  channel: channelSchema,
  provider_key: z.string().trim().min(1).optional(),
  recipient_json: jsonRecordSchema,
  message_json: jsonRecordSchema.optional(),
  status: z.enum(["queued", "sending", "sent", "failed", "skipped"]),
  provider_message_id: z.string().trim().optional(),
  request_payload_json: jsonRecordSchema.optional(),
  response_json: jsonRecordSchema.optional(),
  error_message: z.string().trim().optional()
});

const pushSubscriptionSchema = z.object({
  endpoint: z.string().trim().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().trim().min(1),
    auth: z.string().trim().min(1)
  })
});

const browserPushSubscriptionSchema = z.object({
  source: z.string().trim().min(1).default("internal-application-mfe"),
  browser_installation_id: z.string().trim().min(1).optional(),
  user_id: z.string().trim().min(1).optional(),
  user_email: z.string().trim().min(1).optional(),
  user_phone: z.string().trim().min(1).optional(),
  user_agent: z.string().trim().min(1).optional(),
  organization_id: z.string().trim().min(1).optional(),
  app_id: z.string().trim().min(1).optional(),
  permission: z.enum(["granted", "denied", "default", "unsupported"]),
  supported: z.boolean(),
  capabilities: jsonRecordSchema,
  metadata: jsonRecordSchema.optional(),
  fallback_channels: z.array(z.enum(["email", "sms"])).default(["email", "sms"]),
  subscription: pushSubscriptionSchema.optional()
}).superRefine((value, ctx) => {
  const capabilityFallbackRequired = value.capabilities.fallback_required === true;
  const capabilityRegistrationStatus = typeof value.capabilities.registration_status === "string"
    ? value.capabilities.registration_status
    : "";
  const isFallbackCapabilityReport =
    capabilityFallbackRequired || capabilityRegistrationStatus === "failed";
  if (
    value.supported &&
    value.permission === "granted" &&
    !value.subscription &&
    !isFallbackCapabilityReport
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "subscription is required when browser push is supported and permission is granted"
    });
  }
});

const browserPushSubscriptionLifecyclePatchSchema = z.object({
  status: z.enum(["active", "disabled", "expired", "fallback", "inactive", "missing_subscription", "stale", "superseded"]),
  reason: z.string().trim().min(1).optional(),
  message: z.string().trim().min(1).optional(),
  provider_status_code: z.number().int().min(100).max(599).optional(),
  metadata: jsonRecordSchema.optional()
});

const browserPushSubscriptionCleanupSchema = z.object({
  stale_days: z.number().int().min(1).max(3650).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  dry_run: z.boolean().optional()
});

const browserPushSubscriptionSearchSchema = z.object({
  query: z.string().trim().max(256).optional(),
  field: z.enum(["all", "id", "user_id", "email", "name"]).default("all"),
  organization_id: z.string().trim().min(1),
  app_id: z.string().trim().min(1),
  status: z.string().trim().min(1).default("active"),
  limit: z.number().int().min(1).max(100).default(25)
});

function unwrapInput(body: unknown): JsonRecord {
  let current = asRecord(body) ?? {};
  for (let depth = 0; depth < 4; depth += 1) {
    const input = asRecord(current.input);
    if (input) {
      current = input;
      continue;
    }
    const nestedBody = asRecord(current.body);
    if (nestedBody) {
      current = nestedBody;
      continue;
    }
    break;
  }
  return current;
}

export function parseNotificationRequest(body: unknown): NotificationRequestInput {
  return notificationRequestSchema.parse(unwrapInput(body)) as NotificationRequestInput;
}

export function parseNotificationStatusPatch(body: unknown): z.infer<typeof notificationStatusPatchSchema> {
  return notificationStatusPatchSchema.parse(unwrapInput(body));
}

export function parseDeliveryAttempt(body: unknown): NotificationDeliveryAttemptInput {
  return deliveryAttemptSchema.parse(unwrapInput(body)) as NotificationDeliveryAttemptInput;
}

export function parseBrowserSubscription(body: unknown): BrowserPushSubscriptionInput {
  return browserPushSubscriptionSchema.parse(unwrapInput(body)) as BrowserPushSubscriptionInput;
}

export function parseBrowserSubscriptionLifecyclePatch(body: unknown): BrowserPushSubscriptionLifecyclePatchInput {
  return browserPushSubscriptionLifecyclePatchSchema.parse(unwrapInput(body)) as BrowserPushSubscriptionLifecyclePatchInput;
}

export function parseBrowserSubscriptionCleanup(body: unknown): BrowserPushSubscriptionCleanupInput {
  return browserPushSubscriptionCleanupSchema.parse(unwrapInput(body)) as BrowserPushSubscriptionCleanupInput;
}

export function parseBrowserSubscriptionSearch(body: unknown): BrowserPushSubscriptionSearchInput {
  return browserPushSubscriptionSearchSchema.parse(unwrapInput(body)) as BrowserPushSubscriptionSearchInput;
}
