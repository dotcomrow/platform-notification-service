import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import { config } from "./config.js";
import { enforceInternalAuth } from "./auth/internal-auth.js";
import { directusHealth } from "./lib/directus.js";
import { kafkaReady, publishJson } from "./lib/kafka.js";
import { asRecord, JsonRecord, redactJsonRecord, truncate } from "./lib/json.js";
import { vaultValue } from "./lib/vault.js";
import { openApiSpec } from "./openapi.js";
import {
  cleanupBrowserPushSubscriptions,
  createDeliveryAttempt,
  createNotificationRequest,
  browseBrowserPushSubscriptions,
  enrichNotificationRequest,
  findRequestByIdempotencyKey,
  getBrowserPushSubscriptionStats,
  getBrowserPushSubscription,
  getNotificationRequest,
  markRequestQueueFailed,
  markRequestQueued,
  patchBrowserPushSubscriptionLifecycle,
  patchNotificationStatus,
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
  parseNotificationRequest,
  parseNotificationStatusPatch
} from "./notifications/validation.js";

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

function notificationQueuedPayload(recordId: string, duplicate: boolean, status: string, correlationId?: string | null) {
  return {
    ok: true,
    duplicate,
    notification_request_id: recordId,
    status,
    correlation_id: correlationId || null,
    queue_topic: config.notificationRequestedTopic
  };
}

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

function respondWithDuplicateRequest(res: Response, existing: Awaited<ReturnType<typeof findRequestByIdempotencyKey>>): boolean {
  if (!existing) {
    return false;
  }
  res.status(200).json(notificationQueuedPayload(existing.id, true, existing.status, existing.correlation_id));
  return true;
}

async function queueNotification(req: Request, res: Response): Promise<void> {
  await enforceInternalAuth(req);
  const parsedInput = parseNotificationRequest(req.body);

  if (parsedInput.idempotency_key) {
    const existing = await findRequestByIdempotencyKey(parsedInput.source, parsedInput.idempotency_key);
    if (respondWithDuplicateRequest(res, existing)) {
      return;
    }
  }

  const { input, context } = await enrichNotificationRequest(parsedInput);
  if (input.idempotency_key) {
    const existing = await findRequestByIdempotencyKey(input.source, input.idempotency_key);
    if (respondWithDuplicateRequest(res, existing)) {
      return;
    }
  }

  let requestRecord;
  try {
    requestRecord = await createNotificationRequest(input, context);
  } catch (error) {
    if (input.idempotency_key && isNotificationRequestIdempotencyConflict(error)) {
      const existing = await findRequestByIdempotencyKeyWithRetry(input.source, input.idempotency_key);
      if (respondWithDuplicateRequest(res, existing)) {
        return;
      }
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

  res.status(202).json(notificationQueuedPayload(requestRecord.id, false, "queued", input.correlation_id));
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

async function runBrowserSubscriptionCleanup(trigger: string): Promise<void> {
  if (browserSubscriptionCleanupRunning) {
    console.warn(`[platform-notification-service] browser subscription cleanup skipped; previous run is still active trigger=${trigger}`);
    return;
  }
  browserSubscriptionCleanupRunning = true;
  try {
    const summary = await cleanupBrowserPushSubscriptions({
      stale_days: config.browserSubscriptionStaleDays,
      limit: config.browserSubscriptionCleanupLimit
    });
    console.log(`[platform-notification-service] browser subscription cleanup trigger=${trigger} expired=${summary.expired} stale=${summary.stale} superseded=${summary.superseded} stale_days=${summary.stale_days} limit=${summary.limit}`);
  } catch (error) {
    console.error(`[platform-notification-service] browser subscription cleanup failed trigger=${trigger}: ${error instanceof Error ? truncate(error.message, 1000) : "unknown error"}`);
  } finally {
    browserSubscriptionCleanupRunning = false;
  }
}

function scheduleBrowserSubscriptionCleanup(): void {
  if (!config.browserSubscriptionCleanupEnabled) {
    console.log("[platform-notification-service] browser subscription cleanup is disabled.");
    return;
  }

  const startupTimer = setTimeout(() => {
    void runBrowserSubscriptionCleanup("startup");
  }, config.browserSubscriptionCleanupStartupDelayMs);
  const intervalTimer = setInterval(() => {
    void runBrowserSubscriptionCleanup("interval");
  }, config.browserSubscriptionCleanupIntervalMs);
  startupTimer.unref?.();
  intervalTimer.unref?.();
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
    await patchNotificationStatus(req.params.id, patch);
    res.status(200).json({ ok: true, notification_request_id: req.params.id, status: patch.status });
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
});
