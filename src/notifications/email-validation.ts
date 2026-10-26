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
  subjectId?: string | null;
  email: string;
  attemptKey?: string | null;
}): Promise<EmailValidationResult> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const emailKey = createHash("sha256").update(normalizedEmail).digest("hex").slice(0, 20);
  const response = await httpJson<unknown>(`${config.crmApiUrl}/v1/external-signups/contacts`, {
    method: "POST",
    headers: {
      "idempotency-key": `notification-subscription:${input.subscriptionId}:${emailKey}:${input.attemptKey || "initial"}`,
      "x-correlation-id": input.subscriptionId
    },
    body: {
      purpose: config.crmEmailValidationPurpose,
      subject_id: input.subjectId || `email:${normalizedEmail}`,
      properties: {
        email: normalizedEmail,
        firstname: "Notification",
        lastname: "Subscriber",
        email_verified: false
      },
      associations: {}
    },
    timeoutMs: config.requestTimeoutMs
  });
  const payload = asRecord(response.payload);
  const verification = asRecord(payload?.email_verification);
  const id = asString(verification?.validation_id);
  const contactId = asString(payload?.entity_id);
  const operationId = asString(payload?.operation_id);
  if (response.statusCode < 200 || response.statusCode >= 300 || !id || !contactId || !operationId) {
    throw new Error(`CRM contact signup failed: HTTP ${response.statusCode} ${httpErrorMessage(response.payload, response.text)}`);
  }
  return { id, status: normalizeStatus(verification?.status), checkedAt: new Date().toISOString(), error: null };
}

