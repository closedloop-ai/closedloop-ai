import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrganizationCommandPublicKey } from "../src/main/authorized-public-keys-client.js";
import {
  BrowserCommandKeyAppLifecycle,
  resetBrowserCommandKeyProfileState,
} from "../src/main/command-key-app-lifecycle.js";
import { BROWSER_KEY_TARGET_ACCESS } from "../src/shared/contracts.js";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const NEXT_TARGET_ID = "22222222-2222-4222-8222-222222222222";
const GATEWAY_ID = "33333333-3333-4333-8333-333333333333";
const NEXT_GATEWAY_ID = "44444444-4444-4444-8444-444444444444";

test("BrowserCommandKeyAppLifecycle sets and replaces active target context before classification", async () => {
  let gatewayId: string | undefined = GATEWAY_ID;
  const lifecycle = new BrowserCommandKeyAppLifecycle({
    getActiveGatewayId: () => gatewayId,
  });
  const fetchCalls: unknown[] = [];

  lifecycle.setActiveTargetContext(TARGET_ID);
  gatewayId = NEXT_GATEWAY_ID;
  lifecycle.setActiveTargetContext(NEXT_TARGET_ID);

  const classification = await lifecycle.fetchOrganizationKeyClassification({
    reason: "hello_ack",
    fetchAvailableCommandSigningKeys: async (options) => {
      fetchCalls.push(options);
      return [
        makeKey("cl:nexttargetkey12345", {
          computeTargetId: NEXT_TARGET_ID,
          gatewayId: NEXT_GATEWAY_ID,
          access: BROWSER_KEY_TARGET_ACCESS.OwnedTarget,
        }),
      ];
    },
  });

  assert.deepEqual(lifecycle.getActiveTargetContext(), {
    computeTargetId: NEXT_TARGET_ID,
    gatewayId: NEXT_GATEWAY_ID,
  });
  assert.deepEqual(fetchCalls, [
    {
      requireApiKey: true,
      targetContext: {
        computeTargetId: NEXT_TARGET_ID,
        gatewayId: NEXT_GATEWAY_ID,
      },
    },
  ]);
  assert.equal(classification.kind, "all_scoped");
  assert.deepEqual(
    classification.notificationKeys.map((key) => key.fingerprint),
    ["cl:nexttargetkey12345"]
  );
});

test("profile reset clears stale target context and legacy contextless approvals before later decisions", () => {
  const lifecycle = new BrowserCommandKeyAppLifecycle({
    getActiveGatewayId: () => GATEWAY_ID,
  });
  let stopCount = 0;
  lifecycle.setActiveTargetContext(TARGET_ID);
  lifecycle.rememberLegacyContextlessApproval("cl:legacyapproval123");

  resetBrowserCommandKeyProfileState({
    lifecycle,
    stopReconciliation: () => {
      stopCount += 1;
    },
    reason: "active_config_deleted",
  });

  assert.equal(stopCount, 1);
  assert.equal(lifecycle.getActiveTargetContext(), undefined);
  assert.equal(
    lifecycle.selectOrganizationCommandKeyForManualApproval({
      keys: [makeKey("cl:legacyapproval123")],
      fingerprint: "cl:legacyapproval123",
    }),
    null
  );
});

test("target context replacement clears remembered legacy contextless approvals", () => {
  let gatewayId: string | undefined = GATEWAY_ID;
  const lifecycle = new BrowserCommandKeyAppLifecycle({
    getActiveGatewayId: () => gatewayId,
  });
  const legacyKey = makeKey("cl:legacyapproval123");

  lifecycle.setActiveTargetContext(TARGET_ID);
  lifecycle.rememberLegacyContextlessApproval("cl:legacyapproval123");
  gatewayId = NEXT_GATEWAY_ID;
  lifecycle.setActiveTargetContext(NEXT_TARGET_ID);

  assert.deepEqual(lifecycle.getActiveTargetContext(), {
    computeTargetId: NEXT_TARGET_ID,
    gatewayId: NEXT_GATEWAY_ID,
  });
  assert.equal(
    lifecycle.selectOrganizationCommandKeyForManualApproval({
      keys: [legacyKey],
      fingerprint: "cl:legacyapproval123",
    }),
    null
  );
});

test("manual approval selection uses contextless legacy marker only until it is consumed", () => {
  const lifecycle = new BrowserCommandKeyAppLifecycle({
    getActiveGatewayId: () => GATEWAY_ID,
  });
  lifecycle.setActiveTargetContext(TARGET_ID);
  const legacyKey = makeKey("cl:legacyapproval123");
  const scopedKey = makeKey("cl:scopedapproval123", {
    computeTargetId: TARGET_ID,
    gatewayId: GATEWAY_ID,
    access: BROWSER_KEY_TARGET_ACCESS.OwnedTarget,
  });

  assert.equal(
    lifecycle.selectOrganizationCommandKeyForManualApproval({
      keys: [legacyKey, scopedKey],
      fingerprint: "cl:legacyapproval123",
    }),
    null
  );

  lifecycle.rememberLegacyContextlessApproval("cl:legacyapproval123");

  assert.equal(
    lifecycle.selectOrganizationCommandKeyForManualApproval({
      keys: [legacyKey, scopedKey],
      fingerprint: "cl:legacyapproval123",
    }),
    legacyKey
  );

  lifecycle.consumeLegacyContextlessApproval("cl:legacyapproval123");

  assert.equal(
    lifecycle.selectOrganizationCommandKeyForManualApproval({
      keys: [legacyKey, scopedKey],
      fingerprint: "cl:legacyapproval123",
    }),
    null
  );
});

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
    ownerName: "Org User",
    ...(targetContext === undefined ? {} : { targetContext }),
  };
}
