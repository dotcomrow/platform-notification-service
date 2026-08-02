import { Dispatcher } from "undici";
import { config } from "../config.js";
import { httpJson } from "./http.js";
import { asRecord, asString, JsonRecord, truncate } from "./json.js";
import { vaultValue } from "./vault.js";

export type DirectusListResponse<T> = {
  data?: T[];
};

export type DirectusItemResponse<T> = {
  data?: T;
};

export async function resolveDirectusToken(): Promise<string> {
  if (config.directusStaticToken) {
    return config.directusStaticToken;
  }
  return vaultValue(config.directusTokenVaultPath, config.directusTokenVaultKey);
}

export async function directusJson<T>(
  path: string,
  init: { method?: Dispatcher.HttpMethod; body?: unknown; timeoutMs?: number } = {}
): Promise<T> {
  const token = await resolveDirectusToken();
  const method = init.method ?? "GET";
  const result = await httpJson<unknown>(`${config.directusBaseUrl}${path}`, {
    method,
    body: init.body,
    timeoutMs: init.timeoutMs ?? config.requestTimeoutMs,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === "GET" ? { "cache-control": "no-store" } : {})
    }
  });
  if (result.statusCode >= 400) {
    const payload = asRecord(result.payload) ?? {};
    const directError = asString(payload.error);
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    const firstError = asRecord(errors[0]);
    const message = directError || asString(firstError?.message) || result.text;
    throw new Error(`Directus ${method} ${path} failed: ${result.statusCode} ${truncate(message, 700)}`);
  }
  return result.payload as T;
}

export function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : "";
}

export async function directusHealth(): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const result = await httpJson<JsonRecord>(`${config.directusBaseUrl}${config.directusHealthPath}`, {
      timeoutMs: config.requestTimeoutMs
    });
    return { ok: result.statusCode < 400, status: result.statusCode };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? truncate(error.message, 500) : "Unknown Directus health error"
    };
  }
}
