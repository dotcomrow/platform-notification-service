import { JsonRecord } from "../lib/json.js";

export function browserSubscriptionLifecycleMetadata(
  existingMetadata: JsonRecord | null | undefined,
  lifecycleMetadata: JsonRecord | null | undefined,
  input: {
    status: string;
    reason?: string;
    message?: string;
    provider_status_code?: number;
  },
  now: string
): JsonRecord {
  return {
    ...(existingMetadata ?? {}),
    ...(lifecycleMetadata ?? {}),
    lifecycle_reason: input.reason || input.status,
    lifecycle_message: input.message || undefined,
    lifecycle_provider_status_code: input.provider_status_code ?? undefined,
    lifecycle_updated_at: now
  };
}
