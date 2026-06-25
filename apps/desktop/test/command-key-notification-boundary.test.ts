import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrganizationCommandPublicKey } from "../src/main/authorized-public-keys-client.js";
import { CommandKeyReconciler } from "../src/main/command-key-reconciler.js";
import {
  type ActiveCommandKeyTargetContext,
  classifyOrganizationCommandKeysForTarget,
} from "../src/main/command-key-target-context.js";
import {
  type PendingCommandKeyNotification,
  type PendingCommandKeyNotificationOptions,
  PendingCommandKeyNotifier,
} from "../src/main/pending-command-key-notifier.js";
import { BROWSER_KEY_TARGET_ACCESS } from "../src/shared/contracts.js";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TARGET_ID = "22222222-2222-4222-8222-222222222222";
const GATEWAY_ID = "33333333-3333-4333-8333-333333333333";
const ACTIVE_CONTEXT: ActiveCommandKeyTargetContext = {
  computeTargetId: TARGET_ID,
  gatewayId: GATEWAY_ID,
};

test("notification boundary suppresses legacy broad and invalid-only browser key responses", async () => {
  const legacy = await runNotificationFlow([makeKey("cl:legacybroadkey123")]);
  const invalidOnly = await runNotificationFlow([
    makeKey("cl:sharedtargetkey123", {
      computeTargetId: TARGET_ID,
      gatewayId: GATEWAY_ID,
      access: "shared_target",
    }),
    makeKey("cl:mismatchedtarget1", {
      computeTargetId: OTHER_TARGET_ID,
      gatewayId: GATEWAY_ID,
      access: BROWSER_KEY_TARGET_ACCESS.OwnedTarget,
    }),
  ]);

  assert.equal(legacy.notifications.length, 0);
  assert.equal(invalidOnly.notifications.length, 0);
});

test("notification boundary shows only the matching owned target from mixed responses", async () => {
  const matching = makeKey("cl:matchingtarget1234", {
    computeTargetId: TARGET_ID,
    gatewayId: GATEWAY_ID,
    access: BROWSER_KEY_TARGET_ACCESS.OwnedTarget,
  });
  const result = await runNotificationFlow([
    matching,
    makeKey("cl:legacybroadkey123"),
    makeKey("cl:sharedtargetkey123", {
      computeTargetId: TARGET_ID,
      gatewayId: GATEWAY_ID,
      access: "shared_target",
    }),
    makeKey("cl:mismatchedtarget1", {
      computeTargetId: OTHER_TARGET_ID,
      gatewayId: GATEWAY_ID,
      access: BROWSER_KEY_TARGET_ACCESS.OwnedTarget,
    }),
  ]);

  assert.equal(result.notifications.length, 1);
  assert.equal(result.notifications[0].shown, true);
  assert.match(result.notifications[0].options.body, /Owner User/);
});

test("notification boundary dedupes a direct approval prompt before later reconciliation", async () => {
  const notifications: FakeNotification[] = [];
  const notifier = makeNotifier(notifications);
  const matching = makeKey("cl:matchingtarget1234", {
    computeTargetId: TARGET_ID,
    gatewayId: GATEWAY_ID,
    access: BROWSER_KEY_TARGET_ACCESS.OwnedTarget,
  });

  await notifier.notifyPendingKeys([matching]);
  await reconcileThroughNotifier({
    keys: [matching],
    notifier,
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].shown, true);
});

async function runNotificationFlow(keys: OrganizationCommandPublicKey[]) {
  const notifications: FakeNotification[] = [];
  const notifier = makeNotifier(notifications);
  await reconcileThroughNotifier({ keys, notifier });
  return { notifications };
}

async function reconcileThroughNotifier(input: {
  keys: OrganizationCommandPublicKey[];
  notifier: PendingCommandKeyNotifier;
}) {
  const reconciler = new CommandKeyReconciler({
    hasApiKey: () => true,
    fetchOrganizationKeyClassification: async (reason) =>
      classifyOrganizationCommandKeysForTarget({
        keys: input.keys,
        activeContext: ACTIVE_CONTEXT,
        reason,
      }),
    reconcileOrganizationKeys: () => ({ removed: [], promoted: [] }),
    notifyPendingKeys: (keys) => input.notifier.notifyPendingKeys(keys),
    onChanged: () => {},
    log: () => {},
  });

  await reconciler.reconcileNow("periodic");
}

function makeNotifier(notifications: FakeNotification[]) {
  return new PendingCommandKeyNotifier({
    getPendingKeys: async () => [],
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
}

function makeKey(
  fingerprint: string,
  targetContext?: unknown
): OrganizationCommandPublicKey {
  return {
    id: fingerprint,
    userId: "user-1",
    organizationId: "org-1",
    publicKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    fingerprint,
    createdAt: "2026-05-09T00:00:00.000Z",
    ownerName: "Owner User",
    ...(targetContext === undefined ? {} : { targetContext }),
  };
}

class FakeNotification implements PendingCommandKeyNotification {
  readonly options: PendingCommandKeyNotificationOptions;
  shown = false;
  private readonly listeners = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();

  constructor(options: PendingCommandKeyNotificationOptions) {
    this.options = options;
  }

  on(
    event: "click" | "action" | "close",
    listener: (...args: unknown[]) => void
  ): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  close(): void {
    for (const listener of this.listeners.get("close") ?? []) {
      listener();
    }
  }

  show(): void {
    this.shown = true;
  }
}
