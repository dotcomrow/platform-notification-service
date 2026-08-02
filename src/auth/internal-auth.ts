import { timingSafeEqual } from "node:crypto";
import { Request } from "express";
import { config } from "../config.js";
import { asString, truncate } from "../lib/json.js";
import { resolveDirectusToken } from "../lib/directus.js";
import { resolveInternalToken } from "../lib/vault.js";

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function acceptedTokens(): Promise<string[]> {
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
  return [...tokens];
}

export async function enforceInternalAuth(req: Request): Promise<void> {
  if (!config.authRequired) {
    return;
  }

  const expectedTokens = await acceptedTokens();
  if (!expectedTokens.length) {
    throw Object.assign(new Error("Internal auth token is not configured."), { status: 503 });
  }

  const actual = asString(req.header("authorization"));
  if (!expectedTokens.some((token) => safeEqual(actual, `Bearer ${token}`))) {
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  }
}
