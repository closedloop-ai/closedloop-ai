import assert from "node:assert/strict";
import {
  DATA_SYNC_LEVELS,
  dataSyncLevelAllowsTranscripts,
} from "@repo/api/src/types/data-sync-level";
import { test } from "vitest";
import { syncTierAllowsTranscripts } from "../src/shared/contracts.js";
import {
  dataSyncLevelToBooleans,
  syncObservabilityTierToDataSyncLevel,
} from "../src/shared/data-sync-level.js";
import { SYNC_OBSERVABILITY_TIERS } from "../src/shared/sync-observability-tier.js";

/**
 * ISS-7516 — pin `dataSyncLevelAllowsTranscripts` to the egress gate it restates.
 *
 * `syncTierAllowsTranscripts` is the AUTHORITY: it is what actually stops the
 * transcript lane, and it speaks `SyncObservabilityTier`. The web needs the same
 * predicate over `DataSyncLevel`, because `apps/app` cannot import
 * `apps/desktop`. That is two statements of one rule, which is the SSOT-drift
 * shape this repo tracks — so the two are pinned to each other here rather than
 * left to agree by good intentions.
 *
 * ISS-6147 deleted a parity test exactly like this one by DEDUPLICATING the two
 * declarations into a shared module. That is the better fix and it is not
 * available here: the authority lives behind a package boundary the web may not
 * cross. So the parity test is the fallback, and it lives on the desktop side —
 * the only place that can import both.
 *
 * This test is what fails if someone widens the gate (say, admitting `redacted`)
 * and updates only one side. It is deliberately driven from
 * `SYNC_OBSERVABILITY_TIERS`, not a hand-written list, so a NEW tier is covered
 * the day it is added instead of silently skipped.
 */

test("every observability tier agrees with its data-sync level on transcripts", () => {
  for (const tier of SYNC_OBSERVABILITY_TIERS) {
    const level = syncObservabilityTierToDataSyncLevel(tier);

    assert.equal(
      dataSyncLevelAllowsTranscripts(level),
      syncTierAllowsTranscripts(tier),
      `tier "${tier}" maps to level "${level}", and the two predicates disagree about transcripts`
    );
  }
});

test("the agreement is a real constraint, not two constant falses", () => {
  // The POSITIVE CONTROL. The loop above would pass if BOTH predicates returned
  // false for every input — a gate that had accidentally been closed shut. This
  // pins that at least one tier genuinely allows transcripts and at least one
  // genuinely does not, so the parity assertion is discriminating.
  const verdicts = SYNC_OBSERVABILITY_TIERS.map((tier) =>
    syncTierAllowsTranscripts(tier)
  );

  assert.ok(
    verdicts.includes(true),
    "no tier allows transcripts; the parity test above would be vacuous"
  );
  assert.ok(
    verdicts.includes(false),
    "every tier allows transcripts; the parity test above would be vacuous"
  );
});

/**
 * The LEVEL-keyed pin, and the one that actually covers `redacted`.
 *
 * The tier loop above cannot: `syncObservabilityTierToDataSyncLevel` emits only
 * off/metadata/full, so `redacted` is unreachable through it. That matters
 * because `redacted` is scheduled to change — the data-sync copy says redaction
 * is coming — and when it does, the authority that moves is
 * `dataSyncLevelToBooleans(level).transcriptSyncEnabled`, which is what the
 * transcript lane's own applicability gate reads. A hardcoded
 * `assert.equal(dataSyncLevelAllowsTranscripts(Redacted), false)` would hold the
 * WRONG answer in place at exactly that moment: the lane would start uploading
 * redacted transcripts while the web kept telling readers the transcript stays
 * on the machine.
 *
 * Driven from `DATA_SYNC_LEVELS` rather than a written-out list so a new level
 * is covered the day it is added.
 */
test("every data-sync level agrees with the level-keyed transcript authority", () => {
  for (const level of DATA_SYNC_LEVELS) {
    assert.equal(
      dataSyncLevelAllowsTranscripts(level),
      dataSyncLevelToBooleans(level).transcriptSyncEnabled,
      `level "${level}" disagrees with dataSyncLevelToBooleans().transcriptSyncEnabled`
    );
  }
});

test("the level-keyed agreement is a real constraint, not two constant falses", () => {
  const verdicts = DATA_SYNC_LEVELS.map(
    (level) => dataSyncLevelToBooleans(level).transcriptSyncEnabled
  );

  assert.ok(verdicts.includes(true), "no level allows transcripts");
  assert.ok(verdicts.includes(false), "every level allows transcripts");
});
