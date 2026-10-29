import assert from "node:assert/strict";
import { AGENT_COLLABORATION_NETWORK_FLAG_KEY } from "@repo/api/src/types/agent-collaboration-network-flag";
import { AGENTS_NAV_FLAG_KEY } from "@repo/api/src/types/agents-nav-flag";
import { BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY } from "@repo/api/src/types/branch-detail-measured-checks-flag";
import { BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY } from "@repo/api/src/types/branch-detail-metric-honesty-flag";
import { BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FLAG_KEY } from "@repo/api/src/types/branch-detail-pr-base-and-author-flag";
import { BRANCHES_PINNED_NAME_COLUMN_FLAG_KEY } from "@repo/api/src/types/branches-pinned-name-column-flag";
import { BRANCHES_SUMMARY_HONEST_LOADING_FLAG_KEY } from "@repo/api/src/types/branches-summary-honest-loading-flag";
import { CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY } from "@repo/api/src/types/custom-field-editor-contracts-flag";
import { INSIGHTS_SPEND_OUTCOME_FLAG_KEY } from "@repo/api/src/types/insights-spend-outcome-flag";
import { SESSIONS_BRANCHES_TAB_TITLES_FLAG_KEY } from "@repo/api/src/types/sessions-branches-tab-titles-flag";
import { SESSIONS_COMMENT_COUNT_TAG_FLAG_KEY } from "@repo/api/src/types/sessions-comment-count-tag-flag";
import { TAG_CREATE_COLOR_FLAG_KEY } from "@repo/api/src/types/tag-create-color-flag";
import { afterEach, test } from "vitest";
import {
  DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
  DESKTOP_BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY,
  DESKTOP_BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_TOKENS_RECORDED_HONESTY_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_TOUCHED_BRANCHES_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_TRACE_EVIDENCE_DISCLOSURE_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_TRACE_IDLE_ROWS_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_TRANSCRIPT_NEVER_EXPECTED_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_DURATION_CALENDAR_QUALIFIER_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY,
  FEATURE_FLAGS,
  type FlagKey,
} from "../src/shared/feature-flags.js";
import {
  DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY,
  DESKTOP_INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY,
  DESKTOP_METRIC_DELTA_NEUTRAL_PILL_FEATURE_FLAG_KEY,
  DESKTOP_METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_DELIVERY_CARD_NO_DATA_FEATURE_FLAG_KEY,
} from "../src/shared/feature-flags-labs-detail.js";
import {
  DESKTOP_BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY,
  DESKTOP_CUSTOM_FIELD_EDITOR_CONTRACTS_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_COMMENT_COUNT_TAG_FEATURE_FLAG_KEY,
  DESKTOP_TAG_CREATE_COLOR_FEATURE_FLAG_KEY,
} from "../src/shared/feature-flags-labs-surfaces.js";
import { DESKTOP_SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY } from "../src/shared/feature-flags-shared-ui.js";
import {
  cleanupFeatureFlagStores,
  makeFeatureFlagStore,
} from "./feature-flags-store-fixture.js";

/**
 * Cross-surface parity guards for the desktop Labs registry.
 *
 * Split out of `feature-flags.test.ts` when the merged suite crossed the
 * 1,000-line ceiling (ISS-4866). The seam is a real responsibility, not a line
 * count: every test here answers ONE question — does a desktop Labs key stay
 * byte-for-byte equal to the web/PostHog (or Playwright-seeded) literal that
 * names the same feature, registered as an off-by-default Labs toggle? That is
 * the ISS-4779 closed-by-default contract, and it is append-only WHILE A FLAG
 * LIVES: each new shared web+desktop UI flag adds a row, and a row leaves only
 * when its key is retired outright. `feature-flags.test.ts` keeps the registry's
 * own behaviour (resolution order, env overrides, retired-key migrations, sync
 * tiers).
 *
 * ISS-5999 removed two rows this way — the `sessions-detail-prototype-parity`
 * parity row (ISS-5818/ISS-5819/ISS-5970) and its desktop-e2e literal pin. The
 * key no longer exists on either surface, so there is nothing left to hold
 * byte-equal; what survives it is the raw literal in `RETIRED_LABS_SETTING_KEYS`
 * (`src/main/settings/settings-migrations.ts`), pinned by
 * `settings-migration-retired-labs-keys.test.ts`. Per the ISS-5061 note below,
 * re-gating this feature means restoring BOTH halves, not just the desktop key.
 *
 * These files must both stay in `test/` — `scripts/run-node-tests.mjs`
 * discovers `*.test.ts` by directory listing, so a split file is picked up with
 * no runner change.
 */

afterEach(cleanupFeatureFlagStores);

// ISS-4890/4906/4901 and ISS-4887: these still-registered cross-surface
// Labs flags must be default OFF, with literals equal to the shared keys so a
// rename cannot split the two surfaces.
for (const { issue, desktopKey, sharedKey } of [
  // ISS-6385: the create-a-tag-then-pick-its-colour step. TagPicker mounts on
  // desktop through BranchesView -> BranchesListSurfaceV2 -> ApprovedBranchesTable,
  // which is why this is a shared key rather than a web-only one.
  {
    issue: "ISS-6385",
    desktopKey: DESKTOP_TAG_CREATE_COLOR_FEATURE_FLAG_KEY,
    sharedKey: TAG_CREATE_COLOR_FLAG_KEY,
  },
  // ISS-8215 / ISS-8214: the custom-field editor contract corrections. The
  // Sessions surface's custom-field columns mount `CustomFieldTableCell` and
  // `SessionsAddFieldDialog` from `@repo/app` on both surfaces, which is why
  // this is a shared key rather than a web-only one.
  {
    issue: "ISS-8215/8214",
    desktopKey: DESKTOP_CUSTOM_FIELD_EDITOR_CONTRACTS_FEATURE_FLAG_KEY,
    sharedKey: CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY,
  },
  // FEA-4204: the Sessions list's lead-cell comment-count tag.
  {
    issue: "FEA-4204",
    desktopKey: DESKTOP_SESSIONS_COMMENT_COUNT_TAG_FEATURE_FLAG_KEY,
    sharedKey: SESSIONS_COMMENT_COUNT_TAG_FLAG_KEY,
  },
  {
    issue: "ISS-4463",
    desktopKey: DESKTOP_INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY,
    sharedKey: INSIGHTS_SPEND_OUTCOME_FLAG_KEY,
  },
  {
    issue: "ISS-5574",
    desktopKey: DESKTOP_SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
    sharedKey: SESSIONS_BRANCHES_TAB_TITLES_FLAG_KEY,
  },
  // ISS-6959: the Branches list's pinned Name column. `ApprovedBranchesTable`
  // mounts on web AND desktop through the one `BranchesListSurfaceV2`, so a split
  // key would hold the identifier on screen for one surface's reader and leave
  // the other's staring at a row of values with nothing saying which branch
  // they belong to — the exact defect the pin exists to remove.
  {
    issue: "ISS-6959",
    desktopKey: DESKTOP_BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY,
    sharedKey: BRANCHES_PINNED_NAME_COLUMN_FLAG_KEY,
  },
  // ISS-5061: the Agent Collaboration Network row on the Insights overview
  // dashboard. `InsightsOverviewDashboard` mounts on web AND desktop, so a split
  // key would draw the aggregate subagent-collaboration graph on one surface
  // while the other hides the row entirely. This row is the reason the append-only
  // rule above is load-bearing: ISS-5280 (#4482) retired this gate and deleted
  // its row, and the re-gate has to put BOTH back — the pairing is what proves
  // the revived desktop Labs key still equals the revived PostHog literal.
  {
    issue: "ISS-5061",
    desktopKey: DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY,
    sharedKey: AGENT_COLLABORATION_NETWORK_FLAG_KEY,
  },
  // ISS-5041/ISS-7835: the Agents DESTINATION gate. Desktop-only when ISS-5310
  // registered it; the web sidebar, ⌘K palette, mobile bar and `/agents` routes
  // now gate on the same literal through PostHog.
  //
  // This row pins the DESKTOP half only. Both operands below alias the one
  // `@repo/api` constant, so it cannot see a web-side re-declaration — the web
  // alias is pinned to that constant, and to the literal, in
  // `apps/app/__tests__/agents-nav-customer-view.test.tsx`. The two together are
  // what stop the halves drifting.
  {
    issue: "ISS-5041/ISS-7835",
    desktopKey: DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
    sharedKey: AGENTS_NAV_FLAG_KEY,
  },
  {
    issue: "ISS-8510",
    desktopKey: DESKTOP_BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY,
    sharedKey: BRANCHES_SUMMARY_HONEST_LOADING_FLAG_KEY,
  },
]) {
  test(`${issue}: ${desktopKey} is a Labs flag, default OFF, and round-trips through getFlag/setFlag`, () => {
    // Parity with the shared cross-surface constant: the desktop Labs key and
    // the web PostHog key BOTH alias one `@repo/api` literal, so a rename
    // touches a single definition. Assert against that constant, not a string.
    assert.equal(desktopKey, sharedKey);

    const def = FEATURE_FLAGS.find((f) => f.key === desktopKey);
    assert.ok(def, "flag must be registered in FEATURE_FLAGS");
    assert.equal(def.default, false, "flag must default OFF");
    assert.equal(def.category, "Labs");
    assert.notEqual(
      def.hiddenFromLabs,
      true,
      "flag must remain an exposed Labs gate"
    );

    const store = makeFeatureFlagStore();
    // Default resolves OFF, and a user opting in through setFlag flips it on.
    assert.equal(store.getFlag(desktopKey as FlagKey), false);
    store.setFlag(desktopKey as FlagKey, true);
    assert.equal(store.getFlag(desktopKey as FlagKey), true);
  });
}

// The desktop-e2e specs seed these Labs toggles as string LITERALS — importing
// `src/shared/feature-flags` into a Playwright spec aborts the whole desktop-e2e
// suite at load time (extension-less `@repo/api/src/types/...` specifiers do not
// resolve under its ESM loader). Those are deliberate copies, so each needs a
// pin: a rename of any of these flags has to fail here rather than silently
// leave the e2e seeding a key nothing reads.
for (const { desktopKey, e2eLiteral, spec } of [
  {
    desktopKey: DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
    e2eLiteral: "agentsNav",
    spec: "labs-gating-withdrawal.spec.ts",
  },
  // ISS-8427: the session-detail Branches row, seeded by the desktop CLOUD
  // session-detail spec — the only path that can serve `branches` at all.
  {
    desktopKey: DESKTOP_SESSION_TOUCHED_BRANCHES_FEATURE_FLAG_KEY,
    e2eLiteral: "session-touched-branches",
    spec: "session-detail-branches-row.spec.ts",
  },
]) {
  test(`${desktopKey} matches the literal ${spec} seeds`, () => {
    assert.equal(desktopKey, e2eLiteral);
  });
}

/**
 * ISS-8241 Half A: the Branch detail's measured-checks projection.
 *
 * No `DESKTOP_…` alias exists for it — both surfaces read the one `@repo/api`
 * leaf — so this pins the leaf against the RAW literal rather than against
 * itself, which would assert nothing. The web alias is pinned to the same
 * literal in
 * `packages/app/branches/components/detail/__tests__/branch-pr-measured-checks.test.tsx`.
 * Neither surface imports the other, so those two raw pins together are what
 * stop a rename leaving one surface on the live provider read and the other on
 * the stored measurement for the very same pull request.
 */
test("ISS-8241: branch-detail-measured-checks is a Labs flag, default OFF, and round-trips through getFlag/setFlag", () => {
  assert.equal(
    BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY,
    "branch-detail-measured-checks"
  );

  const def = FEATURE_FLAGS.find(
    (f) => f.key === BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY
  );
  assert.ok(def, "flag must be registered in FEATURE_FLAGS");
  assert.equal(def.default, false, "flag must default OFF");
  assert.equal(def.category, "Labs");
  assert.notEqual(
    def.hiddenFromLabs,
    true,
    "flag must remain an exposed Labs gate"
  );

  const store = makeFeatureFlagStore();
  const key = BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY as FlagKey;
  assert.equal(store.getFlag(key), false);
  store.setFlag(key, true);
  assert.equal(store.getFlag(key), true);
});

/**
 * ISS-8241 Half B: the Branch pull-request box's base ref and author.
 *
 * No `DESKTOP_…` alias exists for it — both surfaces read the one `@repo/api`
 * leaf — so this pins the leaf against the RAW literal rather than against
 * itself, which would assert nothing. The web alias is pinned to the same
 * literal in
 * `packages/app/branches/components/detail/__tests__/branch-delivered-panel.test.tsx`.
 * Neither surface imports the other, so those two raw pins together are what
 * stop a rename splitting the PostHog flag from this Labs toggle.
 */
test("ISS-8241: branch-detail-pr-base-and-author is a Labs flag, default OFF, and round-trips through getFlag/setFlag", () => {
  assert.equal(
    BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FLAG_KEY,
    "branch-detail-pr-base-and-author"
  );

  const def = FEATURE_FLAGS.find(
    (f) => f.key === BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FLAG_KEY
  );
  assert.ok(def, "flag must be registered in FEATURE_FLAGS");
  assert.equal(def.default, false, "flag must default OFF");
  assert.equal(def.category, "Labs");
  assert.notEqual(
    def.hiddenFromLabs,
    true,
    "flag must remain an exposed Labs gate"
  );

  const store = makeFeatureFlagStore();
  const key = BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FLAG_KEY as FlagKey;
  assert.equal(store.getFlag(key), false);
  store.setFlag(key, true);
  assert.equal(store.getFlag(key), true);
});

// ISS-4979 / ISS-4978 -> ISS-5131 (#4409): both session-Duration gates are
// RETIRED and their Labs entries are GONE. The corrected Duration rule computes
// no number at all for an unmeasurable window (so the em-dash is not a semantic
// a gate can flip), and there is one Duration measure now (so there is no
// qualifier to choose). Nothing reads either key.
//
// ISS-6121 removes the unused unmeasurable-span constants; persisted
// compatibility is owned by the settings migration, not dead runtime exports.
// Both retired switches must remain absent from Labs.
test("ISS-5131: the two retired session-Duration flags are gone from a future generic flag surface", () => {
  assert.equal(
    DESKTOP_SESSIONS_DURATION_CALENDAR_QUALIFIER_FEATURE_FLAG_KEY,
    "sessions-duration-calendar-qualifier"
  );

  for (const retiredKey of [
    "session-duration-unmeasurable-span",
    DESKTOP_SESSIONS_DURATION_CALENDAR_QUALIFIER_FEATURE_FLAG_KEY,
  ]) {
    assert.equal(
      FEATURE_FLAGS.find((f) => f.key === retiredKey),
      undefined,
      `${retiredKey} must not be offered in a future generic flag surface: nothing reads it`
    );
  }
});

/**
 * ISS-5820 / ISS-6006: two RETIRED-AS-ENABLED gates. Each behaviour is now
 * unconditional on web and desktop, in dev and packaged builds alike, and
 * nothing anywhere reads the key — so a Labs row would offer a switch that
 * controls nothing, and (worse) re-registering one would make the shipped
 * behaviour opt-in again on packaged desktop.
 *
 * `sessions-cache-write-ttl` was never registered here at all, which is why it
 * was half of the ISS-5593 P3/P4 parity defect: an unregistered shared key falls
 * through to `flagsEnabled` (`!isPackaged`), so the row rendered by BUILD TYPE —
 * on in dev, off in packaged — rather than by intent. Asserting its absence pins
 * the retirement rather than the old accident: the correct state is "gone AND
 * unconditional", and re-adding a row would resurrect a gate the code no longer
 * honours.
 *
 * `transcript-download-progress`, ISS-5820's third key, is deliberately NOT in
 * this list. Its retirement is held back: the desktop main process runs the S3
 * transfer inside `prepareTranscript` with no progress channel, so on packaged
 * desktop the indicator would report nothing for the whole real download and
 * then snap to 100% off the local cache read. It stays gated until that path
 * reports progress.
 *
 * Absence from a future generic flag surface is only half a retirement — the other half is the
 * PERSISTED residue, which this file does not own. `session-timeline-jump-feedback`
 * was a real user-toggleable Labs entry, so an install that touched it still
 * carries the raw key; it is swept via `RETIRED_LABS_SETTING_KEYS` in
 * `src/main/settings/settings-migrations.ts` (same split the ISS-6121 note above
 * describes), and `settings-migration-retired-labs-keys.test.ts` pins that.
 * `sessions-cache-write-ttl` needs no sweep — it was never registered here, so
 * no desktop install ever persisted it.
 */
test("ISS-5820/ISS-6006: the retired session-detail gates are gone from a future generic flag surface", () => {
  for (const retiredKey of [
    "session-timeline-jump-feedback",
    "sessions-cache-write-ttl",
  ]) {
    assert.equal(
      FEATURE_FLAGS.find((f) => f.key === retiredKey),
      undefined,
      `${retiredKey} must not be offered in a future generic flag surface: nothing reads it`
    );
  }
});

// ISS-5271: shared web+desktop UI flags gating surfaces that mount on
// web AND desktop (both on `SessionsSummaryCards`), so a split literal would let
// a change land on one surface and stay dark on the other — the exact leak the
// ISS-4779 closed-by-default policy requires both gates to prevent. Asserted as
// literals because this main-process module deliberately does not import
// `@repo/app`. (ISS-5131 removed the retired Duration qualifier gate from this
// loop; the assertion that it is GONE from the panel lives above.)
for (const [desktopKey, sharedLiteral] of [
  // ISS-5842: the unified delta-chip treatment. `MetricCard` and the Insights
  // `TrendBadge` mount on web AND desktop (Sessions strip, Branches strip,
  // first-launch dashboard), so a split literal would restyle every delta on one
  // surface and leave the other on the old chip — the leak the closed-by-default
  // policy requires both gates to prevent.
  [
    DESKTOP_METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY,
    "metric-delta-unified-pill",
  ],
  // ISS-6493: the neutral half of the treatment above, on its own key. Same
  // primitives and the same web+desktop mount sites, so a split literal would
  // pill the neutral tone on one surface and leave it bare on the other.
  [
    DESKTOP_METRIC_DELTA_NEUTRAL_PILL_FEATURE_FLAG_KEY,
    "metric-delta-neutral-pill",
  ],
  // ISS-7845: the Sessions delivery pair's absent-value dash taking the shared
  // primitive's muted no-data treatment. `SessionsSummaryCards` mounts on web
  // AND desktop, so a split literal would leave one surface showing two weights
  // for one absent value while the other showed one.
  [
    DESKTOP_SESSIONS_DELIVERY_CARD_NO_DATA_FEATURE_FLAG_KEY,
    "sessions-delivery-card-no-data",
  ],
  [
    DESKTOP_SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY,
    "sessions-summary-honest-loading",
  ],
  // ISS-5951: the Branch PR timeline's fallback-cost marker. `BranchDetailPage`
  // mounts on web AND desktop, so a split key would mark a fallback headline
  // cost on one surface while the other kept presenting the same figure as the
  // branch's authoritative total.
  [
    DESKTOP_BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY,
    "branch-timeline-cost-fallback-marker",
  ],
  // ISS-7229: the session-detail Claude-reported cost row. `SessionPropertiesPanel`
  // mounts on web AND desktop, so a split key would show Claude's figure beside
  // our estimate on one surface while the other still presented the estimate as
  // the only cost the session has.
  [
    DESKTOP_SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY,
    "session-claude-reported-cost",
  ],
  // ISS-7259: the session-detail harness launch-attribution rows.
  // `SessionPropertiesPanel` mounts on web AND desktop, so a split key would say
  // how a thread came to run on one surface while the other showed nothing —
  // and the desktop is the PRODUCER of the facet as well as a surface for it.
  [
    DESKTOP_SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY,
    "session-launch-attribution",
  ],
  // ISS-7737: the session-detail rows naming the population each figure counts.
  // `SessionPropertiesPanel` mounts on web AND desktop, and the desktop is a
  // PRODUCER of the mismatch as well as a surface for it — its parser writes
  // `agent_turns` from the parent transcript while folding token usage over
  // every delegated subagent file — so a split key would name the populations on
  // one surface while the other kept a parent-only turn count sitting four rows
  // from a subagent-folded rollup with nothing said about either.
  [
    DESKTOP_SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY,
    "session-metric-population-disclosure",
  ],
  // ISS-5637: the session-detail Tokens row's reachable unknown state.
  // `SessionPropertiesPanel` mounts on web AND desktop, and the desktop is a
  // PRODUCER of the four zeros as well as a surface for them, so a split key
  // would let one surface dash a zero-usage session's tokens while the other
  // kept asserting "0 in | 0 out | 0 cache read | 0 cache write" beside a Cost
  // row already dashing for want of that very usage.
  [
    DESKTOP_SESSION_TOKENS_RECORDED_HONESTY_FEATURE_FLAG_KEY,
    "session-tokens-recorded-honesty",
  ],
  // ISS-5566: the Session Timeline's unmeasured-cost disclosure. The strip is
  // rendered by `AgentSessionDetailView` on web AND desktop, so a split key
  // would withdraw the synthesized dollar figures on one surface while the other
  // kept presenting them as measured money.
  [
    DESKTOP_SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY,
    "session-timeline-synthesized-cost",
  ],
  // ISS-7427: the Session Trace count's evidence disclosure. The header is
  // rendered by `AgentSessionDetailView` on web AND desktop, and the desktop is a
  // PRODUCER of the state as well as a surface for it — `syncTierAllowsTranscripts`
  // permits the transcript lane only on the `full` tier — so a split key would
  // name the count's population on one surface while the other kept a bare
  // "N events" sitting over a panel saying the transcript was never archived.
  [
    DESKTOP_SESSION_TRACE_EVIDENCE_DISCLOSURE_FEATURE_FLAG_KEY,
    "session-trace-evidence-disclosure",
  ],
  // ISS-8652: the Session Trace's idle rows. `SessionTrace` is mounted from
  // `packages/app` by the Session detail transcript panel AND the branch merged
  // trace, on web and desktop alike, so a split key would render the pause on
  // one surface while the other kept two turns adjacent with the minutes between
  // them unaccounted for.
  [DESKTOP_SESSION_TRACE_IDLE_ROWS_FEATURE_FLAG_KEY, "session-trace-idle-rows"],
  // ISS-7427 AC5: the Session Timeline's coverage disclosure. The strip is
  // rendered by `AgentSessionDetailView` on web AND desktop, so a split key
  // would say the bars cover only synced activity on one surface while the other
  // kept drawing the same tiling as if it measured the whole session.
  [
    DESKTOP_SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY,
    "session-timeline-coverage-disclosure",
  ],
  // ISS-7516: the transcript panel's never-expected absence state.
  // `SessionTranscriptPanel` mounts on web AND desktop, so a split key would
  // let one surface distinguish a transcript that is never coming from one
  // still on its way while the other kept telling every metadata-level machine
  // that its source machine would upload something it never queued.
  [
    DESKTOP_SESSION_TRANSCRIPT_NEVER_EXPECTED_FEATURE_FLAG_KEY,
    "session-transcript-never-expected",
  ],
  // ISS-8427: session detail's plural Branches row. `SessionPropertiesPanel`
  // mounts on web AND desktop through `AgentSessionDetailView`, so a split key
  // would list every branch the session touched on one surface while the other
  // kept naming one of them and nothing else.
  [
    DESKTOP_SESSION_TOUCHED_BRANCHES_FEATURE_FLAG_KEY,
    "session-touched-branches",
  ],
] as const) {
  test(`${desktopKey} is a Labs flag, default OFF, and round-trips through getFlag/setFlag`, () => {
    assert.equal(desktopKey, sharedLiteral);

    const def = FEATURE_FLAGS.find((f) => f.key === desktopKey);
    assert.ok(def, "flag must be registered in FEATURE_FLAGS");
    assert.equal(def.default, false, "flag must default OFF");
    assert.equal(def.category, "Labs");
    assert.notEqual(
      def.hiddenFromLabs,
      true,
      "flag must remain an exposed Labs gate"
    );

    const store = makeFeatureFlagStore();
    assert.equal(store.getFlag(desktopKey as FlagKey), false);
    store.setFlag(desktopKey as FlagKey, true);
    assert.equal(store.getFlag(desktopKey as FlagKey), true);
  });
}

/**
 * ISS-6954/6955/6957/6958: the Branch detail outcome presentation.
 *
 * No `DESKTOP_…` alias exists for it — both surfaces read the one `@repo/api`
 * leaf — so this pins the leaf against the RAW literal rather than against
 * itself, which would assert nothing. The web alias is pinned to the same
 * literal in
 * `packages/app/branches/components/__tests__/branch-detail-metric-honesty.test.tsx`.
 * Neither surface imports the other, so those two raw pins together are what
 * stop a rename leaving one surface naming the outcome measurement twice while
 * the other names it once.
 */
test("ISS-6954: branch-detail-metric-honesty is a Labs flag, default OFF, and round-trips through getFlag/setFlag", () => {
  assert.equal(
    BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY,
    "branch-detail-metric-honesty"
  );

  const def = FEATURE_FLAGS.find(
    (f) => f.key === BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY
  );
  assert.ok(def, "flag must be registered in FEATURE_FLAGS");
  assert.equal(def.default, false, "flag must default OFF");
  assert.equal(def.category, "Labs");
  assert.notEqual(
    def.hiddenFromLabs,
    true,
    "flag must remain an exposed Labs gate"
  );

  const store = makeFeatureFlagStore();
  const key = BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY as FlagKey;
  assert.equal(store.getFlag(key), false);
  store.setFlag(key, true);
  assert.equal(store.getFlag(key), true);
});
