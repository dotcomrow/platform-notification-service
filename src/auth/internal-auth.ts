import { timingSafeEqual } from "node:crypto";
import { Request } from "express";
import { config } from "../config.js";
import { asString, truncate } from "../lib/json.js";
import { resolveDirectusToken } from "../lib/directus.js";
import { optionalVaultValue, resolveInternalToken } from "../lib/vault.js";

const CLIENT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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

async function browserPushTrustedTokens(): Promise<string[]> {
  const tokens = new Set<string>();
  for (const clientKey of config.browserPushTrustedDirectusClientKeys) {
    if (!CLIENT_KEY_PATTERN.test(clientKey)) {
      console.warn(`[platform-notification-service] ignoring invalid browser-push trusted Directus client key '${truncate(clientKey, 120)}'`);
      continue;
    }
    try {
      const token = await optionalVaultValue(
        `${config.browserPushTrustedDirectusClientTokenVaultPrefix}/${clientKey}`,
        config.browserPushTrustedDirectusClientTokenVaultKey
      );
      if (token) {
        tokens.add(token);
      }
    } catch (error) {
      console.warn(`[platform-notification-service] browser-push trusted Directus client token unavailable for ${clientKey}: ${error instanceof Error ? truncate(error.message, 500) : "unknown error"}`);
    }
  }
  return [...tokens];
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
