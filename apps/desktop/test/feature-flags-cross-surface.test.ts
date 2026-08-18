import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AGENT_COLLABORATION_NETWORK_FLAG_KEY } from "@repo/api/src/types/agent-collaboration-network-flag";
import { GRID_TABLE_V2_FLAG_KEY } from "@repo/api/src/types/grid-table-v2-flag";
import { INSIGHTS_SPEND_OUTCOME_FLAG_KEY } from "@repo/api/src/types/insights-spend-outcome-flag";
import { SESSION_TIMELINE_COLUMN_HIT_TARGET_FLAG_KEY } from "@repo/api/src/types/session-timeline-column-hit-target-flag";
import { SESSIONS_BRANCHES_TAB_TITLES_FLAG_KEY } from "@repo/api/src/types/sessions-branches-tab-titles-flag";
import { SESSIONS_GRID_FOLD_LEGIBILITY_FLAG_KEY } from "@repo/api/src/types/sessions-grid-fold-legibility-flag";
import {
  DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY,
  DESKTOP_BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY,
  DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY,
  DESKTOP_INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY,
  DESKTOP_METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_PHASE_CONFIDENCE_DISCLOSURE_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_DISPLAYED_STATUS_PARITY_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_DURATION_CALENDAR_QUALIFIER_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY,
  FEATURE_FLAGS,
  type FlagKey,
} from "../src/shared/feature-flags.js";
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

// ISS-4890/4906/4901 and ISS-4887: both shared web+desktop UI flags must be
// registered as Labs toggles on desktop, default OFF (ISS-4779
// closed-by-default), with literals equal to the PostHog keys so the features
// cannot leak on one surface while hidden on the other. The packaged desktop
// renderer has no PostHog wiring, so without a registry entry a desktop user
// could never opt in — and the shared key would fall through to the build-type
// default (ON in dev), which is the leak these guard.
for (const { issue, desktopKey, sharedKey } of [
  {
    issue: "GridTable v2",
    desktopKey: DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY,
    sharedKey: GRID_TABLE_V2_FLAG_KEY,
  },
  {
    issue: "ISS-4890/4906/4901",
    desktopKey: DESKTOP_SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY,
    sharedKey: SESSIONS_GRID_FOLD_LEGIBILITY_FLAG_KEY,
  },
  {
    issue: "ISS-4463",
    desktopKey: DESKTOP_INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY,
    sharedKey: INSIGHTS_SPEND_OUTCOME_FLAG_KEY,
  },
  // ISS-5548: the Session Timeline's column-height hit target.
  // `SessionActivityTimeline` mounts on web AND desktop, so a split key would
  // make a quiet bucket easy to hit on one surface and a ~6px sliver on the
  // other. Both surface aliases resolve to this one `@repo/api` literal.
  {
    issue: "ISS-5548",
    desktopKey: DESKTOP_SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY,
    sharedKey: SESSION_TIMELINE_COLUMN_HIT_TARGET_FLAG_KEY,
  },
  {
    issue: "ISS-5574",
    desktopKey: DESKTOP_SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
    sharedKey: SESSIONS_BRANCHES_TAB_TITLES_FLAG_KEY,
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
      "flag must render in the Labs panel"
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
    desktopKey: DESKTOP_SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY,
    e2eLiteral: "sessions-grid-fold-legibility",
    spec: "sessions-column-fold.spec.ts",
  },
]) {
  test(`${desktopKey} matches the literal ${spec} seeds`, () => {
    assert.equal(desktopKey, e2eLiteral);
  });
}

// ISS-4979 / ISS-4978 -> ISS-5131 (#4409): both session-Duration gates are
// RETIRED and their Labs entries are GONE. The corrected Duration rule computes
// no number at all for an unmeasurable window (so the em-dash is not a semantic
// a gate can flip), and there is one Duration measure now (so there is no
// qualifier to choose). Nothing reads either key.
//
// ISS-6121 removes the unused unmeasurable-span constants; persisted
// compatibility is owned by the settings migration, not dead runtime exports.
// Both retired switches must remain absent from Labs.
test("ISS-5131: the two retired session-Duration flags are gone from the Labs panel", () => {
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
      `${retiredKey} must not be offered in the Labs panel: nothing reads it`
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
 * Absence from the Labs panel is only half a retirement — the other half is the
 * PERSISTED residue, which this file does not own. `session-timeline-jump-feedback`
 * was a real user-toggleable Labs entry, so an install that touched it still
 * carries the raw key; it is swept via `RETIRED_LABS_SETTING_KEYS` in
 * `src/main/settings/settings-migrations.ts` (same split the ISS-6121 note above
 * describes), and `settings-migration-retired-labs-keys.test.ts` pins that.
 * `sessions-cache-write-ttl` needs no sweep — it was never registered here, so
 * no desktop install ever persisted it.
 */
test("ISS-5820/ISS-6006: the retired session-detail gates are gone from the Labs panel", () => {
  for (const retiredKey of [
    "session-timeline-jump-feedback",
    "sessions-cache-write-ttl",
  ]) {
    assert.equal(
      FEATURE_FLAGS.find((f) => f.key === retiredKey),
      undefined,
      `${retiredKey} must not be offered in the Labs panel: nothing reads it`
    );
  }
});

// ISS-4773 / ISS-5271: shared web+desktop UI flags gating surfaces that mount on
// web AND desktop (both on `SessionsSummaryCards`), so a split literal would let
// a change land on one surface and stay dark on the other — the exact leak the
// ISS-4779 closed-by-default policy requires both gates to prevent. Asserted as
// literals because this main-process module deliberately does not import
// `@repo/app`. (ISS-5131 removed the retired Duration qualifier gate from this
// loop; the assertion that it is GONE from the panel lives above.)
for (const [desktopKey, sharedLiteral] of [
  [
    DESKTOP_SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY,
    "sessions-cost-billing-honesty",
  ],
  // ISS-5842: the unified delta-chip treatment. `MetricCard` and the Insights
  // `TrendBadge` mount on web AND desktop (Sessions strip, Branches strip,
  // first-launch dashboard), so a split literal would restyle every delta on one
  // surface and leave the other on the old chip — the leak the closed-by-default
  // policy requires both gates to prevent.
  [
    DESKTOP_METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY,
    "metric-delta-unified-pill",
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
  // ISS-5566: the Session Timeline's unmeasured-cost disclosure. The strip is
  // rendered by `AgentSessionDetailView` on web AND desktop, so a split key
  // would withdraw the synthesized dollar figures on one surface while the other
  // kept presenting them as measured money.
  [
    DESKTOP_SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY,
    "session-timeline-synthesized-cost",
  ],
  // ISS-5564: the Activity breakdown's confidence-basis note.
  // `SessionActivityBreakdown` mounts on web AND desktop, so a split key would
  // explain the `Conf. 0%` / precise-dollars contradiction on one surface and
  // leave the other asserting both without comment.
  [
    DESKTOP_SESSION_PHASE_CONFIDENCE_DISCLOSURE_FEATURE_FLAG_KEY,
    "session-phase-confidence-disclosure",
  ],
  // ISS-4556 / ISS-4559: the Sessions displayed-status SSOT. The desktop Local
  // lane and the cloud read path each derive the row status and the Status facet
  // for the SAME shared table, so a split key would let the Status column read
  // "Waiting" on one surface and "Active" on the other — which is the defect
  // this flag gates the fix for, reintroduced by the gate itself.
  [
    DESKTOP_SESSIONS_DISPLAYED_STATUS_PARITY_FEATURE_FLAG_KEY,
    "sessions-displayed-status-parity",
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
      "flag must render in the Labs panel"
    );

    const store = makeFeatureFlagStore();
    assert.equal(store.getFlag(desktopKey as FlagKey), false);
    store.setFlag(desktopKey as FlagKey, true);
    assert.equal(store.getFlag(desktopKey as FlagKey), true);
  });
}
