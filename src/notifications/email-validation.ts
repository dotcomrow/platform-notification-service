import { createHash } from "node:crypto";
import { config } from "../config.js";
import { httpErrorMessage, httpJson } from "../lib/http.js";
import { asRecord, asString } from "../lib/json.js";

export type EmailValidationStatus = "pending" | "validated" | "failed" | "expired";

export type EmailValidationResult = {
  id: string;
  status: EmailValidationStatus;
  checkedAt: string;
  error: string | null;
};

function normalizeStatus(value: unknown): EmailValidationStatus {
  const status = asString(value).toLowerCase();
  if (status === "verified" || status === "validated") {
    return "validated";
  }
  return status === "failed" || status === "expired" ? status : "pending";
}

export async function requestEmailValidation(input: {
  subscriptionId: string;
  email: string;
  userId?: string | null;
  attemptKey?: string | null;
}): Promise<EmailValidationResult> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const emailKey = createHash("sha256").update(normalizedEmail).digest("hex").slice(0, 20);
  const response = await httpJson<unknown>(`${config.crmApiUrl}/v1/email-verifications`, {
    method: "POST",
    headers: {
      "idempotency-key": `notification-subscription:${input.subscriptionId}:${emailKey}:${input.attemptKey || "initial"}`,
      "x-correlation-id": input.subscriptionId
    },
    body: {
      email: normalizedEmail,
      purpose: config.crmEmailValidationPurpose,
      user_id: input.userId || undefined
    },
    timeoutMs: config.requestTimeoutMs
  });
  const payload = asRecord(response.payload);
  const id = asString(payload?.validation_id);
  if (response.statusCode < 200 || response.statusCode >= 300 || !id) {
    throw new Error(`CRM email validation request failed: HTTP ${response.statusCode} ${httpErrorMessage(response.payload, response.text)}`);
  }
  return { id, status: normalizeStatus(payload?.status), checkedAt: new Date().toISOString(), error: null };
}

