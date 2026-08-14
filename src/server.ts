import express, { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import { config } from "./config.js";
import { enforceInternalAuth } from "./auth/internal-auth.js";
import { directusHealth } from "./lib/directus.js";
import { kafkaReady, publishJson } from "./lib/kafka.js";
import { asBoolean, asRecord, asString, JsonRecord, redactJsonRecord, truncate } from "./lib/json.js";
import { vaultValue } from "./lib/vault.js";
import { openApiSpec } from "./openapi.js";
import {
  cleanupBrowserPushSubscriptions,
  createDeliveryAttempt,
  createNotificationRequest,
  browseBrowserPushSubscriptions,
  enrichNotificationRequest,
  findRequestByIdempotencyKey,
  listDeliveryAttemptsForRequest,
  getBrowserPushSubscriptionStats,
  getBrowserPushSubscription,
  getNotificationRequest,
  markRequestQueueFailed,
  markRequestQueued,
  patchBrowserPushSubscriptionLifecycle,
  patchNotificationStatus,
  reconcileNotificationRequests,
  searchBrowserPushSubscriptions,
  upsertBrowserPushSubscription
} from "./notifications/directus.js";
import {
  parseBrowserSubscriptionCleanup,
  parseBrowserSubscriptionBrowse,
  parseBrowserSubscriptionLifecyclePatch,
  parseBrowserSubscriptionSearch,
  parseBrowserSubscriptionStats,
  parseBrowserSubscription,
  parseDeliveryAttempt,
  parseNotificationRequestReconcile,
  parseNotificationRequest,
  parseNotificationStatusPatch
} from "./notifications/validation.js";
import {
  NotificationChannel,
  NotificationDeliveryAttemptRecord,
  NotificationRecipientHint,
  NotificationRequestInput,
  NotificationRequestRecord
} from "./notifications/types.js";

const app = express();
app.set("trust proxy", config.trustProxyHops);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "2mb" }));
app.use(morgan("combined"));
app.use(rateLimit({
  windowMs: config.rateWindowMs,
  limit: config.rateMax,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: (req) =>
    req.path === "/healthz"
    || req.path === "/readyz"
    || req.path === "/openapi.json"
    || req.path.startsWith("/internal/")
}));

function notificationQueuedPayload(recordId: string | null | undefined, duplicate: boolean, status: string, correlationId?: string | null) {
  return {
    ok: true,
    duplicate,
    notification_request_id: recordId || null,
    status,
    correlation_id: correlationId || null,
    queue_topic: config.notificationRequestedTopic
  };
}

type NotificationQueueResult = {
  record_id?: string | null;
  duplicate: boolean;
  status: string;
  correlation_id?: string | null;
};

function isNotificationRequestIdempotencyConflict(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes(config.notificationRequestCollection.toLowerCase())
    && message.includes("idempotency_key")
    && (message.includes("unique") || message.includes("duplicate"));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findRequestByIdempotencyKeyWithRetry(source: string, idempotencyKey: string) {
  const delays = [0, 100, 250, 500, 1000, 2000, 5000];
  for (const delay of delays) {
    if (delay > 0) {
      await wait(delay);
    }
    const existing = await findRequestByIdempotencyKey(source, idempotencyKey);
    if (existing) {
      return existing;
    }
  }
  return null;
}

function duplicateQueueResult(existing: Awaited<ReturnType<typeof findRequestByIdempotencyKey>>): NotificationQueueResult | null {
  if (!existing) {
    return null;
  }
  return {
    record_id: existing.id,
    duplicate: true,
    status: existing.status,
    correlation_id: existing.correlation_id
  };
}

async function queueNotificationInput(parsedInput: NotificationRequestInput): Promise<NotificationQueueResult> {
  if (parsedInput.idempotency_key) {
    const existing = await findRequestByIdempotencyKey(parsedInput.source, parsedInput.idempotency_key);
    const duplicate = duplicateQueueResult(existing);
    if (duplicate) {
      return duplicate;
    }
  }

  const { input, context } = await enrichNotificationRequest(parsedInput);
  if (input.idempotency_key) {
    const existing = await findRequestByIdempotencyKey(input.source, input.idempotency_key);
    const duplicate = duplicateQueueResult(existing);
    if (duplicate) {
      return duplicate;
    }
  }

  let requestRecord;
  try {
    requestRecord = await createNotificationRequest(input, context);
  } catch (error) {
    if (input.idempotency_key && isNotificationRequestIdempotencyConflict(error)) {
      const existing = await findRequestByIdempotencyKeyWithRetry(input.source, input.idempotency_key);
      const duplicate = duplicateQueueResult(existing);
      if (duplicate) {
        return duplicate;
      }
      return {
        record_id: null,
        duplicate: true,
        status: "queued",
        correlation_id: input.correlation_id
      };
    }
    throw error;
  }
  const message = asRecord(input.message) ?? {};
  const eventPayload = {
    schema_version: 1,
    notification_request_id: requestRecord.id,
    event_key: input.event_key,
    source: input.source,
    severity: input.severity,
    priority: input.priority,
    organization_id: input.organization_id || null,
    app_id: input.app_id || null,
    actor_user_id: input.actor_user_id || null,
    notification_key: input.notification_key || input.template_key || null,
    template_key: input.template_key || input.notification_key || null,
    locale: input.locale || null,
    subject: typeof message.subject === "string" ? message.subject : input.subject || null,
    body: typeof message.body === "string" ? message.body : input.body || null,
    message: input.message ? redactJsonRecord(input.message as unknown as JsonRecord) : null,
    channels: input.channels,
    recipients: input.recipients,
    parameters: redactJsonRecord(input.parameters),
    data: redactJsonRecord(input.data),
    metadata: redactJsonRecord(input.metadata),
    context,
    dedupe_key: input.dedupe_key || null,
    idempotency_key: input.idempotency_key || null,
    correlation_id: input.correlation_id,
    scheduled_for: input.scheduled_for || null,
    expires_at: input.expires_at || null,
    requested_at: requestRecord.requested_at || new Date().toISOString()
  };

  try {
    await publishJson(config.notificationRequestedTopic, requestRecord.id, eventPayload);
    await markRequestQueued(requestRecord.id);
  } catch (error) {
    await markRequestQueueFailed(requestRecord.id, error);
    throw error;
  }

  return {
    record_id: requestRecord.id,
    duplicate: false,
    status: "queued",
    correlation_id: input.correlation_id
  };
}

async function queueNotification(req: Request, res: Response): Promise<void> {
  await enforceInternalAuth(req);
  const result = await queueNotificationInput(parseNotificationRequest(req.body));
  res.status(result.duplicate ? 200 : 202).json(
    notificationQueuedPayload(result.record_id, result.duplicate, result.status, result.correlation_id)
  );
}

async function resolveBrowserPushPublicKey(): Promise<string> {
  if (config.browserPushVapidPublicKey.trim()) {
    return config.browserPushVapidPublicKey.trim();
  }
  const publicKey = await vaultValue(config.browserPushVapidVaultPath, config.browserPushVapidPublicKeyVaultKey);
  if (!publicKey) {
    throw Object.assign(new Error("Browser push VAPID public key is not configured."), { status: 503 });
  }
  return publicKey;
}

let browserSubscriptionCleanupRunning = false;

async function runBrowserSubscriptionCleanup(trigger: string): Promise<boolean> {
  if (browserSubscriptionCleanupRunning) {
    console.warn(`[platform-notification-service] browser subscription cleanup skipped; previous run is still active trigger=${trigger}`);
    return false;
  }
  browserSubscriptionCleanupRunning = true;
  try {
    const summary = await cleanupBrowserPushSubscriptions({
      stale_days: config.browserSubscriptionStaleDays,
      limit: config.browserSubscriptionCleanupLimit
    });
    console.log(`[platform-notification-service] browser subscription cleanup trigger=${trigger} expired=${summary.expired} stale=${summary.stale} superseded=${summary.superseded} stale_days=${summary.stale_days} limit=${summary.limit}`);
    return true;
  } catch (error) {
    console.error(`[platform-notification-service] browser subscription cleanup failed trigger=${trigger}: ${error instanceof Error ? truncate(error.message, 1000) : "unknown error"}`);
    return false;
  } finally {
    browserSubscriptionCleanupRunning = false;
  }
}

type StartupRetryOptions = {
  name: string;
  initialDelayMs: number;
  retryIntervalMs: number;
  maxAttempts: number;
  run: (trigger: string) => Promise<boolean>;
};

function scheduleStartupRetry(options: StartupRetryOptions): void {
  let attempt = 0;
  const runAttempt = (): void => {
    attempt += 1;
    const trigger = attempt === 1 ? "startup" : `startup-retry-${attempt}`;
    void options.run(trigger).then((ok) => {
      if (ok) {
        if (attempt > 1) {
          console.log(`[platform-notification-service] ${options.name} startup succeeded after ${attempt} attempts`);
        }
        return;
      }
      if (attempt >= options.maxAttempts) {
        console.error(`[platform-notification-service] ${options.name} startup retries exhausted attempts=${attempt} retry_interval_ms=${options.retryIntervalMs}`);
        return;
      }
      const retryTimer = setTimeout(runAttempt, options.retryIntervalMs);
      retryTimer.unref?.();
    });
  };
  const startupTimer = setTimeout(runAttempt, options.initialDelayMs);
  startupTimer.unref?.();
}

function scheduleBrowserSubscriptionCleanup(): void {
  if (!config.browserSubscriptionCleanupEnabled) {
    console.log("[platform-notification-service] browser subscription cleanup is disabled.");
    return;
  }

  scheduleStartupRetry({
    name: "browser subscription cleanup",
    initialDelayMs: config.browserSubscriptionCleanupStartupDelayMs,
    retryIntervalMs: config.browserSubscriptionCleanupStartupRetryIntervalMs,
    maxAttempts: config.browserSubscriptionCleanupStartupMaxAttempts,
    run: runBrowserSubscriptionCleanup
  });
  const intervalTimer = setInterval(() => {
    void runBrowserSubscriptionCleanup("interval");
  }, config.browserSubscriptionCleanupIntervalMs);
  intervalTimer.unref?.();
}

let notificationRequestReconcileRunning = false;

async function runNotificationRequestReconcile(trigger: string): Promise<boolean> {
  if (notificationRequestReconcileRunning) {
    console.warn(`[platform-notification-service] notification request reconcile skipped; previous run is still active trigger=${trigger}`);
    return false;
  }
  notificationRequestReconcileRunning = true;
  try {
    const summary = await reconcileNotificationRequests({
      queued_timeout_minutes: config.notificationRequestQueuedTimeoutMinutes,
      processing_timeout_minutes: config.notificationRequestProcessingTimeoutMinutes,
      limit: config.notificationRequestReconcileLimit
    });
    console.log(`[platform-notification-service] notification request reconcile trigger=${trigger} expired=${summary.expired} queued_timed_out=${summary.queued_timed_out} processing_timed_out=${summary.processing_timed_out} updated=${summary.updated} scanned=${summary.scanned} limit=${summary.limit}`);
    return true;
  } catch (error) {
    console.error(`[platform-notification-service] notification request reconcile failed trigger=${trigger}: ${error instanceof Error ? truncate(error.message, 1000) : "unknown error"}`);
    return false;
  } finally {
    notificationRequestReconcileRunning = false;
  }
}

function scheduleNotificationRequestReconcile(): void {
  if (!config.notificationRequestReconcileEnabled) {
    console.log("[platform-notification-service] notification request reconcile is disabled.");
    return;
  }

  scheduleStartupRetry({
    name: "notification request reconcile",
    initialDelayMs: config.notificationRequestReconcileStartupDelayMs,
    retryIntervalMs: config.notificationRequestReconcileStartupRetryIntervalMs,
    maxAttempts: config.notificationRequestReconcileStartupMaxAttempts,
    run: runNotificationRequestReconcile
  });
  const intervalTimer = setInterval(() => {
    void runNotificationRequestReconcile("interval");
  }, config.notificationRequestReconcileIntervalMs);
  intervalTimer.unref?.();
}

const NOTIFICATION_CANARY_CHANNELS: NotificationChannel[] = ["browser_push", "email", "sms", "mobile_push", "voice", "webhook", "in_app"];
const NOTIFICATION_TERMINAL_STATUSES = new Set(["sent", "partially_sent", "failed", "canceled"]);

function parseCanaryChannel(value: unknown): NotificationChannel {
  const channel = asString(value, "browser_push").replace(/-/g, "_") as NotificationChannel;
  if (!NOTIFICATION_CANARY_CHANNELS.includes(channel)) {
    throw Object.assign(new Error(`Unsupported notification canary channel '${channel}'.`), { status: 422 });
  }
  return channel;
}

function notificationCanaryTemplateKey(channel: NotificationChannel): string {
  return `platform.notification.canary.${channel.replace(/_/g, "-")}`;
}

function canaryRecipient(channel: NotificationChannel, body: JsonRecord): NotificationRecipientHint {
  const configured = asRecord(body.recipient);
  if (configured) {
    return configured as NotificationRecipientHint;
  }

  const recipientAddress = asString(body.recipient_address) || asString(body.address);
  if (channel === "email") {
    return {
      type: "email",
      address: recipientAddress || "runtime-canary@example.invalid",
      channels: [channel],
      data: { notification_canary: true }
    };
  }
  if (channel === "browser_push") {
    return {
      type: "browser_subscription",
      id: asString(body.browser_subscription_id) || "runtime-canary-browser-subscription",
      channels: [channel],
      data: {
        notification_canary: true,
        browser_subscription_id: asString(body.browser_subscription_id) || "runtime-canary-browser-subscription"
      }
    };
  }
  if (channel === "sms" || channel === "voice") {
    return {
      type: "phone",
      address: recipientAddress || "+15555550100",
      channels: [channel],
      data: { notification_canary: true }
    };
  }
  if (channel === "webhook") {
    return {
      type: "webhook",
      address: recipientAddress || "https://runtime-canary.invalid/notifications",
      channels: [channel],
      data: { notification_canary: true }
    };
  }
  if (channel === "mobile_push") {
    return {
      type: "user",
      id: asString(body.user_id) || "runtime-canary-mobile-user",
      channels: [channel],
      data: { notification_canary: true, mobile_installation_id: "runtime-canary-mobile-installation" }
    };
  }
  return {
    type: "topic",
    id: asString(body.topic) || "runtime-canary",
    channels: [channel],
    data: { notification_canary: true }
  };
}

function buildNotificationCanaryInput(body: JsonRecord): { channel: NotificationChannel; dryRun: boolean; input: NotificationRequestInput } {
  const channel = parseCanaryChannel(body.channel);
  const dryRun = Object.hasOwn(body, "dry_run")
    ? asBoolean(body.dry_run, true)
    : !asBoolean(body.send, false);
  const now = new Date().toISOString();
  const correlationId = asString(body.correlation_id) || `runtime-notification-canary:${channel}:${randomUUID()}`;
  const parameters = {
    channel,
    channel_label: channel.replace(/_/g, " "),
    correlation_id: correlationId,
    dry_run: dryRun,
    requested_at: now,
    ...(asRecord(body.parameters) ?? {})
  };
  const metadata = {
    ...(asRecord(body.metadata) ?? {}),
    runtime_canary: {
      enabled: true,
      channel,
      dry_run: dryRun
    },
    dry_run: dryRun,
    source: "runtime-status-canary",
    purpose: "notification_nifi_flow_canary"
  };
  return {
    channel,
    dryRun,
    input: {
      event_key: asString(body.event_key) || `platform.notification.canary.${channel}`,
      source: asString(body.source, "runtime-status-canary"),
      severity: "info",
      priority: "normal",
      notification_key: asString(body.notification_key) || notificationCanaryTemplateKey(channel),
      channels: [channel],
      recipients: [canaryRecipient(channel, body)],
      parameters,
      data: {
        notification_canary: true,
        channel,
        dry_run: dryRun,
        requested_at: now,
        ...(asRecord(body.data) ?? {})
      },
      metadata,
      correlation_id: correlationId,
      idempotency_key: asString(body.idempotency_key) || undefined
    }
  };
}

function deliveryAttemptObservedDryRun(attempt: NotificationDeliveryAttemptRecord): boolean {
  const response = asRecord(attempt.response_json) ?? {};
  const executorResponse = asRecord(response.executor_response) ?? {};
  return asString(response.mode).toLowerCase() === "dry_run"
    || asString(executorResponse.mode).toLowerCase() === "dry_run"
    || asBoolean(response.dry_run)
    || asBoolean(executorResponse.dry_run);
}

function summarizeCanaryAttempt(attempt: NotificationDeliveryAttemptRecord): JsonRecord {
  return {
    id: attempt.id,
    channel: attempt.channel,
    provider_key: attempt.provider_key || null,
    status: attempt.status,
    provider_message_id: attempt.provider_message_id || null,
    dry_run_observed: deliveryAttemptObservedDryRun(attempt),
    error_message: attempt.error_message || null,
    attempted_at: attempt.attempted_at || null,
    finished_at: attempt.finished_at || null,
    response_json: attempt.response_json ?? {}
  };
}

async function waitForNotificationCanaryResult(
  requestId: string,
  channel: NotificationChannel,
  dryRun: boolean,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<JsonRecord & { ok: boolean; http_status: number }> {
  const started = Date.now();
  let requestRecord: NotificationRequestRecord | null = null;
  let attempts: NotificationDeliveryAttemptRecord[] = [];
  let pollCount = 0;

  do {
    pollCount += 1;
    requestRecord = await getNotificationRequest(requestId);
    attempts = await listDeliveryAttemptsForRequest(requestId);
    if (NOTIFICATION_TERMINAL_STATUSES.has(asString(requestRecord.status))) {
      break;
    }
    await wait(pollIntervalMs);
  } while (Date.now() - started < timeoutMs);

  const elapsedMs = Date.now() - started;
  const channelAttempts = attempts.filter((attempt) => attempt.channel === channel);
  const sentAttempt = channelAttempts.find((attempt) => attempt.status === "sent");
  const terminalStatus = asString(requestRecord?.status);
  const terminal = NOTIFICATION_TERMINAL_STATUSES.has(terminalStatus);
  const dryRunObserved = !dryRun || channelAttempts.some(deliveryAttemptObservedDryRun);
  const ok = terminal
    && (terminalStatus === "sent" || terminalStatus === "partially_sent")
    && Boolean(sentAttempt)
    && dryRunObserved;

  return {
    ok,
    http_status: ok ? 200 : terminal ? 503 : 504,
    notification_request_id: requestId,
    channel,
    dry_run: dryRun,
    dry_run_observed: dryRunObserved,
    elapsed_ms: elapsedMs,
    poll_count: pollCount,
    terminal,
    status: terminalStatus || "unknown",
    last_message: requestRecord?.last_message || null,
    error_message: requestRecord?.error_message || null,
    queued_at: requestRecord?.queued_at || null,
    started_at: requestRecord?.started_at || null,
    finished_at: requestRecord?.finished_at || null,
    delivery_attempt_count: attempts.length,
    channel_delivery_attempt_count: channelAttempts.length,
    delivery_attempts: channelAttempts.map(summarizeCanaryAttempt),
    reason: ok
      ? "notification_canary_succeeded"
      : !terminal
        ? "notification_canary_timed_out"
        : !sentAttempt
          ? "notification_canary_missing_sent_delivery_attempt"
          : "notification_canary_dry_run_not_observed"
  };
}

async function runNotificationCanary(req: Request, res: Response): Promise<void> {
  await enforceInternalAuth(req);
  const body = asRecord(req.body) ?? {};
  const { channel, dryRun, input } = buildNotificationCanaryInput(body);
  const timeoutMs = Math.max(1000, Math.min(120_000, Number(body.timeout_ms) || 45_000));
  const pollIntervalMs = Math.max(250, Math.min(5000, Number(body.poll_interval_ms) || 1000));
  const queued = await queueNotificationInput(input);
  if (!queued.record_id) {
    res.status(200).json({
      ...notificationQueuedPayload(null, queued.duplicate, queued.status, queued.correlation_id),
      channel,
      dry_run: dryRun,
      terminal: false,
      delivery_attempt_count: 0,
      channel_delivery_attempt_count: 0,
      delivery_attempts: [],
      reason: "notification_canary_duplicate_request_not_readable_yet"
    });
    return;
  }
  const result = await waitForNotificationCanaryResult(queued.record_id, channel, dryRun, timeoutMs, pollIntervalMs);
  res.status(result.http_status).json({
    ...result,
    duplicate: queued.duplicate,
    correlation_id: input.correlation_id,
    notification_key: input.notification_key || null
  });
}

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true, service: "platform-notification-service", version: "1.0.0" });
});

app.get("/readyz", async (_req, res) => {
  const dependencies: Record<string, unknown> = {};
  const directus = await directusHealth();
  dependencies.directus = directus;
  const kafka = await kafkaReady();
  dependencies.kafka = kafka;
  const ok = directus.ok && kafka.ok;
  res.status(ok ? 200 : 503).json({
    ok,
    service: "platform-notification-service",
    notification_requested_topic: config.notificationRequestedTopic,
    dependencies
  });
});

app.get("/openapi.json", (_req, res) => {
  res.status(200).json(openApiSpec);
});

app.post("/internal/notifications", async (req, res, next) => {
  try {
    await queueNotification(req, res);
  } catch (error) {
    next(error);
  }
});

app.post("/internal/canaries/notifications", async (req, res, next) => {
  try {
    await runNotificationCanary(req, res);
  } catch (error) {
    next(error);
  }
});

app.post("/internal/notifications/reconcile-stale", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const input = parseNotificationRequestReconcile(req.body);
    const summary = await reconcileNotificationRequests(input);
    res.status(200).json({ ok: true, ...summary });
  } catch (error) {
    next(error);
  }
});

app.post("/internal/browser-subscriptions", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const input = parseBrowserSubscription(req.body);
    const subscription = await upsertBrowserPushSubscription(input);
    res.status(200).json({
      ok: true,
      browser_subscription_id: subscription.id || null,
      status: subscription.status,
      permission: subscription.permission || input.permission,
      fallback_channels: subscription.fallback_channels_json || input.fallback_channels
    });
  } catch (error) {
    next(error);
  }
});

app.post("/internal/browser-push/public-key", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const publicKey = await resolveBrowserPushPublicKey();
    res.status(200).json({ ok: true, public_key: publicKey });
  } catch (error) {
    next(error);
  }
});

app.post("/internal/browser-subscriptions/lifecycle/cleanup", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const input = parseBrowserSubscriptionCleanup(req.body);
    const summary = await cleanupBrowserPushSubscriptions(input);
    res.status(200).json({ ok: true, ...summary });
  } catch (error) {
    next(error);
  }
});

app.post("/internal/browser-subscriptions/search", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const input = parseBrowserSubscriptionSearch(req.body);
    const subscriptions = await searchBrowserPushSubscriptions(input);
    res.status(200).json({
      ok: true,
      browser_subscriptions: subscriptions,
      count: subscriptions.length
    });
  } catch (error) {
    next(error);
  }
});

app.post("/internal/browser-subscriptions/browse", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const input = parseBrowserSubscriptionBrowse(req.body);
    const result = await browseBrowserPushSubscriptions(input);
    res.status(200).json({
      ok: true,
      ...result
    });
  } catch (error) {
    next(error);
  }
});

app.post("/internal/browser-subscriptions/stats", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const input = parseBrowserSubscriptionStats(req.body);
    const stats = await getBrowserPushSubscriptionStats(input);
    res.status(200).json({
      ok: true,
      stats
    });
  } catch (error) {
    next(error);
  }
});

app.post("/internal/browser-subscriptions/:id/lifecycle", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const input = parseBrowserSubscriptionLifecyclePatch(req.body);
    const subscription = await patchBrowserPushSubscriptionLifecycle(req.params.id, input);
    res.status(200).json({
      ok: true,
      browser_subscription_id: subscription.id,
      status: subscription.status
    });
  } catch (error) {
    next(error);
  }
});

app.get("/internal/browser-subscriptions/:id", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    // Intentionally omitted from OpenAPI so gateway/action generation does not publish subscription material.
    const subscription = await getBrowserPushSubscription(req.params.id);
    res.status(200).json({ ok: true, browser_subscription: subscription });
  } catch (error) {
    next(error);
  }
});

app.get("/internal/notifications/:id", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const record = await getNotificationRequest(req.params.id);
    res.status(200).json({ ok: true, notification_request: record });
  } catch (error) {
    next(error);
  }
});

app.post("/internal/notifications/:id/status", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const patch = parseNotificationStatusPatch(req.body);
    const status = await patchNotificationStatus(req.params.id, patch);
    res.status(200).json({ ok: true, notification_request_id: req.params.id, status });
  } catch (error) {
    next(error);
  }
});

app.post("/internal/notifications/:id/delivery-attempts", async (req, res, next) => {
  try {
    await enforceInternalAuth(req);
    const input = parseDeliveryAttempt(req.body);
    const attempt = await createDeliveryAttempt(req.params.id, input);
    res.status(200).json({
      ok: true,
      notification_request_id: req.params.id,
      delivery_attempt_id: attempt.id,
      status: input.status
    });
  } catch (error) {
    next(error);
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: { message: "Not found", status: 404 } });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof ZodError
    ? 422
    : Math.max(400, Math.min(599, Number((err as { status?: number }).status) || 500));
  const message = err instanceof ZodError
    ? err.errors.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")
    : err instanceof Error ? err.message : "Internal server error";

  if (status >= 500) {
    const body = asRecord(_req.body) ? redactJsonRecord(asRecord(_req.body) ?? {}) : {};
    console.error(`[platform-notification-service] request failed status=${status}: ${truncate(message, 1000)} body=${truncate(JSON.stringify(body), 1000)}`);
  }

  res.status(status).json({
    error: {
      message,
      status
    }
  });
});

app.listen(config.port, () => {
  console.log(`[platform-notification-service] listening on :${config.port} topic=${config.notificationRequestedTopic}`);
  scheduleBrowserSubscriptionCleanup();
  scheduleNotificationRequestReconcile();
});
