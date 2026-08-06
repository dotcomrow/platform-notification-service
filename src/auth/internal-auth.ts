import { timingSafeEqual } from "node:crypto";
import { Request } from "express";
import { config } from "../config.js";
import { asString, truncate } from "../lib/json.js";
import { resolveDirectusToken } from "../lib/directus.js";
import { optionalVaultValue, resolveInternalToken } from "../lib/vault.js";

const CLIENT_KEY_SOURCE = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const CLIENT_KEY_PATTERN = new RegExp(`^${CLIENT_KEY_SOURCE}$`);
const CLIENT_TOKEN_LOOKUP_KEY_PATTERN = new RegExp(
  `^(?:${CLIENT_KEY_SOURCE}|(?:internal|external)\\/${CLIENT_KEY_SOURCE})$`
);

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function allowsBrowserPushTrustedTokens(req: Request): boolean {
  if (req.method.toUpperCase() !== "POST") {
    return false;
  }
  return req.path === "/internal/browser-push/public-key"
    || req.path === "/internal/browser-subscriptions";
}

function allowsBrowserSubscriptionSearchTrustedTokens(req: Request): boolean {
  if (req.method.toUpperCase() !== "POST") {
    return false;
  }
  return req.path === "/internal/browser-subscriptions/search"
    || req.path === "/internal/browser-subscriptions/browse"
    || req.path === "/internal/browser-subscriptions/stats";
}

function allowsNotificationIntakeTrustedTokens(req: Request): boolean {
  return req.method.toUpperCase() === "POST" && req.path === "/internal/notifications";
}

async function trustedVaultClientTokens(
  clientKeys: string[],
  vaultPrefix: string,
  vaultKey: string,
  logLabel: string
): Promise<string[]> {
  const tokens = new Set<string>();
  for (const clientKey of clientKeys) {
    if (!CLIENT_TOKEN_LOOKUP_KEY_PATTERN.test(clientKey)) {
      console.warn(`[platform-notification-service] ignoring invalid ${logLabel} client key '${truncate(clientKey, 120)}'`);
      continue;
    }
    try {
      const token = await optionalVaultValue(
        `${vaultPrefix}/${clientKey}`,
        vaultKey
      );
      if (token) {
        tokens.add(token);
      }
    } catch (error) {
      console.warn(`[platform-notification-service] ${logLabel} client token unavailable for ${clientKey}: ${error instanceof Error ? truncate(error.message, 500) : "unknown error"}`);
    }
  }
  return [...tokens];
}

async function browserPushTrustedTokens(): Promise<string[]> {
  return trustedVaultClientTokens(
    config.browserPushTrustedDirectusClientKeys,
    config.browserPushTrustedDirectusClientTokenVaultPrefix,
    config.browserPushTrustedDirectusClientTokenVaultKey,
    "browser-push trusted Directus"
  );
}

async function browserSubscriptionSearchTrustedTokens(): Promise<string[]> {
  return trustedVaultClientTokens(
    config.browserSubscriptionSearchTrustedDirectusClientKeys,
    config.browserSubscriptionSearchTrustedDirectusClientTokenVaultPrefix,
    config.browserSubscriptionSearchTrustedDirectusClientTokenVaultKey,
    "browser-subscription-search trusted Directus"
  );
}

async function notificationIntakeTrustedTokens(): Promise<string[]> {
  return trustedVaultClientTokens(
    config.notificationIntakeTrustedClientKeys,
    config.notificationIntakeTrustedClientTokenVaultPrefix,
    config.notificationIntakeTrustedClientTokenVaultKey,
    "notification-intake trusted"
  );
}

async function notificationIntakeTrustedDirectusTokens(): Promise<string[]> {
  return trustedVaultClientTokens(
    config.notificationIntakeTrustedDirectusClientKeys,
    config.notificationIntakeTrustedDirectusClientTokenVaultPrefix,
    config.notificationIntakeTrustedDirectusClientTokenVaultKey,
    "notification-intake trusted Directus"
  );
}

async function acceptedTokens(req: Request): Promise<string[]> {
  const tokens = new Set<string>();
  const internalToken = await resolveInternalToken();
  if (internalToken) {
    tokens.add(internalToken);
  }
  try {
    const directusToken = await resolveDirectusToken();
    if (directusToken) {
      tokens.add(directusToken);
    }
  } catch (error) {
    console.warn(`[platform-notification-service] directus auth token unavailable: ${error instanceof Error ? truncate(error.message, 500) : "unknown error"}`);
  }
  if (allowsBrowserPushTrustedTokens(req)) {
    for (const token of await browserPushTrustedTokens()) {
      tokens.add(token);
    }
  }
  if (allowsBrowserSubscriptionSearchTrustedTokens(req)) {
    for (const token of await browserSubscriptionSearchTrustedTokens()) {
      tokens.add(token);
    }
  }
  if (allowsNotificationIntakeTrustedTokens(req)) {
    for (const token of await notificationIntakeTrustedTokens()) {
      tokens.add(token);
    }
    for (const token of await notificationIntakeTrustedDirectusTokens()) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

export async function enforceInternalAuth(req: Request): Promise<void> {
  if (!config.authRequired) {
    return;
  }

  const expectedTokens = await acceptedTokens(req);
  if (!expectedTokens.length) {
    throw Object.assign(new Error("Internal auth token is not configured."), { status: 503 });
  }

  const actual = asString(req.header("authorization"));
  if (!expectedTokens.some((token) => safeEqual(actual, `Bearer ${token}`))) {
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  }
}
