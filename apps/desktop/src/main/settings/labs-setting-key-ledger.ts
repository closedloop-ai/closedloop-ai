/**
 * ISS-6523 — the historical record of every desktop feature-flag setting key, and
 * the reconciliation that turns the retirement sweep from a convention into a
 * gate.
 *
 * Retiring a Labs toggle takes five edits that nothing links together: remove the
 * `FEATURE_FLAGS` registry entry, remove the `DesktopSettings` member, remove the
 * `DEFAULT_DESKTOP_SETTINGS` entry, remove the `REGISTRY_MEMBERSHIP_WITNESS` line
 * in `apps/desktop/test/feature-flags-registry-membership-witness.ts`, and add the
 * key to {@link RETIRED_LABS_SETTING_KEYS} so `removeRetiredKeys` deletes it from
 * an upgrading profile's persisted store. The first four are load-bearing — three
 * for compilation, the fourth for `feature-flags-registry-composition.test.ts`
 * (and for the both-directions membership check in the ledger suite named below,
 * which strands a witness entry the registry no longer carries) — so they get
 * done. The fifth
 * is not, so it gets missed, and nothing failed when it was, because once the
 * other edits land the key leaves no trace for a check to notice. Two lanes made
 * that exact omission on three flags in one night
 * (ISS-5820 / ISS-6006 / ISS-6118).
 *
 * ADDING one costs SIX edits, and the enumeration with the guard that reddens
 * for each lives in `apps/desktop/test/labs-setting-key-ledger.test.ts`
 * (ISS-8071). "Five" was the working number here until PR #5989 was failed by
 * the sixth.
 *
 * The cost is silent, unbounded, persisted-data drift. electron-store's `.store`
 * getter returns the raw persisted JSON including any key never explicitly
 * deleted, and `SettingsStore.getAll()` spreads it, so a profile that ever
 * touched the toggle keeps bleeding a no-longer-typed key through every consumer
 * that forwards those settings — forever. For a flag retired as ENABLED, the
 * stale persisted `false` reads as an opt-OUT of a feature that no longer has an
 * off state.
 *
 * {@link LABS_SETTING_KEY_LEDGER} is the independent witness that makes the
 * omission detectable: it records every key that has EVER been registered, so a
 * key that leaves the registry without arriving in the sweep is left stranded in
 * the ledger and {@link findLabsSettingKeyLedgerViolations} names it. The ledger
 * is checked in BOTH directions — a registered or retired key missing FROM it
 * fails too — so it cannot quietly rot the way a one-directional list does.
 */

/**
 * Labs toggles whose feature graduated to always-on (or was removed outright), so
 * the key was deleted from `DesktopSettings`, its defaults, and the Labs
 * registry.
 *
 * Every one defaulted `false`, so only an install that TOUCHED the toggle still
 * carries the raw key — and electron-store spreads raw persisted data through
 * `getAll()`, so that stale `false` would bleed into IPC responses, stop
 * conforming to `DesktopSettings`, and read as an opt-OUT of a feature that no
 * longer has an off state.
 *
 * Add a key here when you retire a Labs toggle — do NOT drop the entry once the
 * fleet has upgraded. `store.store` is whatever that install wrote, so an install
 * that has not launched since the toggle existed still carries it, and removing
 * the sweep re-opens the stale-`false` bleed on exactly those machines.
 *
 * Moved out of `settings-migrations.ts` (ISS-6523) so it sits beside the ledger
 * it is reconciled against; `removeRetiredKeys` imports it from here.
 */
export const RETIRED_LABS_SETTING_KEYS = [
  // ISS-10732 (operator ruling 2026-09-21, shipped with ISS-10733) — the
  // agent-type breakdown's incomplete-population note, removed outright: the
  // only surface that read this key was the unmounted Agents analytics
  // cluster, so the gate was deleted with the component it gated rather than
  // graduated. Retired DISABLED, so the stale persisted `false` agrees with
  // the shipped behavior — but it is still a no-longer-typed key that
  // `getAll()` would spread forever, so it is swept like any other.
  "agent-type-roster-incomplete",
  "agents-count-column-alignment",
  "agents-loc-per-dollar-display",
  "cloud-read-cutover-gate",
  "component-versions-truncated",
  // ISS-7819 — the import splash's Compute count, graduated to ALWAYS-ON. The
  // rail stopped claiming a determinate position during the multi-hour rebuild,
  // which left this count as the phase's only quantitative signal, so it can no
  // longer sit behind a toggle. Retired ENABLED, the case this file's header
  // calls out: an install that ever touched the toggle still persists `false`,
  // and that would read as an opt-OUT of a feature with no off state.
  "compute-progress-count",
  // ISS-7870 — Branches server paging graduated to Desktop default-on after the
  // production 30d metrics-card path regressed through the old complete-list
  // waterfall. A stale persisted `false` would keep an upgraded install on the
  // slow path even though the Labs toggle no longer exists.
  "branches-server-pagination",
  // ISS-9972 — the Branches cost-coverage agreement toggle, removed outright
  // rather than graduated: a feature flag may no longer decide which cost basis
  // a dollar figure reads, so the flag and the alternate derivation it selected
  // were both deleted. Retired DISABLED, so the stale persisted `false` agrees
  // with the shipped behavior — but it is still a no-longer-typed key that
  // `getAll()` would spread forever, so it is swept like any other.
  "branches-cost-coverage-agreement",
  // ISS-9430 — GridTable v2 moved fully to the shared signed-in PostHog
  // assignment path. A stale persisted Labs value must not shadow the shared
  // rollback key.
  "grid-table-v2",
  "detail-route-loading-state",
  // PLN-1742 M5 — Clerk became the unconditional GitHub credential source, so
  // the connect-opener URL toggle lost its off state.
  "github-clerk-credentials",
  "session-linked-artifacts-reachable",
  "session-loc-pr-attribution",
  "session-timeline-axis-reconciliation",
  "session-trace-slash-command-chip",
  // ISS-9972 — the Sessions LOC/$ coverage flag, RETIRED rather than graduated:
  // a feature flag may no longer decide what a shipped ratio states, so the key
  // is deleted and the card's render is pinned to the closed-by-default state
  // every reader already saw. WHICH coverage behavior the card should ship is
  // ISS-10354, settled separately. Retired DISABLED, so the stale persisted
  // `false` agrees with the shipped behavior — but it is still a no-longer-typed
  // key that `getAll()` would spread forever, so it is swept like any other.
  "sessions-loc-per-dollar-coverage",
  "sessions-subagent-transcript-disclosure",
  // PRD-536 G1 — the per-session transcript-freshness marker.
  "sessions-transcript-sync-status",
  // ISS-4848 — folding a still-uploading session's sync state into its existing
  // Status pill instead of a second chip.
  "sessions-status-pill-sync-state",
  // ISS-4996 / ISS-4997 / ISS-4998 — Status, Repository, and the Activity
  // breakdown telling the truth about what they do not know.
  "sessions-honest-unknown-states",
  // ISS-7019 — the Sessions displayed-status SSOT, graduated to ALWAYS-ON when
  // `AgentSessionState` was deleted: the Local lane lost its second status axis,
  // so the projection had to become unconditional or desktop would have shown a
  // raw status where web shows the displayed one. Retired ENABLED, which is the
  // case this file's header calls out — a profile that ever touched the toggle
  // still persists `false`, and that would read as an opt-OUT of a feature with
  // no off state.
  "sessions-displayed-status-parity",
  // ISS-4952 — resolving an Owner chip's display name from the org roster.
  "sessions-owner-name-resolution",
  // ISS-4953 — one set of row-state chips beside the session name.
  "sessions-row-state-chip-parity",
  // ISS-4966 — the derived summary-strip column count.
  "summary-strip-column-cardinality",
  // ISS-5068 — the compact summary strip: a tighter card interior and the
  // lower per-card floor it pays for.
  "summary-strip-density",
  // ISS-5149 — applying that density only at the widths where it buys a rank.
  "summary-strip-density-tier",
  // ISS-5666 — the Sessions row qualifiers living in a `Signals` column of
  // their own, with the Session Name cell reduced to the name alone.
  "sessions-row-qualifiers-column",
  // ISS-5999 — the Session detail page's prototype-conformance re-layout
  // (ISS-5818's title chip / region order / heading semantics, ISS-5970's run
  // summary), graduated to unconditional.
  "sessions-detail-prototype-parity",
  // ISS-6121 — ISS-5131 retired the session Duration measured-zero /
  // unmeasurable gate and #4409 removed its Labs entry. Remove the persisted
  // residue now that the unused DesktopSettings field is gone.
  "session-duration-unmeasurable-span",
  // ISS-6245 — the GridTable width budget (ISS-5813), removed outright rather
  // than graduated: dropping whole data columns to fit the container was never
  // the wanted trade, and horizontal scroll is the correct behavior. Remove the
  // persisted residue now that the `DesktopSettings` field is gone.
  "grid-table-width-budget",
  // ISS-6006 — the Session Timeline jump feedback (ISS-5479), retired as
  // ENABLED: the treatment is unconditional now, so the toggle has no off state
  // left to represent. Only an install that TOUCHED the toggle carries the raw
  // key, and that stale `false` would otherwise read as an opt-OUT of a feature
  // that can no longer be opted out of. (Its web twin,
  // `sessions-cache-write-ttl`, needs no entry — it was never registered on
  // desktop, which is the ISS-5593 P3 parity defect the same retirement fixes.)
  "session-timeline-jump-feedback",
  // ISS-7867 — the ISS-5564 Activity-breakdown confidence-basis footer, whose
  // only consumer was the breakdown panel deleted with the phases surface
  // below. Retired in the same change that orphaned it.
  "session-phase-confidence-disclosure",
  // ISS-7867 — the ISS-5841 Session-detail activity phases (the strip, the
  // breakdown, and the Timeline's "Activity phase" Group-by cut), removed
  // outright rather than graduated: product moved phase cost analysis to the
  // Branch screen, so the toggle has no on state left to represent. Only an
  // install that TOUCHED the toggle carries the raw key, and that stale value
  // would otherwise bleed through `getAll()` for a flag that no longer exists.
  "session-activity-phases",
  // ISS-6118 — the ISS-5258 collapsible import splash, retired GRADUATED: the
  // disclosure is unconditional now, so there is no off state for a stale
  // persisted `false` to mean. An install that opted IN carries a `true`, which
  // would be just as wrong once the key stops being a toggle.
  "collapsible-import-splash",
  // ISS-4715 — the startup-readiness experience, retired GRADUATED: the ordered
  // readiness panel is the only startup surface now (the first-launch import
  // banner it gated is no longer mounted), so the toggle has no off state left
  // to represent. An install that opted IN carries a stale `true`, which would
  // be just as wrong once the key stops being a toggle.
  "startupReadinessExperience",
  // ISS-7995 — the ISS-5112 guest-mode first run, retired ENABLED: guest mode is
  // the only first-run path now (the blocking onboarding overlay it gated is
  // deleted), so the toggle has no off state left to represent. Only an install
  // that TOUCHED the toggle carries the raw key, and that stale `false` would
  // read as an opt-OUT of a feature that can no longer be opted out of.
  "guest-onboarding",
  // FEA-4174's Value Numerator 2.0 registry entry never acquired a runtime
  // consumer; retire its default-off persisted residue instead of keeping a
  // hidden switch that changes nothing.
  "valueNumeratorV2",
  // Retired GRADUATED: PostHog carried these three at unconditional 100%, which
  // is a retired-ON state rather than a default-ON Desktop opt-out. The
  // behavior is unconditional now, so any persisted local value is stale
  // residue — an install that opted OUT carries a `false` that would otherwise
  // read as an opt-out of a feature that can no longer be opted out of.
  "sessions-change-pr-filters",
  "sessions-grid-fold-legibility",
  "session-timeline-column-hit-target",
  // ISS-8791 — the Sessions Cost card's BREAKDOWN presentation, graduated to
  // ALWAYS-ON (operator permission, 2026-09-01). Retired DISABLED, so only an
  // install that opted in still persists the key — but that persisted `true`
  // would keep bleeding a no-longer-typed member through `getAll()` forever.
  "sessions-cost-breakdown",
  // ISS-8791 — the ISS-4773 honest presentation, retired outright rather than
  // graduated (operator decision, 2026-09-01). Making breakdown unconditional
  // left this mode unreachable: both producers build `totalEstimatedCost` as
  // `subscription + metered + unknown` and `apiEstimatedCost` as
  // `metered + unknown`, so every payload either can emit reconciles and
  // breakdown claims it first. Same persisted-residue reason as the row above.
  "sessions-cost-billing-honesty",
  // ISS-9660 — the ISS-8024 flag-source cutover gate, retired ENABLED. It chose
  // between the local Labs registry (off) and the signed-in user's PostHog
  // assignment (on); ISS-8753 (#6411) made PostHog the ONLY source and deleted
  // the Labs-backed adapter, so the ON path won and there is no off state left
  // for a persisted value to select. It is the one key here that was never a
  // feature gate but a SOURCE gate, which is why it outlived every flag it
  // governed. Retired-ENABLED is the case this file's header calls out: an
  // install that ever touched the toggle still persists a raw boolean, and a
  // stale `false` would read as an opt-OUT of a resolution path that no longer
  // has an alternative.
  "desktopPosthogFlags",
  // ISS-9964 / ISS-9980 (RULED 2026-09-11) — the ISS-6114 merged-only "Lines
  // changed" rung, retired ENABLED: merged authored PRs are now the single
  // unflagged population the row prints and the LOC/$ beside it divides, so the
  // toggle has no off state left to represent. Retired-ENABLED is the case this
  // file's header calls out — an install that ever touched the toggle still
  // persists `false`, which would read as an opt-OUT of a behavior that can no
  // longer be opted out of.
  "sessions-merged-loc-rung",
  // ISS-12435 (PRD-795): the loop completion OS notification, removed with
  // Loops. Retired DISABLED; swept so the no-longer-typed persisted value does
  // not spread through `getAll()`.
  "loopCompletedNotificationsEnabled",
  // PRD-797 (Q-004): Routines and the Audit Bot, removed outright with crewd.
  // Retired DISABLED; swept so the no-longer-typed persisted values do not
  // spread through `getAll()`.
  "routines",
  "auditBot",
  // ISS-12784 (R3): Update & Restart, removed outright with the gateway route
  // it gated. Retired DISABLED; swept so the no-longer-typed persisted value
  // does not spread through `getAll()`.
  "updateAndRestartEnabled",
  // ISS-12784 (R3): Trusted Browser Enforcement, removed outright with browser
  // command signing. Retired DISABLED; an install that opted in persists a
  // `true` that no longer enforces anything, so it is swept.
  "commandSigningEnforcementEnabled",
] as const;

/**
 * APPEND-ONLY. Every setting key that has ever appeared in the desktop flag
 * registry, whether it is live today or retired.
 *
 * This is the only record that survives a retirement, so it is what makes a
 * missing sweep entry detectable: remove a key from the registry and, if no
 * sweep entry replaces it, the key is stranded here and the gate names it.
 *
 * NEVER delete an entry — a deletion is indistinguishable from the omission this
 * exists to catch, and it re-opens the persisted-residue bleed on every install
 * that has not launched since the toggle existed. Adding a flag means adding it
 * here too; the gate fails until you do, so this cannot silently fall behind.
 *
 * This array alone cannot catch its own deletions — a lane that drops the
 * registry entry and the line here in one change leaves nothing behind. That is
 * why `LEDGER_HISTORICAL_KEYS` in `test/labs-setting-key-ledger.test.ts` mirrors
 * it from outside the module, reconciled in BOTH directions: adding a key here
 * fails until the witness records it, and deleting one fails because the witness
 * still does.
 *
 * Scope: this ledger reconciles against {@link RETIRED_LABS_SETTING_KEYS}, so it
 * covers the keys that batch retirement owns. Deliberately absent are the
 * former `scheduledTasks` shadow (never a registry flag) and the keys retired
 * BEFORE the batch array existed, which
 * `settings-migrations.ts` still sweeps through their own individual `if` blocks
 * — several of those were registry flags, but their sweep is not the array read
 * here, so listing them would strand them as false violations. Those blocks are
 * already correct and are left alone; everything retired from here on goes
 * through the array and is gated.
 */
export const LABS_SETTING_KEY_LEDGER: readonly string[] = [
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

/** Where each half of the contract is edited, quoted in the failure message. */
const REGISTRY_MODULE = "apps/desktop/src/shared/feature-flags.ts";
const LEDGER_MODULE =
  "apps/desktop/src/main/settings/labs-setting-key-ledger.ts";

export const LabsSettingKeyViolationKind = {
  /** Left the registry without arriving in the sweep — the ISS-6523 defect. */
  SweepEntryMissing: "sweep_entry_missing",
  /** Registered or retired but absent from the append-only ledger. */
  LedgerEntryMissing: "ledger_entry_missing",
  /** Live in the registry AND swept — the boot sweep eats the user's opt-in. */
  StillRegisteredButSwept: "still_registered_but_swept",
} as const;
export type LabsSettingKeyViolationKind =
  (typeof LabsSettingKeyViolationKind)[keyof typeof LabsSettingKeyViolationKind];

export type LabsSettingKeyViolation = {
  kind: LabsSettingKeyViolationKind;
  key: string;
  remedy: string;
};

export type LabsSettingKeySources = {
  /** Keys currently in the flag registry. */
  registryKeys: readonly string[];
  /** Keys currently swept from upgrading profiles. */
  retiredKeys: readonly string[];
  /** Every key that has ever been registered. */
  ledgerKeys: readonly string[];
};

/**
 * Reconcile the registry, the retirement sweep and the ledger.
 *
 * A key in the ledger must be in exactly one of the other two: still registered,
 * or retired AND swept. A key that is in neither was retired without its sweep
 * entry, so an upgrading profile keeps bleeding it through `getAll()`.
 */
export function findLabsSettingKeyLedgerViolations(
  sources: LabsSettingKeySources
): LabsSettingKeyViolation[] {
  const registry = new Set(sources.registryKeys);
  const retired = new Set(sources.retiredKeys);
  const ledger = new Set(sources.ledgerKeys);
  const violations: LabsSettingKeyViolation[] = [];

  for (const key of ledger) {
    if (registry.has(key) || retired.has(key)) {
      continue;
    }
    violations.push({
      kind: LabsSettingKeyViolationKind.SweepEntryMissing,
      key,
      remedy: `"${key}" was removed from the flag registry but never added to RETIRED_LABS_SETTING_KEYS in ${LEDGER_MODULE}. Until it is, every profile that ever toggled it keeps that key in its persisted store and SettingsStore.getAll() keeps reporting it. Add "${key}" to RETIRED_LABS_SETTING_KEYS — or restore its ${REGISTRY_MODULE} entry if the removal was unintended.`,
    });
  }

  // Deduped: a key can be in BOTH sets at once (that is
  // `StillRegisteredButSwept`), and a flat concatenation would then report the
  // same missing ledger entry twice — one key, one remedy, printed as if there
  // were two distinct problems.
  for (const key of new Set([...registry, ...retired])) {
    if (ledger.has(key)) {
      continue;
    }
    violations.push({
      kind: LabsSettingKeyViolationKind.LedgerEntryMissing,
      key,
      remedy: `"${key}" is missing from LABS_SETTING_KEY_LEDGER in ${LEDGER_MODULE}. The ledger is the only record that survives a retirement, so a key absent from it can later be dropped from the registry with no sweep entry and nothing would notice. Add "${key}" to LABS_SETTING_KEY_LEDGER.`,
    });
  }

  // A key cannot be live and swept at once. `removeRetiredKeys` runs on EVERY
  // boot, so a still-registered key in the sweep has its user's opt-in deleted
  // on every launch and the toggle silently reverts to its default. That is how
  // `cloud-read-cutover-gate` behaved: #4633 retired it correctly, and #4598 —
  // branched before that retirement and merged after — restored only its
  // registry entry, leaving the sweep entry pointed at a live flag.
  for (const key of registry) {
    if (!retired.has(key)) {
      continue;
    }
    violations.push({
      kind: LabsSettingKeyViolationKind.StillRegisteredButSwept,
      key,
      remedy: `"${key}" is registered in ${REGISTRY_MODULE} AND listed in RETIRED_LABS_SETTING_KEYS in ${LEDGER_MODULE}. removeRetiredKeys deletes it on every boot, so a user who turns this toggle on loses it at the next launch. Either finish the retirement by removing the registry entry, or — if the flag was deliberately re-registered — drop the sweep entry and clear the residue ONCE behind a sentinel, the way "agent-collaboration-network" does.`,
    });
  }

  return violations;
}

/** One actionable line per violation, for a failure message. */
export function describeLabsSettingKeyViolations(
  violations: readonly LabsSettingKeyViolation[]
): string {
  return violations
    .map((violation) => `[${violation.kind}] ${violation.remedy}`)
    .join("\n");
}
