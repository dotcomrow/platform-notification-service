import assert from "node:assert/strict";
import test from "node:test";
import { allowsBrowserPushTrustedTokens } from "../dist/auth/internal-auth.js";

test("allows the trusted browser-push token on all ownership-protected mutation routes", () => {
  for (const path of [
    "/internal/browser-subscriptions",
    "/internal/browser-subscriptions/reconcile",
    "/internal/browser-subscriptions/delete",
    "/internal/browser-subscriptions/resolve",
  ]) {
    assert.equal(allowsBrowserPushTrustedTokens({ method: "POST", path }), true, path);
  }
});

test("does not extend the trusted browser-push token to unrelated routes or methods", () => {
  assert.equal(allowsBrowserPushTrustedTokens({
    method: "GET",
    path: "/internal/browser-subscriptions/reconcile",
  }), false);
  assert.equal(allowsBrowserPushTrustedTokens({
    method: "POST",
    path: "/internal/notifications",
  }), false);
});
