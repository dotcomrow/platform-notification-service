import { createHash } from "node:crypto";
import { config } from "../config.js";
import { httpErrorMessage, httpJson } from "../lib/http.js";
import { asRecord } from "../lib/json.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function setCrmCommunicationPreference(input: {
  email: string;
  communicationsOptOut: boolean;
  subscriptionId: string;
}): Promise<void> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const preferenceKey = createHash("sha256")
    .update(`${normalizedEmail}:${input.communicationsOptOut ? "opt-out" : "opt-in"}`)
    .digest("hex")
    .slice(0, 32);
  const delays = [0, 150, 500];
  let lastError: Error | null = null;
  for (const delay of delays) {
    if (delay) await wait(delay);
    try {
      const response = await httpJson<unknown>(`${config.crmApiUrl}/v1/contact-communications/preference`, {
        method: "PUT",
        headers: {
          "idempotency-key": `notification-preference:${preferenceKey}`,
          "x-correlation-id": input.subscriptionId
        },
        body: {
          email: normalizedEmail,
          communications_opt_out: input.communicationsOptOut
        },
        timeoutMs: config.requestTimeoutMs
      });
      const payload = asRecord(response.payload);
      if (response.statusCode >= 200 && response.statusCode < 300 && payload?.ok === true) return;
      lastError = new Error(`CRM communication preference failed: HTTP ${response.statusCode} ${httpErrorMessage(response.payload, response.text)}`);
      if (response.statusCode < 500 && response.statusCode !== 404 && response.statusCode !== 409) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("CRM communication preference request failed.");
    }
  }
  throw lastError ?? new Error("CRM communication preference failed.");
}
