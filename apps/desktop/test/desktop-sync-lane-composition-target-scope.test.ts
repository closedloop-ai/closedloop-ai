/**
 * @file desktop-sync-lane-composition-target-scope.test.ts
 * @description ISS-8768 (whitlockk review) — after an account switch,
 * `getTranscriptComputeTargetId` (`onlineComputeTargetId`) can still name the
 * PREVIOUS account's target while `getSyncComputeTargetId` (the identity-bound
 * live-or-retained resolver) has already gone `null` for the new one, because
 * the raw online target carries no identity check at all. Building the burn-down
 * reporter's component/invocation/transcript keys from the raw online target
 * alone would keep counting the old account's backlog and could turn it into a
 * `gate_shut_with_backlog` alert attributed to whoever is signed in now.
 *
 * `identityBoundTranscriptComputeTargetId` is what `buildSyncBurndownReporter`
 * now resolves those three keys through. This file pins its three states
 * directly, since none of the reporter-level suites (which fake the whole store
 * read) would notice a regression here.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { identityBoundTranscriptComputeTargetId } from "../src/main/agent-sync/desktop-sync-lane-composition.js";
import { fakeDesktopSyncLaneDeps } from "./fake-desktop-sync-lane-deps.js";

test("ISS-8768: online and identity-bound targets agree — resolves the live target, same as before this fix", () => {
  const deps = fakeDesktopSyncLaneDeps({
    getTranscriptComputeTargetId: () => "ct-1",
    getSyncComputeTargetId: () => "ct-1",
  });

  assert.equal(identityBoundTranscriptComputeTargetId(deps), "ct-1");
});

test("ISS-8768 (whitlockk review): an account switch leaves the raw online target naming the OLD account — must resolve unmeasured, not the stale target", () => {
  const deps = fakeDesktopSyncLaneDeps({
    // The socket is still reporting the previous account's target...
    getTranscriptComputeTargetId: () => "ct-old-account",
    // ...but the identity-bound resolver has already refused it as a
    // known-foreign id for the account signed in now.
    getSyncComputeTargetId: () => null,
  });

  assert.equal(
    identityBoundTranscriptComputeTargetId(deps),
    null,
    "a target the identity-bound resolver refuses must never be used to measure a backlog"
  );
});

test("ISS-8768: offline or mid-flap — unmeasured, unchanged from before this fix", () => {
  const deps = fakeDesktopSyncLaneDeps({
    getTranscriptComputeTargetId: () => null,
    getSyncComputeTargetId: () => "ct-1-retained",
  });

  assert.equal(
    identityBoundTranscriptComputeTargetId(deps),
    null,
    "the strict-online getter going null during a flap must still leave this unmeasured, not measured against the retained id"
  );
});
