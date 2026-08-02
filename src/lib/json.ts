export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

export function truncate(value: string, max = 1200): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

export function extractErrorMessage(payload: unknown, fallback: string): string {
  const root = asRecord(payload);
  const directError = asString(root?.error);
  if (directError) return directError;
  const errors = Array.isArray(root?.errors) ? root.errors : [];
  const firstError = asRecord(errors[0]);
  const firstMessage = asString(firstError?.message);
  if (firstMessage) return firstMessage;
  return fallback;
}

export function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:token|access_token|refresh_token|key|secret)=)[^&\s]+/gi, "$1[redacted]");
}

export function redactJsonValue(value: unknown, key = ""): unknown {
  if (/token|secret|password|credential|private[_-]?key/i.test(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry));
  }
  const record = asRecord(value);
  if (record) {
    return Object.fromEntries(Object.entries(record).map(([entryKey, entryValue]) => [
      entryKey,
      redactJsonValue(entryValue, entryKey)
    ]));
  }
  return value;
}

export function redactJsonRecord(value: JsonRecord): JsonRecord {
  return redactJsonValue(value) as JsonRecord;
}
