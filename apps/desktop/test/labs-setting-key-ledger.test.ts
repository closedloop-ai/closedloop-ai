/**
 * @file labs-setting-key-ledger.test.ts
 * @description ISS-6523 — the retirement sweep as a gate rather than a
 * convention.
 *
 * Retiring a Labs toggle needs four edits and only three of them break the
 * build, so the fourth — the `RETIRED_LABS_SETTING_KEYS` entry that deletes the
 * key from an upgrading profile — is the one that gets missed. Two lanes missed
 * it on three flags in one night.
 *
 * The claim under test is STORE absence, not panel absence. The ISS-5820 lane
 * already had a test for its retired key and it was a false green: it asserted
 * the key was gone from the Labs PANEL, which stays true forever while the
 * persisted residue keeps bleeding through `SettingsStore.getAll()`. Every
 * assertion here goes through the store.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  describeLabsSettingKeyViolations,
  findLabsSettingKeyLedgerViolations,
  LABS_SETTING_KEY_LEDGER,
  LabsSettingKeyViolationKind,
  RETIRED_LABS_SETTING_KEYS,
} from "../src/main/settings/labs-setting-key-ledger.js";
import { FEATURE_FLAGS } from "../src/shared/feature-flags.js";
import {
  cleanupFeatureFlagStores,
  makeFeatureFlagStore,
} from "./feature-flags-store-fixture.js";

afterEach(cleanupFeatureFlagStores);

const REGISTRY_KEYS = FEATURE_FLAGS.map((def) => def.key);

// A failure that does not name the key, the array and the file is a failure that
// makes the reader go find the contract — the thing this gate exists to replace.
const SWEEP_ARRAY_PATTERN = /RETIRED_LABS_SETTING_KEYS/;
const LEDGER_MODULE_PATTERN = /labs-setting-key-ledger\.ts/;
const LEDGER_ARRAY_PATTERN = /LABS_SETTING_KEY_LEDGER/;
const RETIRED_FIXTURE_KEY_PATTERN = /grid-table-v2/;

/**
 * The ledger's append-only property, pinned OUTSIDE the ledger module.
 *
 * Every violation `findLabsSettingKeyLedgerViolations` reports is derived from
 * the registry, the sweep and the ledger, so a key deleted from ALL of them is
 * invisible to it: a retiring lane that drops the registry entry and the ledger
 * line in the same change — both now match the same grep for the flag key —
 * walks straight past the gate, which is the exact ISS-6523 defect. "Never
 * delete an entry" in the module docstring is prose, and prose is what this
 * ticket exists to replace.
 *
 * This pins CONTENT, not cardinality. A count floor was the first attempt and a
 * reviewer showed it buys less than it looks: `>=` goes permanently slack the
 * next time any flag is registered, and even while tight it is defeated by
 * deleting one key and adding another in the same change, which is a shape this
 * very branch has.
 *
 * The witness is reconciled with the ledger in BOTH directions, and the second
 * direction is what keeps it a witness at all (wongk, PR #5117). A subset-only
 * assertion never advances: it is a snapshot of the keys that existed the day it
 * was written, so every flag registered after that day is outside it forever and
 * can later be dropped from the registry AND the ledger with no sweep entry
 * while this file stays green — the very hole the gate claims to close, left
 * open for all future flags. Requiring the ledger to be a subset of the witness
 * too makes registering a flag fail until the witness records it, so the witness
 * covers today's flags rather than 2026-08-14's.
 *
 * The alternative wongk offered — diffing ledger deletions against git history —
 * was rejected deliberately: it would make a unit test depend on a `.git`
 * directory and on history depth, and CI's shallow clone is exactly where that
 * dependency degrades into a silent no-op. A guard that quietly stops checking
 * on the machine that matters is the failure mode this ticket exists to remove,
 * not a fix for it.
 *
 * It lives HERE, not beside the array, so one edit cannot remove both a key and
 * the record of it. No in-repo witness is immune to a determined co-deletion
 * across two files; the goal is to make the omission loud, not impossible.
 */
const LEDGER_HISTORICAL_KEYS: readonly string[] = [
  "agent-collaboration-network",
  "agentCoachingPacks",
  "agentCoachingTips",
  "agents-count-column-alignment",
  "agents-default-sort-usage",
  "agents-definition-empty-state-honesty",
  "agents-detail-honesty",
  "agents-invocations-dedupe",
  "agents-loc-per-dollar-display",
  "agents-source-provenance-honesty",
  "agents-type-tab-overflow",
  "agentsNav",
  "auditBot",
  "branch-timeline-cost-fallback-marker",
  "chart-distinguishable-series",
  "cloud-read-cutover-gate",
  "cloudCommandsPaused",
  "cloudConnectionEnabled",
  "collapsible-import-splash",
  "collectClaudeEnabled",
  "collectCopilotEnabled",
  "collectCursorEnabled",
  "commandSigningEnforcementEnabled",
  "component-versions-truncated",
  "compute-progress-count",
  "db-ahead-banner",
  "detail-route-loading-state",
  "docsHelp",
  "grid-table-v2",
  "grid-table-width-budget",
  "guest-onboarding",
  "insights-spend-outcome",
  "labsNav",
  "localSessionAuthoredPrGate",
  "loopCompletedNotificationsEnabled",
  "member-self-service-install",
  "metric-delta-unified-pill",
  "opencode-withheld-diagnostics",
  "planExtractionEnabled",
  "requestsLiveRefresh",
  "routines",
  "session-activity-phases",
  "session-detail-read-source",
  "session-duration-unmeasurable-span",
  "session-linked-artifacts-reachable",
  "session-loc-pr-attribution",
  "session-phase-confidence-disclosure",
  "session-timeline-axis-reconciliation",
  "session-timeline-column-hit-target",
  "session-timeline-jump-feedback",
  "session-timeline-synthesized-cost",
  "session-trace-slash-command-chip",
  "sessionCompletionNotifications",
  "sessions-branches-tab-titles",
  "sessions-cost-billing-honesty",
  "sessions-detail-prototype-parity",
  "sessions-displayed-status-parity",
  "sessions-grid-fold-legibility",
  "sessions-honest-unknown-states",
  "sessions-owner-name-resolution",
  "sessions-row-qualifiers-column",
  "sessions-row-state-chip-parity",
  "sessions-status-pill-sync-state",
  "sessions-subagent-transcript-disclosure",
  "sessions-summary-honest-loading",
  "sessions-transcript-sync-status",
  "showRedactedSyncLevel",
  "startupReadinessExperience",
  "stoppedLaneReadiness",
  "subscriptionSessionLimits",
  "summary-strip-column-cardinality",
  "summary-strip-density",
  "summary-strip-density-tier",
  "transcriptSyncEnabled",
  "updateAndRestartEnabled",
  "valueNumeratorV2",
  "verboseLogging",
];

test("ISS-6523: the live registry, the retirement sweep and the ledger reconcile", () => {
  const violations = findLabsSettingKeyLedgerViolations({
    registryKeys: REGISTRY_KEYS,
    retiredKeys: RETIRED_LABS_SETTING_KEYS,
    ledgerKeys: LABS_SETTING_KEY_LEDGER,
  });

  assert.deepEqual(
    violations,
    [],
    `\n${describeLabsSettingKeyViolations(violations)}`
  );
});

test("ISS-6523: the ledger is append-only — entries are never deleted", () => {
  const present = new Set(LABS_SETTING_KEY_LEDGER);
  const dropped = LEDGER_HISTORICAL_KEYS.filter((key) => !present.has(key));

  assert.deepEqual(
    dropped,
    [],
    `LABS_SETTING_KEY_LEDGER no longer carries: ${dropped.join(", ")}. The ledger is the only record that survives a retirement, so deleting an entry is indistinguishable from the omission this gate exists to catch, and it re-opens the persisted-residue bleed on every install that has not launched since the toggle existed. Restore the entry in apps/desktop/src/main/settings/labs-setting-key-ledger.ts.`
  );
  // A key could otherwise be "kept" by duplicating a neighbour rather than restored.
  assert.equal(
    new Set(LABS_SETTING_KEY_LEDGER).size,
    LABS_SETTING_KEY_LEDGER.length,
    "LABS_SETTING_KEY_LEDGER must not contain duplicate keys"
  );
});

test("ISS-6523: the witness advances with the ledger — a new key is recorded in both", () => {
  // The half that keeps the assertion above from decaying into a snapshot of
  // 2026-08-14. Without it, a flag registered tomorrow is outside the witness
  // forever and can be dropped from the registry and the ledger together with
  // nothing to strand it.
  const witnessed = new Set(LEDGER_HISTORICAL_KEYS);
  const unwitnessed = LABS_SETTING_KEY_LEDGER.filter(
    (key) => !witnessed.has(key)
  );

  assert.deepEqual(
    unwitnessed,
    [],
    `LABS_SETTING_KEY_LEDGER carries keys the independent witness does not: ${unwitnessed.join(", ")}. Add each to LEDGER_HISTORICAL_KEYS in this file. The witness is what survives a co-deletion of the registry entry and the ledger line, so a key that never reaches it is a key whose later removal nothing can detect.`
  );
  assert.equal(
    new Set(LEDGER_HISTORICAL_KEYS).size,
    LEDGER_HISTORICAL_KEYS.length,
    "LEDGER_HISTORICAL_KEYS must not contain duplicate keys"
  );
});

test("ISS-6523: a still-registered flag may not also be swept", () => {
  // Counterfactual for the third violation kind, driven through the production
  // decision with a live registry key injected into the sweep.
  const liveKey = REGISTRY_KEYS[0];
  const violations = findLabsSettingKeyLedgerViolations({
    registryKeys: REGISTRY_KEYS,
    retiredKeys: [...RETIRED_LABS_SETTING_KEYS, liveKey],
    ledgerKeys: LABS_SETTING_KEY_LEDGER,
  });

  assert.deepEqual(
    violations.map((violation) => violation.kind),
    [LabsSettingKeyViolationKind.StillRegisteredButSwept]
  );
  assert.equal(violations[0].key, liveKey);
});

test("ISS-6523: a flag removed from the registry with no sweep entry is reported", () => {
  // The counterfactual the ticket asks for, run against the REAL ledger with one
  // key withheld from the registry — exactly the shape of a retirement that
  // edited feature-flags.ts and contracts.ts but not the sweep.
  const retiredWithoutSweep = "grid-table-v2";
  assert.ok(
    LABS_SETTING_KEY_LEDGER.includes(retiredWithoutSweep),
    "fixture key must be in the ledger for this counterfactual to mean anything"
  );

  const violations = findLabsSettingKeyLedgerViolations({
    registryKeys: REGISTRY_KEYS.filter((key) => key !== retiredWithoutSweep),
    retiredKeys: RETIRED_LABS_SETTING_KEYS,
    ledgerKeys: LABS_SETTING_KEY_LEDGER,
  });

  assert.deepEqual(
    violations.map((violation) => violation.key),
    [retiredWithoutSweep]
  );
  assert.equal(
    violations[0].kind,
    LabsSettingKeyViolationKind.SweepEntryMissing
  );
  // The failure has to name the key AND the array to edit, or it just says no.
  assert.match(violations[0].remedy, SWEEP_ARRAY_PATTERN);
  assert.match(violations[0].remedy, LEDGER_MODULE_PATTERN);
  assert.match(violations[0].remedy, RETIRED_FIXTURE_KEY_PATTERN);
});

test("ISS-6523: adding the sweep entry clears the violation", () => {
  const retired = "grid-table-v2";

  const violations = findLabsSettingKeyLedgerViolations({
    registryKeys: REGISTRY_KEYS.filter((key) => key !== retired),
    retiredKeys: [...RETIRED_LABS_SETTING_KEYS, retired],
    ledgerKeys: LABS_SETTING_KEY_LEDGER,
  });

  assert.deepEqual(violations, []);
});

test("ISS-6523: a newly registered flag missing from the ledger is reported", () => {
  // The ledger cannot be allowed to silently fall behind: a key that never
  // arrives in it can later leave the registry with nothing to strand.
  const violations = findLabsSettingKeyLedgerViolations({
    registryKeys: [...REGISTRY_KEYS, "iss6523-unledgered-flag"],
    retiredKeys: RETIRED_LABS_SETTING_KEYS,
    ledgerKeys: LABS_SETTING_KEY_LEDGER,
  });

  assert.deepEqual(
    violations.map((violation) => violation.key),
    ["iss6523-unledgered-flag"]
  );
  assert.equal(
    violations[0].kind,
    LabsSettingKeyViolationKind.LedgerEntryMissing
  );
  assert.match(violations[0].remedy, LEDGER_ARRAY_PATTERN);
});

test("ISS-6523: a key that is both registered and swept is reported missing from the ledger ONCE", () => {
  // thadeusb, PR #5117: the registry and the sweep are checked against the
  // ledger in one pass, and a key in BOTH — the `StillRegisteredButSwept`
  // shape — used to be visited twice, so its single missing ledger entry was
  // printed as two identical remedies for the same key.
  const bothAndUnledgered = "iss6523-registered-and-swept-flag";

  const violations = findLabsSettingKeyLedgerViolations({
    registryKeys: [...REGISTRY_KEYS, bothAndUnledgered],
    retiredKeys: [...RETIRED_LABS_SETTING_KEYS, bothAndUnledgered],
    ledgerKeys: LABS_SETTING_KEY_LEDGER,
  });

  const ledgerEntryMissing = violations.filter(
    (violation) =>
      violation.kind === LabsSettingKeyViolationKind.LedgerEntryMissing
  );
  assert.deepEqual(
    ledgerEntryMissing.map((violation) => violation.key),
    [bothAndUnledgered],
    "one absent ledger entry is one violation, however many sources name the key"
  );
  // The genuinely separate problem — live AND swept — is still reported.
  assert.deepEqual(
    violations.map((violation) => violation.kind),
    [
      LabsSettingKeyViolationKind.LedgerEntryMissing,
      LabsSettingKeyViolationKind.StillRegisteredButSwept,
    ]
  );
});

test("ISS-6523: every swept key is deleted from an upgrading profile's persisted STORE", () => {
  // The assertion the ISS-5820 false-green did not make. Seed a profile that
  // carries EVERY retired key — the state an install that toggled them is
  // actually in — boot the store, and require getAll() to report none of them.
  // A panel-absence assertion stays green through all of this.
  //
  // `settings-migration-retired-labs-keys.test.ts` covers the same deletion
  // per key, and documents WHY each one retired. This batch pass is the safety
  // net for entries that never get their own narrative test: it reads straight
  // off the array, so a newly swept key is covered the moment it is added.
  const seed: Record<string, unknown> = {};
  for (const key of RETIRED_LABS_SETTING_KEYS) {
    seed[key] = false;
  }
  const store = makeFeatureFlagStore(seed);

  const all = store.getAll() as Record<string, unknown>;
  const bleeding = RETIRED_LABS_SETTING_KEYS.filter((key) => key in all);

  assert.deepEqual(
    bleeding,
    [],
    `Retired keys still reported by getAll(): ${bleeding.join(", ")}. removeRetiredKeys did not delete them from the persisted store.`
  );
});

test("ISS-6523: a stale key left in a persisted profile reddens the store assertion", () => {
  // Proves the assertion above is load-bearing rather than vacuous: a retired
  // key that is NOT swept survives the boot migration and getAll() reports it.
  // This is the residue the sweep exists to remove, reproduced deliberately.
  // Widened to `string` deliberately. The sweep array is a readonly tuple of
  // literals, so a key that is by construction NOT one of them makes both
  // `.includes(key)` and a `===` against the narrowed literal a type error
  // (TS2367, "no overlap") — the type system objecting to the very premise the
  // fixture needs. Widening states that premise instead of casting around it.
  const unsweptKey: string = "iss6523-never-swept-residue";
  assert.ok(
    !RETIRED_LABS_SETTING_KEYS.some((key) => key === unsweptKey),
    "the fixture key must not be swept, or this proves nothing"
  );

  const store = makeFeatureFlagStore({ [unsweptKey]: false });
  const all = store.getAll() as Record<string, unknown>;

  assert.ok(
    unsweptKey in all,
    "an unswept persisted key must bleed through getAll() — if it does not, the sibling test cannot fail either"
  );
  assert.equal(all[unsweptKey], false);
});
