/**
 * @file desktop-sync-lane-composition-consent.test.ts
 * @description ISS-8768 (whitlockk review) — `laneDeliveryConsented` is the ONLY
 * thing that separates a metadata-tier user's deliberately-local transcript
 * lane from a genuinely gated one. `sync-burndown-gated-backlog.test.ts` pins
 * the reporter's REACTION to that answer with a harness that INJECTS the
 * per-lane verdict (`consentedLanes: (lane) => lane !== SyncLaneId.TranscriptArchive`),
 * so it stays green even if this composition regressed to treating metadata-tier
 * permission alone as transcript consent — the exact defect the function's own
 * docstring exists to prevent. This file drives the real function instead.
 */
import assert from "node:assert/strict";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { test } from "vitest";
import { laneDeliveryConsented } from "../src/main/agent-sync/desktop-sync-lane-composition.js";
import { SyncLaneId } from "../src/shared/sync-burndown-contract.js";
import { fakeDesktopSyncLaneDeps } from "./fake-desktop-sync-lane-deps.js";

test("ISS-8768: a metadata-tier machine is consented for session metadata but NOT transcripts", () => {
  const deps = fakeDesktopSyncLaneDeps({
    isSessionMetadataSyncTierAllowed: () => true,
    getDataSyncLevel: () => DataSyncLevel.Metadata,
  });

  assert.equal(
    laneDeliveryConsented(SyncLaneId.SessionMetadata, deps),
    true,
    "metadata tier permits the session-metadata lane"
  );
  assert.equal(
    laneDeliveryConsented(SyncLaneId.TranscriptArchive, deps),
    false,
    "metadata tier deliberately keeps transcripts local — this must never read as consent"
  );
});

test("ISS-8768: a full-tier machine is consented for both session metadata and transcripts", () => {
  const deps = fakeDesktopSyncLaneDeps({
    isSessionMetadataSyncTierAllowed: () => true,
    getDataSyncLevel: () => DataSyncLevel.Full,
  });

  assert.equal(laneDeliveryConsented(SyncLaneId.SessionMetadata, deps), true);
  assert.equal(laneDeliveryConsented(SyncLaneId.TranscriptArchive, deps), true);
});

test("component INVENTORY is delivery-enabled even when the session-metadata tier is explicitly withheld", () => {
  const deps = fakeDesktopSyncLaneDeps({
    isSessionMetadataSyncTierAllowed: () => false,
    hasSyncObservabilityTierBeenSet: () => true,
  });

  assert.equal(
    laneDeliveryConsented(SyncLaneId.ComponentInventory, deps),
    true
  );
});

/**
 * The invocation-part lane is NOT carved out with component inventory: a part is
 * session-derived and the cloud rejects it `SessionMissing` until the parent
 * `session_detail` lands, so delivering it under a withheld session-metadata
 * tier would dead-letter it rather than deliver it early. Pinned here because
 * the carve-out above is one `||` away from taking this lane with it.
 */
test("the invocation-part lane is NOT carved out of session-metadata consent", () => {
  const deps = fakeDesktopSyncLaneDeps({
    isSessionMetadataSyncTierAllowed: () => false,
    hasSyncObservabilityTierBeenSet: () => true,
  });

  assert.equal(laneDeliveryConsented(SyncLaneId.InvocationParts, deps), false);
});

test("ISS-8768: session-metadata tier denial (an explicit present tier) withholds consent for every axis it gates", () => {
  const deps = fakeDesktopSyncLaneDeps({
    isSessionMetadataSyncTierAllowed: () => false,
    hasSyncObservabilityTierBeenSet: () => true,
    getDataSyncLevel: () => DataSyncLevel.Full,
  });

  assert.equal(laneDeliveryConsented(SyncLaneId.SessionMetadata, deps), false);
  assert.equal(
    laneDeliveryConsented(SyncLaneId.TranscriptArchive, deps),
    false,
    "the outer session-metadata gate is ANDed into the transcript answer too"
  );
});

/**
 * ISS-8768 (marisolashgrove review, operator decision) — ABSENT is not the same
 * as NULL. `getSyncObservabilityTier()` cannot tell "never asked" (the key is
 * absent) from "explicitly answered not yet" (a present `null`) —
 * `DEFAULT_DESKTOP_SETTINGS.syncObservabilityTier` is itself `null`, so both
 * read back the same value, and `isSessionMetadataSyncTierAllowed` is `false`
 * either way (egress must fail closed on both). This pair is the one that
 * matters: same `isSessionMetadataSyncTierAllowed: () => false` on both
 * fixtures, the ONLY difference is `hasSyncObservabilityTierBeenSet`, and the
 * detector's answer must differ — absent fires (this is the never-onboarded-
 * but-collecting machine ISS-8768 exists to catch), present-null stays silent
 * (an authoritative refusal the detector must respect).
 */
test("ISS-8768: a never-asked machine (tier key ABSENT) reads as consented — the detector must fire on it", () => {
  const deps = fakeDesktopSyncLaneDeps({
    isSessionMetadataSyncTierAllowed: () => false,
    hasSyncObservabilityTierBeenSet: () => false,
    // getDataSyncLevel() genuinely defaults to RECOMMENDED_DATA_SYNC_LEVEL
    // (full) when the level key is also unset — this is what the install this
    // ticket cites actually showed on its Data & Sync tab.
    getDataSyncLevel: () => DataSyncLevel.Full,
  });

  assert.equal(
    laneDeliveryConsented(SyncLaneId.SessionMetadata, deps),
    true,
    "never having been asked must not read as a refusal — this is the machine the ticket exists for"
  );
  assert.equal(laneDeliveryConsented(SyncLaneId.TranscriptArchive, deps), true);
});

test("ISS-8768: a present-but-null tier (an explicit 'not yet') stays silent — same inputs otherwise as the ABSENT case above", () => {
  const deps = fakeDesktopSyncLaneDeps({
    isSessionMetadataSyncTierAllowed: () => false,
    hasSyncObservabilityTierBeenSet: () => true,
    getDataSyncLevel: () => DataSyncLevel.Full,
  });

  assert.equal(
    laneDeliveryConsented(SyncLaneId.SessionMetadata, deps),
    false,
    "an explicit 'not yet' is an authoritative choice the detector must respect, not override"
  );
  assert.equal(
    laneDeliveryConsented(SyncLaneId.TranscriptArchive, deps),
    false
  );
});
