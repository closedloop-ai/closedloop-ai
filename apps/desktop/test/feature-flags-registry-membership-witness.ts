/**
 * The desktop flag registry's key membership, transcribed by hand.
 *
 * Split out of `feature-flags-registry-composition.test.ts` by ISS-8071 so a SECOND
 * suite can reconcile against it. `labs-setting-key-ledger.test.ts` is the file
 * a lane adding a Labs setting key actually reads, and until ISS-8071 it had no
 * way to say "you also owe an entry here" without keeping a second copy of
 * these 75 keys. One literal, two gates: this module owns the transcription,
 * `feature-flags-registry-composition.test.ts` owns duplicate-key protection, and the
 * ledger suite owns MEMBERSHIP.
 *
 * NEVER DERIVE THIS FROM `FEATURE_FLAGS`. Each entry was transcribed by
 * resolving its key constant in the source tree; reading the array under test
 * would make this list agree with whatever the registry currently is, which is
 * the one thing it exists to refuse — and a derived list stays green when a key
 * is DELETED, which is the shape both gates exist to catch. A "simplification"
 * to `FEATURE_FLAGS.map((flag) => flag.key)` deletes both guards and leaves
 * every test green.
 *
 * NO TEST CAN CATCH THAT SUBSTITUTION, which is why the warning is here rather
 * than in an assertion: once the module has loaded, a transcribed array and a
 * derived one are the same value, so any runtime check of "was this typed by
 * hand" passes either way — a test that cannot fail. Review is the only guard on
 * this particular line, and ISS-8071 verified the two guards it protects by
 * deleting a member OUTSIDE the suite (a registry entry, and an entry here) and
 * confirming both gates redden.
 *
 * Originally transcribed from the registry as it stood on `main` before
 * ISS-7431 split it across sibling modules. Flags registered since are
 * transcribed the same way — from their source slot in the owning module, not
 * from the merged array. `guest-onboarding` (ISS-5112) was transcribed here and
 * has since been RETIRED by ISS-7995, so it is dropped rather than kept: the
 * list is the pre-split membership minus retirements, not a frozen snapshot, and
 * a key removed from the registry is removed here in the same change.
 */
export const REGISTRY_MEMBERSHIP_WITNESS: readonly string[] = [
  "claudeCodeOtelCapture",
  "collectClaudeEnabled",
  "collectCursorEnabled",
  "collectCopilotEnabled",
  "planExtractionEnabled",
  "session-detail-read-source",
  "agentCoachingTips",
  "agentCoachingPacks",
  "cloudConnectionEnabled",
  "cloudCommandsPaused",
  "sessionCompletionNotifications",
  // ISS-6170 registers this in `feature-flags.ts` after
  // `sessionCompletionNotifications`, so it is transcribed from that source
  // slot like every entry above.
  "terminalInstallFailureNotifications",
  "verboseLogging",
  "transcriptSyncEnabled",
  "docsHelp",
  "requestsLiveRefresh",
  "agentsNav",
  "stoppedLaneReadiness",
  "db-ahead-banner",
  // ISS-6207 registers this in `feature-flags-labs-surfaces.ts` between the
  // `db-ahead-banner` and `artifact-cell-primitives` entries of
  // `LABS_SURFACE_FEATURE_FLAGS`, so it is transcribed from that source slot
  // like every entry above — not from the composed array. ISS-4715 retired the
  // `startupReadinessExperience` entry that used to sit above it.
  "boot-import-degraded-terminal",
  "artifact-cell-primitives",
  "tag-create-color",
  "custom-field-editor-contracts",
  "eligible-branch-navigation",
  "sessions-branches-tab-titles",
  "agents-invocations-dedupe",
  "agents-bounded-page-data",
  "sessions-comment-count-tag",
  "branches-pinned-name-column",
  "insights-spend-outcome",
  "sessions-custom-date-window",
  "agent-collaboration-network",
  "chart-distinguishable-series",
  // ISS-8791 retired the two Sessions cost flags that used to sit immediately
  // above this entry, so it now leads the slot they occupied. The order is a
  // mirror of `feature-flags-labs-detail.ts`, not a statement about neighbours.
  "metric-delta-unified-pill",
  "metric-delta-neutral-pill",
  "sessions-delivery-card-no-data",
  "agents-default-sort-usage",
  "localSessionAuthoredPrGate",
  "threadViewershipSignal",
  "labsNav",
  "agents-source-provenance-honesty",
  "showRedactedSyncLevel",
  "agents-definition-empty-state-honesty",
  "agents-detail-honesty",
  "agents-type-tab-overflow",
  "activity-coverage-diagnostics",
  "opencode-withheld-diagnostics",
  "subscriptionSessionLimits",
  "branches-cohort-transparency",
  "branches-summary-honest-loading",
  "session-claude-reported-cost",
  "session-launch-attribution",
  "session-metric-population-disclosure",
  "session-tokens-recorded-honesty",
  "branch-timeline-cost-fallback-marker",
  "sessions-summary-honest-loading",
  "member-self-service-install",
  "session-timeline-synthesized-cost",
  "session-trace-evidence-disclosure",
  "session-transcript-never-expected",
  "session-timeline-coverage-disclosure",
  "session-timeline-source-extent",
  "agents-card-attribute-labels",
  "branch-detail-measured-checks",
  "branch-detail-pr-base-and-author",
  "branch-detail-metric-honesty",
  "session-trace-idle-rows",
  "session-touched-branches",
];
