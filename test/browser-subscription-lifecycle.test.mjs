import assert from "node:assert/strict";
import test from "node:test";
import { browserSubscriptionLifecycleMetadata } from "../dist/notifications/browser-subscription-lifecycle.js";

test("lifecycle updates preserve ownership and notification-link metadata", () => {
  const metadata = browserSubscriptionLifecycleMetadata({
    browser_link_proof_hash: "proof-hash",
    notification_link: {
      persistent: true,
      display_name: "administrator@example.com",
    },
  }, {
    provider: "web_push",
  }, {
    status: "disabled",
    reason: "provider_endpoint_gone",
    message: "The provider rejected the endpoint.",
    provider_status_code: 410,
  }, "2026-11-01T22:00:00.000Z");

  assert.equal(metadata.browser_link_proof_hash, "proof-hash");
  assert.deepEqual(metadata.notification_link, {
    persistent: true,
    display_name: "administrator@example.com",
  });
  assert.equal(metadata.provider, "web_push");
  assert.equal(metadata.lifecycle_reason, "provider_endpoint_gone");
  assert.equal(metadata.lifecycle_provider_status_code, 410);
});
