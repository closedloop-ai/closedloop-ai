/**
 * @file feature-flags-labs-detail.ts
 * @description The Labs gates over WHAT A SURFACE SAYS ABOUT ITS OWN NUMBERS AND
 * PROVENANCE — the Insights and chart passes, the cost/metric honesty passes,
 * the Agents detail and definition disclosures, the withheld/coverage
 * diagnostics — together with the `labsNav` container gate that sits inside the
 * same run. Split out of `feature-flags.ts` (ISS-7431).
 *
 * Contiguous run, spread back at its original index for review stability.
 * Registry order is no longer a rendered UI contract because ISS-8753 deleted
 * Settings -> Labs.
 */

import { AGENT_COLLABORATION_NETWORK_FLAG_KEY } from "@repo/api/src/types/agent-collaboration-network-flag";
// ISS-4774: leaf, dependency-free constant (no Zod, no `@repo/app`) — safe in
// this main-process module. Both surfaces import this same literal so a rename
// can't silently split the PostHog key from the Desktop registry entry that
// carries its settings metadata (whitlockk, PR #4202).
import { AGENTS_DEFAULT_SORT_USAGE_FLAG_KEY } from "@repo/api/src/types/agents-default-sort-usage-flag";
import { AGENTS_DEFINITION_EMPTY_STATE_FLAG_KEY } from "@repo/api/src/types/agents-definition-empty-state-flag";
import { AGENTS_DETAIL_HONESTY_FLAG_KEY } from "@repo/api/src/types/agents-detail-honesty-flag";
import { AGENTS_NAV_FLAG_KEY } from "@repo/api/src/types/agents-nav-flag";
import { AGENTS_SOURCE_PROVENANCE_FLAG_KEY } from "@repo/api/src/types/agents-source-provenance-flag";
import { AGENTS_TYPE_TAB_OVERFLOW_FLAG_KEY } from "@repo/api/src/types/agents-type-tab-overflow-flag";
import { CHART_DISTINGUISHABLE_SERIES_FLAG_KEY } from "@repo/api/src/types/chart-distinguishable-series-flag";
import { INSIGHTS_SPEND_OUTCOME_FLAG_KEY } from "@repo/api/src/types/insights-spend-outcome-flag";
import { SESSIONS_CUSTOM_DATE_WINDOW_FLAG_KEY } from "@repo/api/src/types/sessions-custom-date-window-flag";
import { SHOW_REDACTED_SYNC_LEVEL_FLAG_KEY } from "@repo/api/src/types/show-redacted-sync-level-flag";

/**
 * Gates whether the "Redacted sessions" level is offered in the Settings →
 * Data & Sync picker. OFF by default (ISS-4779 closed-by-default): the
 * redaction lane is not plumbed yet — `dataSyncLevelToBooleans` derives the
 * same booleans for `redacted` as `metadata`, so today it behaves as
 * metadata-only — and offering a level that can't do what its name implies
 * misstates what leaves the device. When ON, the option is shown again so the
 * lane can be dogfooded/rolled out. The `redacted` VALUE stays in the enum,
 * copy map, boolean mapping, and `legacyFlagsToDataSyncLevel` migration
 * regardless, so persisted/migrated `redacted` values remain valid; only the
 * picker's rendered option set is gated. The onboarding sync-consent omits
 * redacted unconditionally and does not read this key.
 *
 * ALIASES the shared `@repo/api` {@link SHOW_REDACTED_SYNC_LEVEL_FLAG_KEY}
 * rather than redeclaring the literal (PLN-1915 Step 4). The Settings v2
 * Connected Devices panel offers the same choice about the same machine from
 * `packages/app`, which cannot import from `apps/desktop`, so the two read one
 * definition and a rename touches one place. The registry entry below stays
 * here: the renderer resolves this shared key from the signed-in account's
 * PostHog assignment (ISS-8753), so the entry carries only the key's default-off
 * main-process settings metadata.
 */
export const DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY =
  SHOW_REDACTED_SYNC_LEVEL_FLAG_KEY;
/**
 * ISS-5842: shared web+desktop UI flag (kebab-case, PostHog key
 * "metric-delta-unified-pill") gating the unified delta-chip treatment on the
 * shared metric primitives — one pill geometry per tone, colour-only variation,
 * and no "better"/"worse" verdict word.
 *
 * `MetricCard` and the Insights `TrendBadge` mount on the desktop renderer as
 * well as the web app — the Sessions strip, the Branches strip and the
 * first-launch dashboard all render them — and the renderer resolves this shared
 * key from the signed-in account's PostHog assignment, the same key space the
 * web app reads, so it cannot light up on one surface while hidden on the other.
 * Off by default (ISS-4779 closed-by-default). Must
 * stay byte-for-byte equal to `METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`; the literal is redeclared here
 * (instead of imported) to keep this main-process module free of the
 * `@repo/app` transitive graph.
 */
export const DESKTOP_METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY =
  "metric-delta-unified-pill";
/**
 * ISS-6493: shared web+desktop UI flag (kebab-case, PostHog key
 * "metric-delta-neutral-pill") gating ONLY the neutral delta chip taking the
 * same pill as its scored siblings — the half of ISS-5842 that the #4823
 * sentiment-cue question does not block, because a neutral delta asserts no
 * good/bad reading for hue to be left carrying. The verdict word is untouched
 * under both states of this flag.
 *
 * Registered here for the same reason its unified sibling is: the renderer
 * resolves this shared key from the signed-in account's PostHog assignment, so
 * the entry carries only the key's default-off main-process settings metadata
 * and the neutral pill cannot land on one surface alone. Off by default (ISS-4779
 * closed-by-default). Must stay byte-for-byte equal to
 * `METRIC_DELTA_NEUTRAL_PILL_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`; the literal is redeclared here
 * (instead of imported) to keep this main-process module free of the
 * `@repo/app` transitive graph.
 */
export const DESKTOP_METRIC_DELTA_NEUTRAL_PILL_FEATURE_FLAG_KEY =
  "metric-delta-neutral-pill";
/**
 * ISS-7845: shared web+desktop UI flag (kebab-case, PostHog key
 * "sessions-delivery-card-no-data") gating the two Sessions delivery cards
 * dashing through `MetricCard`'s own no-data treatment rather than a literal em
 * dash handed in as a value — so all five cards in the strip render one absent
 * value one way, muted at normal weight, instead of two.
 *
 * `SessionsSummaryCards` mounts on the desktop renderer as well as the web app,
 * and the renderer resolves this shared key from the signed-in account's PostHog
 * assignment — the same key space the web app reads — so it cannot light up on
 * one surface while hidden on the other. Off by default (ISS-4779
 * closed-by-default). Must stay byte-for-byte equal to
 * `SESSIONS_DELIVERY_CARD_NO_DATA_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`; the literal is redeclared here
 * (instead of imported) to keep this main-process module free of the
 * `@repo/app` transitive graph.
 */
export const DESKTOP_SESSIONS_DELIVERY_CARD_NO_DATA_FEATURE_FLAG_KEY =
  "sessions-delivery-card-no-data";
/**
 * ISS-4922: desktop-only Labs flag gating the AUTHORED PR gate on the Local
 * session lane. With it ON, the Local lane admits a PR into a session's PR set
 * only when the session AUTHORED it — the same rule the cloud projection has
 * enforced since FEA-3584/FEA-3585 (extended to the legacy blob by ISS-4768) —
 * so a Referenced/Reviewed-only session stops rendering a pill on Local while
 * reading "Pull requests: None" on web. (The flag also used to stop an
 * abandoned-to-Completed rescue reading the same set; ISS-6588 removed that
 * rescue, and the pill is what this gate protects now.) Default OFF because
 * suppressing an already-rendered pill is a user-perceivable removal
 * (closed-by-default UI policy). Desktop-only surface: the cloud lane is already
 * gated in code, so there is no web flag to keep in parity.
 */
export const DESKTOP_LOCAL_SESSION_AUTHORED_PR_GATE_FEATURE_FLAG_KEY =
  "localSessionAuthoredPrGate";
/**
 * ISS-7830 (ISS-4779 closed-by-default): desktop-only Labs flag gating whether
 * this device RECORDS that a user opened a thread — the signal that then
 * overrides the launch-time headless default for an agent-spawned thread.
 *
 * It gates the CAPTURE, not the classification read, and that is not an
 * implementation detail. The gate is a main-process resolver, and the read runs
 * in the db-host child, which has its own module registry and would see the
 * `false` default forever. Gating the capture also makes every flag state
 * honest: with it off no row exists, so nothing is recorded-but-suppressed and
 * no session can go stale on the cloud the moment someone flips the toggle.
 *
 * Off by default because the classification it can flip is rendered (the autonomy
 * score, and the same value on the cloud row this device syncs). Desktop-only
 * surface: the capture, the store and the classification all live in the desktop
 * main process, and `apps/app` has no analogue in this change, so there is no web
 * flag this could leak past.
 */
export const DESKTOP_THREAD_VIEWERSHIP_SIGNAL_FEATURE_FLAG_KEY =
  "threadViewershipSignal";
/**
 * ISS-4463 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the Insights "Spend by outcome" tiles — the TokenOps lens splitting AI
 * spend by how the originating session ended. The desktop renderer resolves this
 * shared key from the signed-in account's PostHog assignment — the same key
 * space the web app reads — so the lens cannot leak on desktop while hidden on
 * web; this entry carries only the key's default-off main-process settings
 * metadata. Aliases the shared
 * `@repo/api` constant rather than redeclaring the literal, so a rename touches
 * one definition.
 */
export const DESKTOP_INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY =
  INSIGHTS_SPEND_OUTCOME_FLAG_KEY;
/**
 * FEA-4201 (ISS-4779 closed-by-default policy): the desktop half of the Sessions
 * explicit from/to date-window gate. This renderer mounts the same Sessions
 * listing and reads its facets from the same URL, so both surfaces are gated and
 * neither can offer a Custom window the other silently ignores. Aliases the
 * shared `@repo/api` constant rather than redeclaring the literal, so a rename
 * touches one definition.
 */
export const DESKTOP_SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY =
  SESSIONS_CUSTOM_DATE_WINDOW_FLAG_KEY;
/**
 * ISS-5061 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the "Agent Collaboration Network" row on the Insights overview
 * dashboard. The desktop renderer resolves this shared key from the signed-in
 * account's PostHog assignment — the same key space the web app reads — so the
 * row cannot leak on desktop while hidden on web; this entry carries only the
 * key's default-off main-process settings metadata. Aliases the shared
 * `@repo/api` constant rather than redeclaring the literal, so a rename touches
 * one definition.
 *
 * DELIBERATELY RE-INTRODUCED after ISS-5280 (#4482) retired it.
 */
export const DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY =
  AGENT_COLLABORATION_NETWORK_FLAG_KEY;
/**
 * ISS-5523 (ISS-4779 closed-by-default policy): the desktop half of the
 * distinguishable-series gate. The Insights dashboard row and tile that draw
 * per-model series mount on this renderer as well as the web app, so both
 * surfaces are gated and neither can keep cycling the categorical palette while
 * the other stops. Aliases the shared `@repo/api` constant rather than
 * redeclaring the literal, so a rename touches one definition.
 */
export const DESKTOP_CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY =
  CHART_DISTINGUISHABLE_SERIES_FLAG_KEY;
/**
 * ISS-5037 (ISS-4779 closed-by-default policy): the desktop half of the Labs
 * nav gate — ONE boolean over the ENTIRE Labs navigation section, not a
 * per-item flag.
 *
 * OFF (default): the Labs section does not render at all (no header, no items),
 * and every destination that DISPLAYS under Labs is unreachable — `App.tsx`
 * hides those nav ids and falls a direct `#/insights`-style hash nav through to
 * Sessions, the same shape the `docsHelp` route gate already uses.
 * ON: the section appears exactly as it does today.
 *
 * Desktop-owned (camelCase, persisted `DesktopSettings` field) because its
 * control is NOT a Labs-panel toggle: it is the deliberately subtle "Enable
 * Labs" checkbox in the native application menu (`main/app-menu.ts`), which is
 * why this entry is `hiddenFromLabs` — a Labs-panel row would both defeat the
 * easter egg and be self-referential. What that checkbox writes is the persisted
 * main-process settings value; the RENDERED section resolves from the signed-in
 * account's PostHog assignment (ISS-8753), the same key space the web app reads,
 * so the section cannot appear on one surface while hidden on the other.
 *
 * This gates the CONTAINER only. The per-item Labs flags inside it
 * (`docsHelp`, `agentsNav`, …) keep their own persisted values —
 * turning the container off never writes to them, so flipping it back on
 * restores the previous per-item state intact.
 *
 * The web half of ISS-5037 is a PostHog flag with a different mechanism and key
 * (`LABS_NAV_SECTION_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`), so there is no shared literal to
 * alias here — only the closed-by-default posture is shared.
 */
export const DESKTOP_LABS_NAV_FEATURE_FLAG_KEY = "labsNav";
/**
 * ISS-5005 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the Agents catalog landing on a usage-bearing default sort
 * (Invocations descending) instead of Component ascending, plus the one-time
 * rewrite of a persisted view still carrying the never-touched legacy default.
 *
 * The catalog (`AgentsGroupedList` via `useAgentComponentsViewState`) mounts on
 * the desktop renderer under the `agents:desktop` persistence key as well as on
 * web. The renderer reads the signed-in PostHog assignment, so this shared key stays paired with its web counterpart. Aliases the shared `@repo/api`
 * constant rather than redeclaring the literal, so a rename touches one
 * definition.
 */
export const DESKTOP_AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY =
  AGENTS_DEFAULT_SORT_USAGE_FLAG_KEY;
/**
 * ISS-5009 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the Agents catalog Source column telling the truth about provenance it
 * does not have — the em-dash empty glyph instead of the component's own
 * identifier echoed back, the honest source type beside a real source value, and
 * a Source facet whose options, counts and membership agree with the cell.
 *
 * The catalog (`AgentsTable` / `AgentsGroupedList`) mounts on the desktop
 * renderer as well as on web. The desktop renderer reads the signed-in PostHog assignment for this key, matching web. Aliases the shared
 * `@repo/api` {@link AGENTS_SOURCE_PROVENANCE_FLAG_KEY} constant rather than
 * redeclaring the literal, so a rename touches one definition.
 */
export const DESKTOP_AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY =
  AGENTS_SOURCE_PROVENANCE_FLAG_KEY;

/**
 * ISS-5500 (ISS-4779 closed-by-default): shared web+desktop UI flag gating the
 * Agents component detail Definition panel naming WHY it has no body — "no
 * definition recorded" for an identity that was only ever seen by name, versus
 * "could not be read" / "failed to load" for one the org actually holds.
 *
 * `AgentDetail` mounts on the desktop renderer as well as on web. The desktop
 * renderer resolves this shared key from the signed-in account's PostHog
 * assignment — the same key space the web app reads — so the change cannot leak
 * on desktop while hidden on web; this entry carries only the key's default-off
 * main-process settings metadata. Aliases the shared `@repo/api`
 * {@link AGENTS_DEFINITION_EMPTY_STATE_FLAG_KEY} constant rather than
 * redeclaring the literal, so a rename touches one definition.
 */
export const DESKTOP_AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY =
  AGENTS_DEFINITION_EMPTY_STATE_FLAG_KEY;

/**
 * ISS-5518 / ISS-5519 (ISS-4779 closed-by-default): shared web+desktop UI flag
 * gating the Agents component detail page saying only what it can back up — no
 * raw content-hash digest under the title, and no permanently-dashed "Lines
 * shipped" / "Total cost" cards reading as `LOC / $`'s missing operands.
 *
 * ISS-6462 removed the ISS-5521 "Merged PRs" cap disclosure from this flag's
 * scope: the Packs Performance tile discloses the same cap off the same field
 * ungated, so gating it here left the two screens contradicting each other on
 * the default path.
 *
 * `AgentDetail` is the desktop component-detail view as well as the web one. The
 * renderer reads the signed-in PostHog assignment, so this shared key stays paired with its web counterpart. Aliases the shared `@repo/api`
 * {@link AGENTS_DETAIL_HONESTY_FLAG_KEY} constant rather than redeclaring the
 * literal, so a rename touches one definition.
 */
export const DESKTOP_AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY =
  AGENTS_DETAIL_HONESTY_FLAG_KEY;

/**
 * ISS-4803 (ISS-4779 closed-by-default): shared web+desktop UI flag gating the
 * Agents catalog type-tab strip disclosing the tabs it cannot fit behind a real
 * overflow menu, instead of clipping them behind an edge fade.
 *
 * `AgentsGroupedList` is the desktop Agents view as well as the web one, and the
 * desktop window resizes below the width the eight-segment strip needs. The
 * renderer reads the signed-in PostHog assignment, so this shared key stays paired with its web counterpart. Aliases the shared `@repo/api`
 * {@link AGENTS_TYPE_TAB_OVERFLOW_FLAG_KEY} constant rather than redeclaring the
 * literal, so a rename touches one definition.
 */
export const DESKTOP_AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY =
  AGENTS_TYPE_TAB_OVERFLOW_FLAG_KEY;

/**
 * PRD-538 (R5 + R6): the ONE gate over the whole subscription session-limits
 * feature — the `/usage` capture (ISS-5353) and the nav bars + drawer that
 * render it (ISS-5354). ISS-5354 must REUSE this key rather than mint a second:
 * a separate UI key would let the capture run (reading a credential, calling an
 * external endpoint) while the bars stayed hidden, which is precisely the leak
 * the closed-by-default policy exists to prevent. Desktop-only, so there is no
 * second web surface to keep in parity.
 *
 * ISS-8792 — ONE VERDICT, and it is the PostHog assignment. The two halves used
 * to read this one key through different ports: the renderer from the signed-in
 * account's assignment, the main-process capture from the persisted settings
 * value. A stored opt-in therefore kept main reading a credential and issuing
 * `/usage` requests while the footer stayed dark. Main now resolves the same
 * assignment through `main/session-limits/session-limits-gate.ts`, which
 * re-attempts when the verdict lands because `UsageApiService.start()` schedules
 * no timer while its gate reads closed.
 */
export const DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY =
  "subscriptionSessionLimits";

/**
 * ISS-5266 (ISS-4779 closed-by-default): gates the Diagnostics → Withheld tab,
 * which reports OpenCode subagent sessions the collector withheld because their
 * root row could not be parsed, so the resulting under-count stops reading as a
 * real zero. Off by default; with it off Diagnostics renders exactly as it does
 * today and the tab is neither listed nor reachable.
 *
 * Desktop-only surface — `apps/app` has no analogue of the local-collector
 * Diagnostics view, so there is no second web surface to keep in parity; the
 * renderer still resolves this key from the signed-in account's PostHog
 * assignment, like every other UI gate. The durable record itself is written
 * regardless of the flag: withholding data because a display toggle is off would
 * recreate the very gap this ticket closes.
 */
export const DESKTOP_OPENCODE_WITHHELD_DIAGNOSTICS_FEATURE_FLAG_KEY =
  "opencode-withheld-diagnostics";

/**
 * ISS-6758 (ISS-4779 closed-by-default): gates the Diagnostics → Coverage tab,
 * the PRD-488 FR-12 self-measurement read — what share of ingested spend the
 * activity classifier confidently attributed, sliced by harness, autonomy band,
 * ClosedLoop-user and session length, so a weak cohort is visible rather than
 * averaged away. Off by default; with it off Diagnostics renders exactly as it
 * does today and the tab is neither listed nor reachable.
 *
 * Desktop-only surface — `apps/app` has no analogue of the local-collector
 * Diagnostics view, so there is no second web surface to keep in parity; the
 * renderer still resolves this key from the signed-in account's PostHog
 * assignment, like every other UI gate. Only the
 * DISPLAY is gated: the rollup rows this reads have been written on every import
 * since FEA-2273 and the read runs with the panel, so turning the toggle on
 * never has to wait for a re-import.
 */
export const DESKTOP_ACTIVITY_COVERAGE_DIAGNOSTICS_FEATURE_FLAG_KEY =
  "activity-coverage-diagnostics";

/** Registry entries for the metric and detail gates, in registry order. */
export const LABS_DETAIL_FEATURE_FLAGS = [
  {
    // ISS-4463 (ISS-4779 closed-by-default): shared web+desktop UI flag gating
    // the Insights "Spend by outcome" tiles. Off by default — with it off the
    // tiles are neither offered in the metric picker nor rendered on a
    // dashboard. Observable-only.
    key: DESKTOP_INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY,
    default: false,
    label: "Insights spend by session outcome",
    description:
      "Splits Insights AI spend by how the session ended: clean, errored, still running, or never recorded.",
    category: "Labs" as const,
  },
  {
    // FEA-4201 (ISS-4779 closed-by-default): shared web+desktop UI flag gating
    // the Sessions listing's explicit from/to date window — the `?from=`/`?to=`
    // params, the Custom entry point beside the preset pills, and the clear
    // control beside it. Off by default; with it off the listing reads over the
    // rolling preset exactly as before and both params are inert.
    key: DESKTOP_SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY,
    default: false,
    label: "Custom Sessions date range",
    description:
      "Adds a custom from/to window to the Sessions time filter, so you can narrow the list to an exact span, down to a single day.",
    category: "Labs" as const,
  },
  {
    // ISS-5061 (ISS-4779 closed-by-default): shared web+desktop UI flag gating
    // the Agent Collaboration Network row on the Insights overview dashboard.
    // Off by default — with it off the row is absent entirely rather than
    // drawing the graph's own empty state. Observable-only. Deliberately
    // re-introduced after ISS-5280 (#4482) retired it.
    key: DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY,
    default: false,
    label: "Agent collaboration network",
    description:
      "Adds a dashboard row graphing how your agents hand work to each other, built from the subagents your sessions spawned.",
    category: "Labs" as const,
  },
  {
    // ISS-5523 (ISS-4779 closed-by-default): gates distinguishable series
    // colors on the per-model time-series charts. Off by default — with it off
    // those charts keep cycling the 10-color categorical palette, so a chart
    // with more series than that draws unrelated series in the same fill.
    // Observable-only: it changes how series are colored and grouped, never
    // which usage is counted.
    key: DESKTOP_CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY,
    default: false,
    label: "Distinguishable chart series colors",
    description:
      'Caps per-model charts at one series per distinguishable color and groups the rest into a neutral "Other" band.',
    category: "Labs" as const,
  },
  {
    // ISS-5842 (ISS-4779 closed-by-default): shared web+desktop UI flag gating
    // the unified delta-chip treatment on `MetricCard` and the Insights
    // `TrendBadge`. Those primitives render the Sessions strip, the Branches
    // strip and the first-launch dashboard here, and the renderer resolves this
    // shared key from the signed-in account's PostHog assignment — the same key
    // space the web app reads — so the change cannot land on one surface alone,
    // the exact one-surface leak the closed-by-default policy exists to prevent.
    // Off by default.
    key: DESKTOP_METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY,
    default: false,
    label: "Unified Metric Delta Pills",
    description:
      'Period-over-period change chips all render as the same pill — same shape and padding for a rise, a fall and a flat 0%, with only the colour differing — and drop the "better" / "worse" word beside the number. Display only: no metric, comparison or number changes.',
    category: "Labs" as const,
  },
  {
    // ISS-6493 (ISS-4779 closed-by-default): the neutral half of the entry
    // above, on its own key. Same primitives, same desktop surfaces, same
    // reason for existing — the renderer resolves this shared key from the
    // signed-in account's PostHog assignment, so the neutral pill cannot land on
    // one surface alone. Off by default.
    // A SEPARATE key rather than a widening of the unified one: that flag is
    // held by the #4823 sentiment-cue question, which is about the verdict word
    // and not about a tone that grades nothing.
    key: DESKTOP_METRIC_DELTA_NEUTRAL_PILL_FEATURE_FLAG_KEY,
    default: false,
    label: "Neutral Metric Delta Pills",
    description:
      'A flat or unscored period-over-period change gets the same pill as a rise or a fall — same shape and padding, differing only in colour — instead of sitting bare beside them. The "better" / "worse" word is unaffected. Display only: no metric, comparison or number changes.',
    category: "Labs" as const,
  },
  {
    // ISS-7845 (ISS-4779 closed-by-default): the Sessions delivery pair's dash
    // takes the same muted no-data treatment the trio beside it already uses
    // (ISS-5401's ruling, applied to the two cards it missed). Off by default —
    // it changes the weight and colour of an already-rendered glyph, which is
    // user-perceivable. This strip mounts on desktop too, where the renderer
    // resolves the shared key from the signed-in account's PostHog assignment;
    // the entry carries only the key's default-off settings metadata.
    key: DESKTOP_SESSIONS_DELIVERY_CARD_NO_DATA_FEATURE_FLAG_KEY,
    default: false,
    label: "Uniform Sessions Empty-Value Dash",
    description:
      "The Sessions summary strip renders every absent value the same way — a muted dash at normal weight — instead of the two delivery cards showing a heavier one than the three beside them. Display only: the dash itself, the metrics and the numbers are unchanged.",
    category: "Labs" as const,
  },
  {
    // ISS-5005 (ISS-4779 closed-by-default): shared web+desktop UI flag gating
    // the Agents catalog's usage-bearing default sort. Off by default — with it
    // off the catalog opens on Component ascending and no stored view DIMENSION
    // is rewritten (only an inert `savedViewVersion: 0` marker is carried). Web
    // and desktop read the same PostHog key; the renderer resolves it from the
    // signed-in account's assignment, and this entry carries only the key's
    // default-off main-process settings metadata.
    // Observable-only: it changes which row is on top, never what was collected.
    key: DESKTOP_AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY,
    default: false,
    label: "Agents usage-first default sort",
    // See the sibling note on `agentsCountColumnAlignment`: the dependency is
    // enforced by `dependsOn`, so it no longer trails the description.
    description:
      "Opens the Agents catalog on the most-invoked components instead of alphabetically, where underscore-prefixed internal tools fill the first screen with zero-invocation rows. A saved view still on the untouched alphabetical default is moved once; any sort you picked yourself is left alone.",
    category: "Labs" as const,
    dependsOn: AGENTS_NAV_FLAG_KEY,
  },
  {
    // ISS-4922: gates the Local session lane's Authored PR gate. Off by default
    // — with it off the Local lane keeps rendering Referenced/Reviewed pills
    // exactly as today. Desktop-only: the cloud lane enforces the same rule
    // unconditionally, so there is no web flag this could leak past.
    key: DESKTOP_LOCAL_SESSION_AUTHORED_PR_GATE_FEATURE_FLAG_KEY,
    default: false,
    label: "Authored-only pull requests on Local sessions",
    // Wording note (stage reviewer): this promises the SUPPRESSION RULE, not
    // full web parity. The Local lane cannot see PRs reachable only through the
    // session's branch link, which the cloud also adjudicates, so a Local
    // session can still show a pill the web view omits. See the KNOWN EVIDENCE
    // GAP note in `main/session/local-session-pull-requests.ts`.
    description:
      "Shows a pull request on a Local session only when that session actually opened it — the same rule the web view applies. Sessions that merely mentioned or reviewed a PR stop showing a pull-request pill, and stop being rescued from Abandoned to Completed because of one.",
    category: "Labs" as const,
  },
  {
    // ISS-7830: gates whether this device records that a user opened a thread.
    // Off by default — with it off no view is ever recorded, so the autonomy
    // score is unchanged and nothing accumulates that a later flip would have to
    // reconcile.
    key: DESKTOP_THREAD_VIEWERSHIP_SIGNAL_FEATURE_FLAG_KEY,
    default: false,
    label: "Opened subagent threads count as attended",
    description:
      "Treats a thread another agent spawned as attended once you have opened it, instead of scoring it as fully autonomous because of how it was launched. Only threads you open while this is on are recorded; a subagent thread you never opened is unchanged, and so is every thread you started yourself.",
    category: "Labs" as const,
  },
  {
    // ISS-5037 (ISS-4779 closed-by-default): the container gate over the whole
    // Labs nav section. `hiddenFromLabs` on purpose — the persisted value's ONLY
    // control is the "Enable Labs" checkbox in the native application menu
    // (`main/app-menu.ts`), while the rendered section resolves from the
    // signed-in account's PostHog assignment. Rendering it as a generic
    // Labs-panel row would defeat the easter egg and be self-referential (a Labs
    // toggle that hides Labs).
    key: DESKTOP_LABS_NAV_FEATURE_FLAG_KEY,
    default: false,
    label: "Enable Labs",
    description:
      "Shows the Labs section in the sidebar and makes its pages reachable. Off by default; toggled from the Enable Labs item in the application menu.",
    category: "Labs" as const,
    hiddenFromLabs: true,
  },
  {
    // ISS-5009 (ISS-4779 closed-by-default): shared web+desktop UI flag
    // (kebab-case, PostHog key "agents-source-provenance-honesty"). The desktop
    // renderer resolves it from the signed-in account's PostHog assignment — the
    // same key space the web app reads — and this entry carries only the key's
    // default-off main-process settings metadata. Both
    // this key and the web AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY alias the
    // shared `@repo/api` constant, so they cannot drift. Display-only: the local
    // reader always computes the honest projection; the flag decides whether the
    // catalog shows it.
    key: DESKTOP_AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY,
    default: false,
    label: "Honest Agents source column",
    description:
      "The Source column shows a dash when no real source was recorded instead of repeating the component's own name.",
    category: "Labs" as const,
  },
  {
    key: DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY,
    default: false,
    label: "Show the Redacted sessions level",
    description:
      "Shows the Redacted sessions option in Data & Sync. It behaves like Metadata only until redaction ships.",
    category: "Labs" as const,
  },
  {
    // ISS-5500 (ISS-4779 closed-by-default): shared web+desktop UI flag
    // (kebab-case, PostHog key "agents-definition-empty-state-honesty"). The
    // desktop renderer resolves it from the signed-in account's PostHog
    // assignment — the same key space the web app reads — so both surfaces open
    // on one key; this entry carries only the key's default-off main-process
    // settings metadata. Display-only: the server already ships the resolution state
    // that discriminates the cases; the flag decides whether the panel says so.
    key: DESKTOP_AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY,
    default: false,
    label: "Honest Agents definition empty state",
    description:
      "A component with no definition body says whether none was ever recorded, or one exists that could not be read, instead of one line for both.",
    category: "Labs" as const,
  },
  {
    // ISS-5518/5519/5521 (ISS-4779 closed-by-default): shared web+desktop UI
    // flag (kebab-case, PostHog key "agents-detail-honesty"). The desktop
    // renderer resolves it from the signed-in account's PostHog assignment — the
    // same key space the web app reads — so both surfaces open on one key; this
    // entry carries only the key's default-off main-process settings metadata.
    // Display-only on this surface: the server already ships the truncation
    // signal and the null operands; the flag decides whether the cards say so.
    key: DESKTOP_AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY,
    default: false,
    label: "Honest Agents detail metrics",
    description:
      "The component detail page names the component instead of printing its content hash, and drops the Lines shipped / Total cost cards it has no measurement for.",
    category: "Labs" as const,
  },
  {
    // ISS-4803 (ISS-4779 closed-by-default): shared web+desktop UI flag
    // (kebab-case, PostHog key "agents-type-tab-overflow"). The desktop renderer
    // resolves it from the signed-in account's PostHog assignment — the same key
    // space the web app reads — so both surfaces open on one key; this entry
    // carries only the key's default-off main-process settings metadata.
    // Display-only: the tab set is unchanged, the flag decides whether the tabs
    // that do not fit are disclosed by a menu or merely scrolled off.
    key: DESKTOP_AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY,
    default: false,
    label: "Agents type-tab overflow menu",
    description:
      "In a narrow window the Agents catalog type tabs that do not fit collapse into a menu that names them, instead of scrolling off behind an edge fade with no way to reach them.",
    category: "Labs" as const,
    // ISS-5310: the strip only exists inside the Agents workspace, so this is
    // inert while `agentsNav` is off. Stating that in `dependsOn` rather than in
    // prose makes a future generic flag surface nest the row under its parent
    // and disable the switch, instead of storing a choice that provably does nothing and can
    // then switch on by surprise when the parent is later enabled.
    dependsOn: AGENTS_NAV_FLAG_KEY,
  },
  {
    // ISS-6758 (ISS-4779 closed-by-default): the Diagnostics → Coverage tab.
    key: DESKTOP_ACTIVITY_COVERAGE_DIAGNOSTICS_FEATURE_FLAG_KEY,
    default: false,
    label: "Activity coverage diagnostics",
    description:
      "Adds a Coverage tab to Diagnostics showing how much of your imported spend the activity classifier confidently attributed to a real activity, broken down by harness, autonomy, ClosedLoop-user and session length. Cohorts with too few sessions to read are marked as such rather than shown as a comparable number.",
    category: "Labs" as const,
  },
  {
    // ISS-5266 (ISS-4779 closed-by-default): the Diagnostics → Withheld tab.
    key: DESKTOP_OPENCODE_WITHHELD_DIAGNOSTICS_FEATURE_FLAG_KEY,
    default: false,
    label: "Withheld data diagnostics",
    description:
      "Adds a Withheld tab to Diagnostics listing OpenCode subagent sessions that could not be imported because their parent session failed to parse: how many were withheld, how many tokens they carry, and when they ran. Without it those sessions are simply missing, and the shortfall is indistinguishable from a session that genuinely had no subagents.",
    category: "Labs" as const,
  },
  {
    // PRD-538 R5/R6 (ISS-5353 + ISS-5354). NOT `hiddenFromLabs` — this is the
    // user's only control, and it must be reachable to opt in. Gating the
    // capture (not just the render) is the point: off means no credential read
    // and no outbound `/usage` request at all.
    key: DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY,
    default: false,
    label: "Subscription session limits",
    description:
      "Shows how much of your Claude subscription's 5-hour and weekly limits you have used. Reads your existing Claude Code sign-in to fetch the usage figures Anthropic reports; off by default, and while off nothing is read or requested.",
    category: "Labs" as const,
  },
] as const;
