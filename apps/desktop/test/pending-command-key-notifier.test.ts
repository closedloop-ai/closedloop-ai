import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrganizationCommandPublicKey } from "../src/main/authorized-public-keys-client.js";
import {
  type PendingCommandKeyNotification,
  type PendingCommandKeyNotificationOptions,
  PendingCommandKeyNotifier,
} from "../src/main/pending-command-key-notifier.js";

test("PendingCommandKeyNotifier dedupes notified fingerprints per session", async () => {
  const notifications: FakeNotification[] = [];
  const notifier = new PendingCommandKeyNotifier({
    getPendingKeys: async () => [makeKey("cl:first")],
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => false,
    onOpenSettings: () => {},
    onApprove: () => {},
    onDecline: () => {},
    onChanged: () => {},
  });

  await notifier.notifyPendingKeys();
  await notifier.notifyPendingKeys();

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].shown, true);
});

test("PendingCommandKeyNotifier uses prefetched pending keys without refetching", async () => {
  const notifications: FakeNotification[] = [];
  let fetchCount = 0;
  const notifier = new PendingCommandKeyNotifier({
    getPendingKeys: async () => {
      fetchCount += 1;
      return [makeKey("cl:fetched")];
    },
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => false,
    onOpenSettings: () => {},
    onApprove: () => {},
    onDecline: () => {},
    onChanged: () => {},
  });

  await notifier.notifyPendingKeys([makeKey("cl:prefetched")]);
  await notifier.notifyPendingKeys([makeKey("cl:prefetched")]);

  assert.equal(fetchCount, 0);
  assert.equal(notifications.length, 1);
  assert.match(
    notifications[0].options.body,
    /registered a browser command key/
  );
});

test("PendingCommandKeyNotifier can notify from a relay-provided fingerprint", async () => {
  const notifications: FakeNotification[] = [];
  let fetchCount = 0;
  const notifier = new PendingCommandKeyNotifier({
    getPendingKeys: async () => {
      fetchCount += 1;
      return [makeKey("cl:fetched")];
    },
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => true,
    onOpenSettings: () => {},
    onApprove: () => {},
    onDecline: () => {},
    onChanged: () => {},
  });

  await notifier.notifyPendingKeys([
    {
      fingerprint: "cl:abcdefghijklmnopqrstuv",
      ownerName: "A browser session",
    },
  ]);

  assert.equal(fetchCount, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].shown, true);
  assert.match(notifications[0].options.body, /A browser session registered/);
  assert.deepEqual(notifications[0].options.actions, [
    { type: "button", text: "Approve" },
    { type: "button", text: "Decline" },
  ]);
});

test("PendingCommandKeyNotifier opens settings on notification click", async () => {
  const notifications: FakeNotification[] = [];
  let openCount = 0;
  const notifier = new PendingCommandKeyNotifier({
    getPendingKeys: async () => [makeKey("cl:first"), makeKey("cl:second")],
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => true,
    onOpenSettings: () => {
      openCount += 1;
    },
    onApprove: () => {},
    onDecline: () => {},
    onChanged: () => {},
  });

  await notifier.notifyPendingKeys();
  notifications[0].click();

  assert.equal(openCount, 1);
  assert.equal(notifications[0].options.actions, undefined);
});

test("PendingCommandKeyNotifier exposes and handles single-key actions", async () => {
  const notifications: FakeNotification[] = [];
  const actions: string[] = [];
  let changedCount = 0;
  const notifier = new PendingCommandKeyNotifier({
    getPendingKeys: async () => [makeKey("cl:first")],
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => true,
    onOpenSettings: () => {},
    onApprove: (fingerprint) => {
      actions.push(`approve:${fingerprint}`);
    },
    onDecline: (fingerprint) => {
      actions.push(`decline:${fingerprint}`);
    },
    onChanged: () => {
      changedCount += 1;
    },
  });

  await notifier.notifyPendingKeys();
  notifications[0].action(0);
  notifications[0].action(1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(notifications[0].options.actions, [
    { type: "button", text: "Approve" },
    { type: "button", text: "Decline" },
  ]);
  assert.deepEqual(actions, ["approve:cl:first", "decline:cl:first"]);
  assert.equal(changedCount, 2);
});

test("PendingCommandKeyNotifier dismisses active single-key notifications by fingerprint", async () => {
  const notifications: FakeNotification[] = [];
  const notifier = new PendingCommandKeyNotifier({
    getPendingKeys: async () => [makeKey("cl:first")],
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => true,
    onOpenSettings: () => {},
    onApprove: () => {},
    onDecline: () => {},
    onChanged: () => {},
  });

  await notifier.notifyPendingKeys();
  notifier.dismiss("cl:first");
  notifier.dismiss("cl:first");

  assert.equal(notifications[0].closed, true);
  assert.equal(notifications[0].closeCount, 1);
});

test("PendingCommandKeyNotifier does not dismiss grouped notifications by fingerprint", async () => {
  const notifications: FakeNotification[] = [];
  const notifier = new PendingCommandKeyNotifier({
    getPendingKeys: async () => [makeKey("cl:first"), makeKey("cl:second")],
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => true,
    onOpenSettings: () => {},
    onApprove: () => {},
    onDecline: () => {},
    onChanged: () => {},
  });

  await notifier.notifyPendingKeys();
  notifier.dismiss("cl:first");

  assert.equal(notifications[0].closed, false);
});

test("PendingCommandKeyNotifier does not open settings when an action press also emits click", async () => {
  const notifications: FakeNotification[] = [];
  const actions: string[] = [];
  let openCount = 0;
  const notifier = new PendingCommandKeyNotifier({
    getPendingKeys: async () => [makeKey("cl:first")],
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => true,
    onOpenSettings: () => {
      openCount += 1;
    },
    onApprove: (fingerprint) => {
      actions.push(`approve:${fingerprint}`);
    },
    onDecline: () => {},
    onChanged: () => {},
  });

  await notifier.notifyPendingKeys();
  notifications[0].action(0);
  notifications[0].click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(actions, ["approve:cl:first"]);
  assert.equal(openCount, 0);
  assert.equal(notifications[0].closed, true);
});

test("PendingCommandKeyNotifier skips silently when pending key fetch fails", async () => {
  const notifications: FakeNotification[] = [];
  const logs: string[] = [];
  const notifier = new PendingCommandKeyNotifier({
    getPendingKeys: async () => {
      throw new Error("missing API key");
    },
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => true,
    onOpenSettings: () => {},
    onApprove: () => {},
    onDecline: () => {},
    onChanged: () => {},
    log: (message) => logs.push(message),
  });

  await notifier.notifyPendingKeys();

  assert.equal(notifications.length, 0);
  assert.match(logs[0], /missing API key/);
});

function makeKey(fingerprint: string): OrganizationCommandPublicKey {
  return {
    id: fingerprint,
    userId: "user-1",
    organizationId: "org-1",
    publicKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    fingerprint,
    createdAt: "2026-05-09T00:00:00.000Z",
    ownerName: "A User",
  };
}

class FakeNotification implements PendingCommandKeyNotification {
  readonly options: PendingCommandKeyNotificationOptions;
  shown = false;
  closed = false;
  closeCount = 0;
  private clickListener: (() => void) | null = null;
  private actionListener: ((_event: unknown, index: number) => void) | null =
    null;
  private closeListener: (() => void) | null = null;

  constructor(options: PendingCommandKeyNotificationOptions) {
    this.options = options;
  }

  on(event: "click" | "action" | "close", listener: unknown): void {
    if (event === "click") {
      this.clickListener = listener as () => void;
    } else if (event === "action") {
      this.actionListener = listener as (
        _event: unknown,
        index: number
      ) => void;
    } else {
      this.closeListener = listener as () => void;
    }
  }

  show(): void {
    this.shown = true;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeCount += 1;
    this.closeListener?.();
  }

  click(): void {
    this.clickListener?.();
  }

  action(index: number): void {
    this.actionListener?.({}, index);
  }
}
