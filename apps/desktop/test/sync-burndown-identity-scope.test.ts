/**
 * @file sync-burndown-identity-scope.test.ts
 * @description The signed-in identity decides which template sessions the
 * invocation lane owes, so it is part of a burn-down sample's scope. On an
 * unpaired machine every source key is null for every identity, so without it an
 * account switch would be invisible: the old identity's snapshot would still be
 * served, and the next sample diffed against it.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { SyncBurndownReporter } from "../src/main/sync/sync-burndown-reporter.js";
import type { SignedInUserIdentity } from "../src/main/util/user-identity.js";
import { emptySample, TEMPLATE_KEY } from "./sync-burndown-reporter-harness.js";

test("an identity change with every key null invalidates the latest snapshot", async () => {
  let identity: SignedInUserIdentity | null = {
    userId: "user-a",
    organizationId: "org-a",
  };
  const reporter = new SyncBurndownReporter({
    getSource: () => ({
      readSyncBurndown: () => Promise.resolve(emptySample()),
    }),
    getSessionSourceKey: () => null,
    getInvocationSourceKey: () => null,
    invocationTemplateSourceKey: TEMPLATE_KEY,
    getComponentSourceKey: () => null,
    getTranscriptComputeTargetId: () => null,
    getIdentity: () => identity,
    isSessionLaneRunning: () => false,
    isInvocationLaneRunning: () => false,
    isTranscriptLaneRunning: () => false,
    isComponentLaneRunning: () => false,
    isLaneDeliveryConsented: () => true,
    log: () => undefined,
    now: () => new Date("2026-08-06T12:00:00.000Z"),
  });
  await reporter.sampleOnce();
  assert.notEqual(reporter.getLatestSnapshot(), null);

  identity = { userId: "user-b", organizationId: "org-b" };

  assert.equal(reporter.getLatestSnapshot(), null);
});
