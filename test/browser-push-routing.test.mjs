import assert from "node:assert/strict";
import test from "node:test";
import {
  inheritedBrowserPushRoutingPatch,
  persistedBrowserPushDeviceTarget,
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
