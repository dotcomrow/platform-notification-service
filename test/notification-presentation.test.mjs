import assert from "node:assert/strict";
import test from "node:test";
import { parseNotificationRequest } from "../dist/notifications/validation.js";

function request(presentation) {
  return {
    event_key: "notification.presentation.test",
    source: "test",
    severity: "info",
    priority: "normal",
    channels: ["browser_push"],
    recipients: [{ type: "browser_subscription", id: "subscription-id" }],
    parameters: {},
    presentation,
    data: {},
    metadata: {},
    correlation_id: "presentation-test",
  };
}

test("accepts a bounded declarative notification presentation", () => {
  const parsed = parseNotificationRequest(request({
    url: "/operations/42",
    icon_url: "/assets/success-icon.png",
    image_url: "/assets/complete.png",
    image_alt: "Operation complete",
    tone: "success",
    actions: [
      { id: "open", label: "Open", url: "/operations/42" },
      { id: "history", label: "History", url: "/operations" },
    ],
  }));
  assert.equal(parsed.presentation.actions.length, 2);
  assert.equal(parsed.presentation.url, "/operations/42");
  assert.equal(parsed.presentation.icon_url, "/assets/success-icon.png");
  assert.equal(parsed.presentation.tone, "success");
});

test("rejects an unsupported notification tone", () => {
  assert.throws(() => parseNotificationRequest(request({ tone: "catastrophic" })));
});

test("rejects duplicate or excessive notification actions", () => {
  assert.throws(() => parseNotificationRequest(request({
    actions: [
      { id: "open", label: "One" },
      { id: "open", label: "Two" },
    ],
  })));
  assert.throws(() => parseNotificationRequest(request({
    actions: [
      { id: "one", label: "One" },
      { id: "two", label: "Two" },
      { id: "three", label: "Three" },
      { id: "four", label: "Four" },
    ],
  })));
});
