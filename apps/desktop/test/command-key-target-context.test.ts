import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrganizationCommandPublicKey } from "../src/main/authorized-public-keys-client.js";
import {
  type ActiveCommandKeyTargetContext,
  browserCommandKeyTargetContextMatches,
  classifyOrganizationCommandKeysForTarget,
  parseBrowserCommandKeyCommandTargetContext,
  selectOrganizationCommandKeyForApproval,
} from "../src/main/command-key-target-context.js";
import { BROWSER_KEY_TARGET_ACCESS } from "../src/shared/contracts.js";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TARGET_ID = "22222222-2222-4222-8222-222222222222";
const GATEWAY_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_GATEWAY_ID = "44444444-4444-4444-8444-444444444444";
const ACTIVE_CONTEXT: ActiveCommandKeyTargetContext = {
  computeTargetId: TARGET_ID,
  gatewayId: GATEWAY_ID,
};

test("classifier treats a successful empty scoped response as full reconciliation", () => {
  const classification = classifyOrganizationCommandKeysForTarget({
    keys: [],
    activeContext: ACTIVE_CONTEXT,
    reason: "hello_ack",
  });

  assert.equal(classification.kind, "empty");
  assert.equal(classification.reconciliationMode, "full");
  assert.equal(classification.relevantKeys.length, 0);
});

test("classifier skips empty responses when active target context is absent", () => {
  const classification = classifyOrganizationCommandKeysForTarget({
    keys: [],
    reason: "periodic",
  });

  assert.equal(classification.kind, "empty");
  assert.equal(classification.reconciliationMode, "skip");
});

test("classifier accepts only matching owned_target entries for full reconciliation", () => {
  const key = makeKey("cl:ownedtargetkey12345", {
    computeTargetId: TARGET_ID,
    gatewayId: GATEWAY_ID,
    access: BROWSER_KEY_TARGET_ACCESS.OwnedTarget,
  });

  const classification = classifyOrganizationCommandKeysForTarget({
    keys: [key],
    activeContext: ACTIVE_CONTEXT,
    reason: "hello_ack",
  });

  assert.equal(classification.kind, "all_scoped");
  assert.equal(classification.reconciliationMode, "full");
  assert.deepEqual(classification.relevantKeys, [key]);
  assert.deepEqual(classification.notificationKeys, [key]);
});

test("classifier suppresses non-empty legacy broad responses", () => {
  const key = makeKey("cl:legacybroadkey123");
  const classification = classifyOrganizationCommandKeysForTarget({
    keys: [key],
    activeContext: ACTIVE_CONTEXT,
    reason: "periodic",
  });

  assert.equal(classification.kind, "legacy_broad");
  assert.equal(classification.reconciliationMode, "skip");
  assert.deepEqual(classification.notificationKeys, []);
  assert.equal(classification.diagnostics.legacyCount, 1);
});

test("classifier promotes only matching entries from mixed scoped responses", () => {
  const matching = makeKey("cl:matchingtarget1234", {
    computeTargetId: TARGET_ID,
    gatewayId: GATEWAY_ID,
    access: BROWSER_KEY_TARGET_ACCESS.OwnedTarget,
  });
  const legacy = makeKey("cl:legacybroadkey123");
  const shared = makeKey("cl:sharedtargetkey123", {
    computeTargetId: TARGET_ID,
    gatewayId: GATEWAY_ID,
    access: "shared_target",
  });
  const mismatched = makeKey("cl:mismatchedkey1234", {
    computeTargetId: OTHER_TARGET_ID,
    gatewayId: GATEWAY_ID,
    access: BROWSER_KEY_TARGET_ACCESS.OwnedTarget,
  });
  const malformed = makeKey("cl:malformedtarget12", {
    computeTargetId: TARGET_ID,
    gatewayId: null,
    access: BROWSER_KEY_TARGET_ACCESS.OwnedTarget,
  });

  const classification = classifyOrganizationCommandKeysForTarget({
    keys: [matching, legacy, shared, mismatched, malformed],
    activeContext: ACTIVE_CONTEXT,
    reason: "manual",
  });

  assert.equal(classification.kind, "mixed_scoped");
  assert.equal(classification.reconciliationMode, "promote_only");
  assert.deepEqual(classification.relevantKeys, [matching]);
  assert.deepEqual(classification.notificationKeys, [matching]);
  assert.equal(classification.ignoredKeys.length, 4);
  assert.equal(classification.diagnostics.legacyCount, 1);
  assert.equal(classification.diagnostics.invalidContextCount, 2);
  assert.equal(classification.diagnostics.mismatchedContextCount, 1);
});

test("classifier skips invalid-only scoped entries", () => {
  const classification = classifyOrganizationCommandKeysForTarget({
    keys: [
      makeKey("cl:sharedtargetkey123", {
        computeTargetId: TARGET_ID,
        gatewayId: GATEWAY_ID,
        access: "shared_target",
      }),
      makeKey("cl:gatewaymismatch12", {
        computeTargetId: TARGET_ID,
        gatewayId: OTHER_GATEWAY_ID,
        access: BROWSER_KEY_TARGET_ACCESS.OwnedTarget,
      }),
    ],
    activeContext: ACTIVE_CONTEXT,
    reason: "manual",
  });

  assert.equal(classification.kind, "invalid_only");
  assert.equal(classification.reconciliationMode, "skip");
  assert.deepEqual(classification.notificationKeys, []);
});

test("command context parser distinguishes absent, invalid, and present matching context", () => {
  assert.deepEqual(
    parseBrowserCommandKeyCommandTargetContext({
      fingerprint: "cl:abcdefghijklmnopqrstuv",
    }),
    { kind: "absent" }
  );
  assert.deepEqual(
    parseBrowserCommandKeyCommandTargetContext({
      fingerprint: "cl:abcdefghijklmnopqrstuv",
      gatewayId: GATEWAY_ID,
    }),
    { kind: "invalid" }
  );
  assert.deepEqual(
    parseBrowserCommandKeyCommandTargetContext({
      fingerprint: "cl:abcdefghijklmnopqrstuv",
      computeTargetId: TARGET_ID,
      gatewayId: null,
    }),
    { kind: "invalid" }
  );
  const present = parseBrowserCommandKeyCommandTargetContext({
    fingerprint: "cl:abcdefghijklmnopqrstuv",
    computeTargetId: TARGET_ID,
    gatewayId: GATEWAY_ID,
  });
  assert.equal(present.kind, "present");
  assert.equal(
    browserCommandKeyTargetContextMatches({
      commandContext: present,
      activeContext: ACTIVE_CONTEXT,
    }),
    true
  );
});

test("approval selection only uses legacy by-fingerprint when command context is truly absent", () => {
  const legacyKey = makeKey("cl:legacyapproval123");
  const scopedKey = makeKey("cl:scopedapproval123", {
    computeTargetId: TARGET_ID,
    gatewayId: GATEWAY_ID,
    access: BROWSER_KEY_TARGET_ACCESS.OwnedTarget,
  });

  assert.equal(
    selectOrganizationCommandKeyForApproval({
      keys: [legacyKey, scopedKey],
      fingerprint: "cl:legacyapproval123",
      activeContext: ACTIVE_CONTEXT,
      commandTargetContext: { kind: "present", context: ACTIVE_CONTEXT },
    }),
    null
  );
  assert.equal(
    selectOrganizationCommandKeyForApproval({
      keys: [legacyKey, scopedKey],
      fingerprint: "cl:legacyapproval123",
      activeContext: ACTIVE_CONTEXT,
      commandTargetContext: { kind: "absent" },
    }),
    legacyKey
  );
  assert.equal(
    selectOrganizationCommandKeyForApproval({
      keys: [legacyKey, scopedKey],
      fingerprint: "cl:scopedapproval123",
      activeContext: ACTIVE_CONTEXT,
      commandTargetContext: { kind: "present", context: ACTIVE_CONTEXT },
    }),
    scopedKey
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
