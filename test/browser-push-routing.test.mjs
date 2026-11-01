import assert from "node:assert/strict";
import test from "node:test";
import {
  browserPushAppAllowed,
  browserPushOriginAllowed,
  inheritedBrowserPushRoutingPatch,
  persistedBrowserPushDeviceTarget,
  resolveBrowserPushAllowedOrigins,
  selectBrowserPushCandidates,
} from "../dist/notifications/browser-push-routing.js";

const devices = [
  {
    id: "existing-target",
    browser_installation_id: "install-a",
    browser_push_device_target: "all_devices",
    is_notification_target: true,
  },
  {
    id: "new-device",
    browser_installation_id: "install-b",
    browser_push_device_target: "all_devices",
    is_notification_target: false,
  },
];

test("explicit all_devices includes a newly registered untargeted device", () => {
  assert.deepEqual(
    selectBrowserPushCandidates(devices, "all_devices").map((device) => device.id),
    ["existing-target", "new-device"],
  );
});

test("explicit current_device ignores stale notification-target flags", () => {
  assert.deepEqual(
    selectBrowserPushCandidates(devices, "current_device", "install-b").map((device) => device.id),
    ["new-device"],
  );
});

test("persisted mode is recovered from subscription records", () => {
  assert.equal(persistedBrowserPushDeviceTarget(devices), "all_devices");
});

test("a new subscription inherits all_devices as an active target", () => {
  assert.deepEqual(inheritedBrowserPushRoutingPatch("all_devices"), {
    browser_push_device_target: "all_devices",
    is_notification_target: true,
  });
});

test("a new subscription does not become the current or favorite target", () => {
  assert.deepEqual(inheritedBrowserPushRoutingPatch("current_device"), {
    browser_push_device_target: "current_device",
    is_notification_target: false,
  });
  assert.deepEqual(inheritedBrowserPushRoutingPatch("favorite_device"), {
    browser_push_device_target: "favorite_device",
    is_notification_target: false,
  });
});

test("app configuration scopes delivery to the internal application", () => {
  const allowedOrigins = resolveBrowserPushAllowedOrigins(
    ["https://internal.suncoast.systems", "https://internal-preview.suncoast.systems"],
    ["https://internal.suncoast.systems/admin/notifications"],
  );
  assert.deepEqual(allowedOrigins, [
    "https://internal.suncoast.systems",
    "https://internal-preview.suncoast.systems",
  ]);
  assert.equal(browserPushOriginAllowed("https://internal.suncoast.systems", allowedOrigins), true);
  assert.equal(browserPushOriginAllowed("https://www-preview.suncoast.systems", allowedOrigins), false);
  assert.equal(browserPushOriginAllowed(undefined, allowedOrigins), false);
  assert.equal(browserPushAppAllowed("internal-app", "internal-app", undefined, allowedOrigins), true);
  assert.equal(browserPushAppAllowed("external-app", "internal-app", "https://internal.suncoast.systems", allowedOrigins), false);
});

test("backend requests without a page URL remain scoped to the configured app", () => {
  const allowedOrigins = resolveBrowserPushAllowedOrigins(
    ["https://internal.suncoast.systems", "https://internal-preview.suncoast.systems"],
    [],
  );
  assert.deepEqual(allowedOrigins, [
    "https://internal.suncoast.systems",
    "https://internal-preview.suncoast.systems",
  ]);
  assert.equal(browserPushOriginAllowed("https://external.suncoast.systems", allowedOrigins), false);
});
