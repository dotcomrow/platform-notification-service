import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import { config } from "./config.js";
import { enforceInternalAuth } from "./auth/internal-auth.js";
import { directusHealth } from "./lib/directus.js";
import { kafkaReady, publishJson } from "./lib/kafka.js";
import { asRecord, redactJsonRecord, truncate } from "./lib/json.js";
import { vaultValue } from "./lib/vault.js";
import { openApiSpec } from "./openapi.js";
import {
  createDeliveryAttempt,
  createNotificationRequest,
  enrichNotificationRequest,
  findRequestByIdempotencyKey,
  getBrowserPushSubscription,
  getNotificationRequest,
  markRequestQueueFailed,
  markRequestQueued,
  patchNotificationStatus,
  upsertBrowserPushSubscription
} from "./notifications/directus.js";
import {
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
app.use(rateLimit({ windowMs: config.rateWindowMs, limit: config.rateMax, standardHeaders: "draft-7", legacyHeaders: false }));

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

async function queueNotification(req: Request, res: Response): Promise<void> {
  await enforceInternalAuth(req);
  const parsedInput = parseNotificationRequest(req.body);

  if (parsedInput.idempotency_key) {
    const existing = await findRequestByIdempotencyKey(parsedInput.source, parsedInput.idempotency_key);
    if (existing) {
      res.status(200).json(notificationQueuedPayload(existing.id, true, existing.status, existing.correlation_id));
      return;
    }
  }

  const { input, context } = await enrichNotificationRequest(parsedInput);
  const requestRecord = await createNotificationRequest(input, context);
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
    template_key: input.template_key || null,
    locale: input.locale || null,
    subject: input.subject || null,
    body: input.body || null,
    channels: input.channels,
    recipients: input.recipients,
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
});
