/**
 * @file labs-setting-key-ledger.test.ts
 * @description ISS-6523 — the retirement sweep as a gate rather than a
 * convention. ISS-8071 — the edit-site manifest, because this file is the one a
 * lane adding a Labs key reads, and it was believed to be the whole contract.
 *
 * Retiring a Labs toggle needs FIVE edits — the registry entry, the
 * `DesktopSettings` member, its `DEFAULT_DESKTOP_SETTINGS` default, the
 * `REGISTRY_MEMBERSHIP_WITNESS` line, and the `RETIRED_LABS_SETTING_KEYS` entry — and
 * only the last leaves nothing behind when it is skipped. The other four are
 * load-bearing for `tsc` or for a sibling suite, so they get done; the sweep
 * entry that deletes the key from an upgrading profile is the one that gets
 * missed. Two lanes missed it on three flags in one night.
 *
 * The claim under test is STORE absence, not panel absence. The ISS-5820 lane
 * already had a test for its retired key and it was a false green: it asserted
 * the key was gone from the retired settings tab, which stayed true forever while the
 * persisted residue keeps bleeding through `SettingsStore.getAll()`. Every
 * assertion here goes through the store.
 *
 * ADDING ONE LABS SETTING KEY COSTS SIX EDITS, NOT FIVE. "Five" was the working
 * number until the ISS-8024 lane (PR #5989) made the five it knew about, ran
 * THIS suite, saw green, and was failed by a sixth site this file had never
 * looked at. Each site below is listed with the guard that reddens when it is
 * skipped, verified by adding a synthetic key and omitting one site at a time
 * (ISS-8071):
 *
 *  1. `FEATURE_FLAGS` — `apps/desktop/src/shared/feature-flags.ts`, or the
 *     sibling module that owns the concern. The subject of the other five.
 *     Guard: this file (a ledgered key in neither the registry nor the sweep is
 *     a missing sweep entry) plus `feature-flags-registry-composition.test.ts`.
 *  2. The `DesktopSettings` member — `apps/desktop/src/shared/contracts.ts`.
 *     Guard: `tsc` ALONE. The type is erased before any test runs, so no suite
 *     can see this one; omitting it is TS2353 on the defaults literal.
 *  3. The `DEFAULT_DESKTOP_SETTINGS` entry — same file. Guard: `tsc` (TS2741)
 *     plus `feature-flags-registry-plumbing.test.ts`, which requires `getAll()`
 *     to answer a boolean for every registered flag on a fresh profile.
 *  4. `LABS_SETTING_KEY_LEDGER` — `src/main/settings/labs-setting-key-ledger.ts`.
 *     Guard: this file.
 *  5. `LEDGER_HISTORICAL_KEYS` — below in this file. Guard: this file.
 *  6. `REGISTRY_MEMBERSHIP_WITNESS` — `test/feature-flags-registry-membership-witness.ts`.
 *     THE SIXTH SITE, and the one the five-edit folklore omits.
 *     Membership is guarded here, and duplicate keys are guarded by
 *     `feature-flags-registry-composition.test.ts`.
 *
 * A SEVENTH edit exists for the SHARED web+desktop class only — the kebab-case
 * keys aliasing a `@repo/api` leaf constant `apps/app` imports too. Those also
 * need `packages/api/src/types/<key>-flag.ts` and a parity row in
 * `feature-flags-cross-surface.test.ts`, whose rows are hand-maintained: a
 * shared key with no row there is reported by nothing. A desktop-owned key needs
 * none of it, which is why the count above is six.
 *
 * Declaring the key as its own exported constant module is a CONVENTION, not a
 * seventh site: inlining the literal at the registry entry was verified to keep
 * every suite and both typecheck projects green.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  describeLabsSettingKeyViolations,
  findLabsSettingKeyLedgerViolations,
  LABS_SETTING_KEY_LEDGER,
  LabsSettingKeyViolationKind,
  RETIRED_LABS_SETTING_KEYS,
} from "../src/main/settings/labs-setting-key-ledger.js";
import { FEATURE_FLAGS } from "../src/shared/feature-flags.js";
import { REGISTRY_MEMBERSHIP_WITNESS } from "./feature-flags-registry-membership-witness.js";
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
const RETIRED_FIXTURE_KEY_PATTERN = /branches-pinned-name-column/;

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
 * direction is what keeps it a witness at all (whitlockk, PR #5117). A subset-only
 * assertion never advances: it is a snapshot of the keys that existed the day it
 * was written, so every flag registered after that day is outside it forever and
 * can later be dropped from the registry AND the ledger with no sweep entry
 * while this file stays green — the very hole the gate claims to close, left
 * open for all future flags. Requiring the ledger to be a subset of the witness
 * too makes registering a flag fail until the witness records it, so the witness
 * covers today's flags rather than 2026-08-14's.
 *
 * The alternative whitlockk offered — diffing ledger deletions against git history —
 * was rejected deliberately: it would make a unit test depend on a `.git`
 * directory and on history depth, and CI's shallow clone is exactly where that
 * dependency degrades into a silent no-op. A guard that quietly stops checking
 * on the machine that matters is the failure mode this ticket exists to remove,
 * not a fix for it.
 *
 * It lives HERE, not beside the array, so one edit cannot remove both a key and
 * the record of it. No in-repo witness is immune to a determined co-deletion
 * across two files; the goal is to make the omission loud, not impossible.
 *
 * NEVER DERIVE THIS FROM `LABS_SETTING_KEY_LEDGER`. It is a hand-written literal
 * on purpose, and that is the whole guard: a witness computed from the array it
 * polices agrees with whatever that array currently is, so it stays green
 * through a DELETION — precisely the omission it exists to catch. Replacing this
 * literal with `[...LABS_SETTING_KEY_LEDGER]` deletes the gate and leaves every
 * test in this file green.
 */
const LEDGER_HISTORICAL_KEYS: readonly string[] = [
  "activity-coverage-diagnostics",
  "agent-collaboration-network",
  "agent-type-roster-incomplete",
  "agentCoachingPacks",
  "agentCoachingTips",
  "agents-bounded-page-data",
  "agents-card-attribute-labels",
  "agents-count-column-alignment",
  "agents-default-sort-usage",
  "agents-definition-empty-state-honesty",
  "agents-detail-honesty",
  "agents-invocations-dedupe",
  "agents-loc-per-dollar-display",
  "agents-source-provenance-honesty",
  "agents-type-tab-overflow",
  "agentsNav",
  "artifact-cell-primitives",
  "eligible-branch-navigation",
  "auditBot",
  "boot-import-degraded-terminal",
  "branch-detail-measured-checks",
  "branch-detail-metric-honesty",
  "branch-detail-pr-base-and-author",
  "branch-timeline-cost-fallback-marker",
  "branches-cohort-transparency",
  "branches-cost-coverage-agreement",
  "branches-pinned-name-column",
  "branches-summary-honest-loading",
  "branches-server-pagination",
  "chart-distinguishable-series",
  "claudeCodeOtelCapture",
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
  "custom-field-editor-contracts",
  "db-ahead-banner",
  "desktopPosthogFlags",
  "detail-route-loading-state",
  "docsHelp",
  "github-clerk-credentials",
  "grid-table-v2",
  "grid-table-width-budget",
  "guest-onboarding",
  "insights-spend-outcome",
  "labsNav",
  "localSessionAuthoredPrGate",
  "loopCompletedNotificationsEnabled",
  "member-self-service-install",
  "metric-delta-neutral-pill",
  "metric-delta-unified-pill",
  "opencode-withheld-diagnostics",
  "planExtractionEnabled",
  "requestsLiveRefresh",
  "routines",
  "session-activity-phases",
  "session-claude-reported-cost",
  "session-detail-read-source",
  "session-duration-unmeasurable-span",
  "session-launch-attribution",
  "session-linked-artifacts-reachable",
  "session-loc-pr-attribution",
  "session-metric-population-disclosure",
  "session-phase-confidence-disclosure",
  "session-timeline-axis-reconciliation",
  "session-timeline-column-hit-target",
  "session-timeline-coverage-disclosure",
  "session-timeline-jump-feedback",
  "session-timeline-source-extent",
  "session-timeline-synthesized-cost",
  "session-tokens-recorded-honesty",
  "session-touched-branches",
  "session-trace-evidence-disclosure",
  "session-trace-idle-rows",
  "session-trace-slash-command-chip",
  "session-transcript-never-expected",
  "sessionCompletionNotifications",
  "sessions-branches-tab-titles",
  "sessions-change-pr-filters",
  "sessions-comment-count-tag",
  "sessions-cost-billing-honesty",
  "sessions-cost-breakdown",
  "sessions-custom-date-window",
  "sessions-delivery-card-no-data",
  "sessions-detail-prototype-parity",
  "sessions-displayed-status-parity",
  "sessions-grid-fold-legibility",
  "sessions-honest-unknown-states",
  "sessions-loc-per-dollar-coverage",
  "sessions-merged-loc-rung",
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
  "tag-create-color",
  "terminalInstallFailureNotifications",
  "threadViewershipSignal",
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
  const retiredWithoutSweep = "branches-pinned-name-column";
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
  const retired = "branches-pinned-name-column";

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
  // tamsinb, PR #5117: the registry and the sweep are checked against the
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

test("ISS-8071: the registry membership witness is the sixth edit site, reconciled here", () => {
  // The site the five-edit folklore omits. Checked in BOTH directions for the
  // same reason the ledger is: a registry key missing from the witness is an
  // ADDITION that skipped the site (the PR #5989 shape), and a witness key
  // missing from the registry is a RETIREMENT that did.
  //
  // The overlap is the point: a lane reads THIS file, so a site named here only
  // in prose is a site that rots, and a failure that does not name the file to
  // edit is the thing this gate exists to replace.
  const witnessed = new Set(REGISTRY_MEMBERSHIP_WITNESS);
  const unwitnessed = REGISTRY_KEYS.filter((key) => !witnessed.has(key));

  assert.deepEqual(
    unwitnessed,
    [],
    `Registered flags missing from REGISTRY_MEMBERSHIP_WITNESS: ${unwitnessed.join(", ")}. Add each to apps/desktop/test/feature-flags-registry-membership-witness.ts so a new registry entry cannot skip the hand-maintained witness.`
  );

  const registered = new Set(REGISTRY_KEYS);
  const stranded = REGISTRY_MEMBERSHIP_WITNESS.filter(
    (key) => !registered.has(key)
  );

  assert.deepEqual(
    stranded,
    [],
    `REGISTRY_MEMBERSHIP_WITNESS carries keys the registry does not: ${stranded.join(", ")}. A retirement removes the witness entry in the same change — the list is the pre-split membership minus retirements, not a frozen snapshot.`
  );
});
