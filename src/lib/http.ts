import { Agent, Dispatcher, request as undiciRequest, setGlobalDispatcher } from "undici";
import { extractErrorMessage } from "./json.js";

setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 10_000
  })
);

async function parseJsonResponse(text: string): Promise<unknown> {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function httpJson<T>(
  url: string,
  init: {
    method?: Dispatcher.HttpMethod;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
    dispatcher?: Dispatcher;
  } = {}
): Promise<{ statusCode: number; payload: T; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 10_000);
  try {
    const response = await undiciRequest(url, {
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers: {
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.headers ?? {})
      },
      dispatcher: init.dispatcher,
      signal: controller.signal
    });
    const text = await response.body.text();
    const payload = await parseJsonResponse(text);
    return { statusCode: response.statusCode, payload: payload as T, text };
  } finally {
    clearTimeout(timer);
  }
}

export function httpErrorMessage(payload: unknown, text: string): string {
  return extractErrorMessage(payload, text);
}
