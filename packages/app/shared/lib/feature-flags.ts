/**
 * Frontend-only PostHog feature-flag keys for apps/app.
 *
 * These gate client UI rollout and are never read by apps/api, so they live
 * here rather than in `@repo/api` (which is reserved for contract types shared
 * by both apps). Flag keys are kebab-case to match the existing PostHog
 * convention (e.g. `branch-pr`, `compute-target-signing`).
 */

import { AGENT_COLLABORATION_NETWORK_FLAG_KEY } from "@repo/api/src/types/agent-collaboration-network-flag";
import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import { AGENTS_DEFAULT_SORT_USAGE_FLAG_KEY } from "@repo/api/src/types/agents-default-sort-usage-flag";
import { AGENTS_DEFINITION_EMPTY_STATE_FLAG_KEY } from "@repo/api/src/types/agents-definition-empty-state-flag";
import { AGENTS_DETAIL_HONESTY_FLAG_KEY } from "@repo/api/src/types/agents-detail-honesty-flag";
import { AGENTS_INVOCATIONS_DEDUPE_FLAG_KEY } from "@repo/api/src/types/agents-invocations-dedupe-flag";
import { AGENTS_SOURCE_PROVENANCE_FLAG_KEY } from "@repo/api/src/types/agents-source-provenance-flag";
import { AGENTS_TYPE_TAB_OVERFLOW_FLAG_KEY } from "@repo/api/src/types/agents-type-tab-overflow-flag";
import { ARTIFACT_RUN_IN_FLIGHT_FLAG_KEY } from "@repo/api/src/types/artifact-run-in-flight-flag";
import { BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY } from "@repo/api/src/types/branch-timeline-cost-fallback-marker-flag";
import { CHART_DISTINGUISHABLE_SERIES_FLAG_KEY } from "@repo/api/src/types/chart-distinguishable-series-flag";
import { GRID_TABLE_V2_FLAG_KEY } from "@repo/api/src/types/grid-table-v2-flag";
import { INSIGHTS_SPEND_OUTCOME_FLAG_KEY } from "@repo/api/src/types/insights-spend-outcome-flag";
import { MEMBER_SELF_SERVICE_INSTALL_FLAG_KEY } from "@repo/api/src/types/member-self-service-install-flag";
import { SESSION_ACTIVITY_PHASES_FLAG_KEY } from "@repo/api/src/types/session-activity-phases-flag";
import { SESSION_TIMELINE_COLUMN_HIT_TARGET_FLAG_KEY } from "@repo/api/src/types/session-timeline-column-hit-target-flag";
import { SESSIONS_BRANCHES_TAB_TITLES_FLAG_KEY } from "@repo/api/src/types/sessions-branches-tab-titles-flag";
import { SESSIONS_GRID_FOLD_LEGIBILITY_FLAG_KEY } from "@repo/api/src/types/sessions-grid-fold-legibility-flag";
import { SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY } from "@repo/api/src/types/sessions-summary-honest-loading-flag";
import { ArtifactFlag as ArtifactFlagValue } from "./artifact-flags";

/**
 * Gates the stack-rank project page experience (PRD-421 / PLN-755). When
 * enabled, the project page defaults to stack-rank ordering, exposes the
 * "Reset to stack rank" action in the view menu, and shows the drag handle,
 * keyboard reorder, and Move-to-top / Move-to-bottom row menu items.
 */
export const STACK_RANK_PROJECT_PAGE_FEATURE_FLAG_KEY =
  "stack-rank-project-page" as const;

/**
 * Artifact flags are defined in `artifact-flags.ts` so browser E2E fixtures can
 * import the route-gating keys without pulling this module's unrelated
 * transitive workspace imports into Playwright.
 *
 * `BranchDetail` is the legacy desktop-era key for an independently gated
 * branch-detail surface. FEA-4155: the web Branches surface (list AND detail) is
 * now always-on and no longer route-gated on `branches-nav` — the Branches nav
 * destination carries no `featureFlag` (`primary-nav-destinations.ts`), so
 * gating the only path to a now-always-rendering page on a winding-down flag
 * would have hidden it. The `Branches`/`BranchDetail` keys are kept only for
 * desktop-split compatibility (below); no web route consults them.
 *
 * Resolution on desktop is key-agnostic: `DesktopFeatureFlagProvider`
 * (`apps/desktop/src/renderer/feature-flags/desktop-feature-flag-provider.tsx`)
 * adapts `useFeatureFlagEnabled` to `() => flagsEnabled`, deriving every flag
 * from the build type. Keep this legacy key available for compatibility unless
 * a follow-up explicitly removes the older desktop split-gate contract.
 */
export const ArtifactFlag = ArtifactFlagValue;
export type ArtifactFlag = (typeof ArtifactFlag)[keyof typeof ArtifactFlag];

/**
 * Canonical alias for the desktop session-sync PostHog flag, re-exported from
 * `@repo/api` ({@link DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY}) rather than
 * redeclared as a literal so the two cannot silently drift.
 *
 * FEA-4155: this NO LONGER gates the Sessions nav destination — Sessions is
 * always-on (its `primary-nav-destinations.ts` entry carries no `featureFlag`),
 * so neither the sidebar nor the command palette gates it on this key anymore.
 * The alias is retained because it is still the canonical handle for the same
 * winding-down flag elsewhere (e.g. E2E fixtures forcing it off to reproduce the
 * production winding-down state), and to keep any future reference pointing at
 * one PostHog key instead of a parallel literal. Judges keeps its own dedicated
 * flag below.
 */
export const SESSIONS_FEATURE_FLAG_KEY =
  DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY;
export const JUDGES_FEATURE_FLAG_KEY = "the-one-flag" as const;

/**
 * Gates the Loops "Usage Dashboard" (`/[orgSlug]/loops/usage`). Shared by the
 * Loops page (`loops/page.tsx`), which hides the Usage button, and the usage
 * route itself (`loops/usage/page.tsx`), which route-gates the dashboard so a
 * user with the flag off cannot deep-link past the hidden link. Importing the
 * same constant in both places keeps the link and the route gated identically
 * rather than by parallel string literals.
 */
export const LOOPS_USAGE_PAGE_FEATURE_FLAG_KEY = "loops-usage-page" as const;

/**
 * Gates the Sessions "Changes" and "Pull request" filter facets (FEA-2505).
 * When enabled, the Sessions filter menu exposes the "Has changes / No changes"
 * and "Has PR / No PR" facet groups; the server always honors the query params,
 * so the flag only controls the UI rollout.
 */
export const SESSIONS_CHANGE_PR_FILTERS_FEATURE_FLAG_KEY =
  "sessions-change-pr-filters" as const;

/**
 * Gates session owner attribution across the Sessions surface (FEA-3330). When
 * enabled, the session detail Properties panel shows an "Owner" row, the
 * Sessions table gains an "Owner" column, and the Sessions filter menu exposes
 * an "Owner" facet (options sourced from the usage `byUser` breakdown). Each
 * session already carries its owning user on the data contract
 * (`AgentSessionListItem.user`) and the server already honors the `userIds`
 * query param, so this flag only controls the UI rollout (dark launch, off by
 * default) — with it off every surface renders exactly as before.
 *
 * The shared filter facet (`SessionsToolbar`) and detail row
 * (`AgentSessionDetailView`) read this flag via `useFeatureFlagEnabled`; the
 * opt-in table column is surfaced by the host that owns column visibility (the
 * web Sessions page injects `"owner"` into `visibleColumns` when the flag is
 * on). This rolls out on web first — desktop has no PostHog wiring, so in
 * packaged desktop builds the flag resolves false and the surface stays dark;
 * lighting it up on desktop (Labs registry entry + wiring the desktop Sessions
 * table's column) is a follow-up.
 */
export const SESSIONS_OWNER_ATTRIBUTION_FEATURE_FLAG_KEY =
  "sessions-owner-attribution" as const;

/**
 * ISS-4792 (ISS-4779 closed-by-default policy for the ISS-4679 UI): gates the
 * project completion-ring empty-population state on the documents/projects
 * tables. When ON, a project whose completion population is empty (no
 * documents/issues, `completionEmpty === true`) renders the "nothing to
 * measure" dash (`StatusPercentageIcon value={null}`, ISS-4835) with the
 * `PROJECT_COMPLETION_EMPTY_SUMMARY` copy. When OFF (default, dark launch) the
 * empty case renders the PRIOR behavior — a solid 0% ring named
 * "0% of documents and issues complete" — so with the flag off the surface is
 * unchanged. The `value={null}` variant on the shared `StatusPercentageIcon` is
 * untouched; this flag only gates whether `ProjectNameCell` PASSES it.
 *
 * The `ProjectNameCell` reads this via `useFeatureFlagEnabledOptional`, so it
 * degrades to OFF (prior behavior) under a mount site with no flag provider
 * (Storybook, mini-table tests) rather than crashing.
 */
export const PROJECT_COMPLETION_EMPTY_STATE_FEATURE_FLAG_KEY =
  "project-completion-empty-state" as const;

/**
 * ISS-4890 / ISS-4906 / ISS-4901 (ISS-4779 closed-by-default policy): gates the
 * Sessions grid's horizontal-fold legibility pass — three changes that only make
 * sense together, so they flip on ONE key:
 *
 *  - **ISS-4890** — a one-time migration of a persisted Sessions `columnOrder`
 *    that relocates ONLY `cost` to its canonical pre-fold slot, leaving every
 *    other column where the user put it. ISS-4788 moved Cost ahead of Repository
 *    in the DEFAULT order; a user who had ever drag-reordered a header kept Cost
 *    in its old 6th slot, past the fold, still rendering `$772.3` for `$772.39`.
 *  - **ISS-4906** — the fold fit is applied against a SETTLED container width, so
 *    a continuous resize drag no longer walks the columns left/right at each
 *    fit threshold (the ISS-4889 sawtooth).
 *  - **ISS-4901** — the `scrollbar-overlay` utility on the Sessions list's
 *    horizontal scroll region, so a fold that now lands flush on a column
 *    boundary still says there is more to the right. It is the cue the app
 *    sidebar and `synced-sessions-table` already use: a persistent thin thumb
 *    whose length also reports how much more there is.
 *
 * OFF (default, dark launch) keeps today's behavior exactly: no persisted order
 * is rewritten, the fit tracks the live measured width frame by frame, and the
 * scroll region keeps the platform's default (on macOS, at-rest-invisible)
 * scrollbar.
 *
 * Note the ISS-4890 half is a DATA migration: with the flag on it rewrites the
 * user's saved `columnOrder` once and stamps the saved view's version, so
 * turning the flag back off stops any further migration but does not restore the
 * pre-migration order (the saved view now genuinely holds the new arrangement,
 * which the user can change again by dragging).
 *
 * Shared web+desktop surface: the web app resolves this via PostHog, and the
 * packaged desktop renderer resolves the byte-for-byte-equal key from its Labs
 * registry (`DESKTOP_SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY`, default
 * OFF), so the pass cannot leak on one surface while hidden on the other.
 */
export const SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY =
  SESSIONS_GRID_FOLD_LEGIBILITY_FLAG_KEY;

/**
 * GridTable v2 (ISS-4779 closed-by-default policy): gates the shared
 * `GridTable` enhancement pass — per-column options menu, hover-revealed sort
 * affordance, row selection + row activation, click-to-keyboard cell
 * navigation, the leading utility column, and the rows-per-page control.
 *
 * Gates the SHARED primitive, so every consumer (Sessions, Branches, Agents,
 * Routines, Packs, Documents, Compliance) flips together — deliberately, since
 * divergent table behavior across surfaces is worse than one larger flip. See
 * the key's own module for the full rationale.
 *
 * Shared web+desktop surface: the web app resolves this via PostHog, and the
 * packaged desktop renderer resolves the byte-for-byte-equal key from its Labs
 * registry (`DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY`, default OFF), so the pass
 * cannot leak on one surface while hidden on the other.
 */
export const GRID_TABLE_V2_FEATURE_FLAG_KEY = GRID_TABLE_V2_FLAG_KEY;

/**
 * ISS-4463 (ISS-4779 closed-by-default policy): gates the Insights "Spend by
 * outcome" tiles — the TokenOps lens splitting a period's AI spend by the
 * originating session's lifecycle outcome (ended clean / ended with error /
 * still running / not recorded).
 *
 * ON, the Agents section's metric picker offers the two `spendByOutcome` tiles
 * (bar + share donut) and the dashboard renders them if pinned. OFF (default,
 * dark launch) neither tile is offered OR rendered, so the surface is unchanged
 * — and a tile pinned while the flag was on stops rendering when it goes back
 * off, rather than becoming an un-removable orphan.
 *
 * The server always computes and returns `spendByOutcome` on the Agents
 * response, so this gates the UI rollout only.
 *
 * Shared web+desktop surface: the web app resolves this via PostHog and the
 * packaged desktop renderer resolves the byte-for-byte-equal key from its Labs
 * registry (`DESKTOP_INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY`, default OFF), so
 * the lens cannot leak on one surface while hidden on the other — both alias the
 * same `@repo/api` constant.
 */
export const INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY =
  INSIGHTS_SPEND_OUTCOME_FLAG_KEY;

/**
 * ISS-4728 (ISS-4779 closed-by-default policy): gates folding the web Sessions
 * page's `?userId=` selected-user narrower into the ISS-4605 active-filter chip
 * row, replacing the legacy "User filtered" badge.
 *
 * When ON, the scope renders as a removable Owner chip in the one row that names
 * every active filter, and removing it strips the URL param. When OFF (default,
 * dark launch) the page renders the prior badge + "Showing sessions for the
 * selected user." sentence inside the scroll area, and the chip row is exactly
 * what ISS-4605 shipped. The `?userId=` URL contract, the query it produces, and
 * "Clear all" are identical under both — the flag gates only which control
 * SURFACES the scope.
 *
 * WEB-ONLY, deliberately: `?userId=` is a web-route narrower with no desktop
 * analogue (the desktop Sessions view threads only the multi-select Owner facet,
 * and its hash router has no `userId` param), so there is no desktop surface to
 * keep in parity and no Labs twin for this key. The shared
 * `SessionsActiveFiltersBar` change is additive and inert when the scope props
 * are omitted, which is what desktop does.
 */
export const SESSIONS_OWNER_SCOPE_CHIP_FEATURE_FLAG_KEY =
  "sessions-owner-scope-chip" as const;

/**
 * ISS-5005 (ISS-4779 closed-by-default policy): gates the Agents catalog landing
 * on a USAGE-BEARING default sort — Invocations descending — instead of
 * Component ascending.
 *
 * When ON: a fresh view opens on the most-invoked components, and a persisted
 * view still carrying the never-touched legacy default (Component + ascending)
 * is rewritten ONCE to match (see `agents-saved-view-migration.ts`). Sorting is
 * the only dimension touched; hidden columns, column order, widths, grouping,
 * and metric mode are never read or written by the rewrite, and any sort the
 * user actually chose is left alone.
 *
 * When OFF (default, dark launch) the catalog defaults to Component ascending
 * exactly as before and no stored VIEW DIMENSION is rewritten — sort, columns,
 * order, grouping, and metric mode all restore verbatim. The one stored-shape
 * change on the dark path is an inert `savedViewVersion: 0` marker the shared
 * persist effect now carries; `0` is the never-migrated state, so it alters no
 * behavior and keeps the view migratable if the flag is later turned on.
 *
 * Rollback is one-way for a view that already migrated: turning the flag back
 * OFF restores the persisted sort, which for a migrated user is now Invocations
 * descending. Reverting that too would mean recording the pre-migration sort and
 * then overriding it — which would equally overwrite a user who chose Invocations
 * descending deliberately while the flag was on. The same one-way property holds
 * for the ISS-4890 column relocation this mirrors.
 *
 * Shared web+desktop surface: `AgentsGroupedList` mounts on the web app
 * (`agents:web`) AND the desktop renderer (`agents:desktop`) through the same
 * `useAgentComponentsViewState` hook, so the web app resolves this via PostHog
 * and the packaged desktop renderer resolves the byte-for-byte-equal key from
 * its Labs registry (`DESKTOP_AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY`,
 * default OFF). Both alias the shared `@repo/api` constant, so a rename touches
 * one definition and cannot split the surfaces.
 */
export const AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY =
  AGENTS_DEFAULT_SORT_USAGE_FLAG_KEY;

/**
 * ISS-5009 (ISS-4779 closed-by-default policy): gates the Agents catalog Source
 * column telling the truth about provenance it does not have.
 *
 * Every producer of an `AgentComponent` ends its `source` fallback chain at the
 * component's own identity key, so a component with no real provenance renders
 * the same string the Component column already shows — a column of duplicated
 * identifiers presented as provenance. When ON, a row whose producer reported
 * `honestSource.hasProvenance === false` renders the shared em-dash empty glyph
 * instead of that echo; a row WITH provenance renders the provenance and the
 * source type it actually came from; and the Source facet's option universe,
 * counts AND membership predicate all key on the same honest value, so a
 * flag-ON option can never match zero rows and empty the catalog.
 *
 * When OFF (the default, dark launch) every one of those surfaces renders
 * byte-identically to today, and no honest-projection value is read at all. The
 * same holds for a row from a server that predates ISS-5009: `honestSource` is
 * absent, absence means "assume `source` is meaningful", and the legacy render
 * stands. `source`/`sourceType` on the wire are deliberately untouched.
 *
 * Sort ordering by Source is deliberately NOT gated — it still compares the
 * legacy `row.source` (`agent-component-sort-group.ts`). A column of em dashes
 * ordering by a hidden key is deterministic and non-contradictory, unlike a
 * filter menu offering values no row can match, which is why the facet IS gated
 * and the comparator is not.
 *
 * Shared web+desktop surface: `AgentsTable`, `AgentDetail` and the Agents filter
 * menu mount on the web app AND the desktop renderer, so the web app resolves
 * this via PostHog and the packaged desktop renderer resolves the
 * byte-for-byte-equal key from its Labs registry
 * (`DESKTOP_AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY`, default OFF). Both alias
 * the one `@repo/api` {@link AGENTS_SOURCE_PROVENANCE_FLAG_KEY} constant, so a
 * rename touches a single definition and cannot split the two surfaces.
 */
export const AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY =
  AGENTS_SOURCE_PROVENANCE_FLAG_KEY;

/**
 * ISS-5500 (ISS-4779 closed-by-default): gates the Agents component detail
 * Definition panel naming WHY it has no body, instead of one line that served
 * "never recorded" and "exists but failed to load" alike.
 *
 * Shared web+desktop surface: `AgentDetail` mounts on the web app AND the
 * desktop renderer, so the web app resolves this via PostHog and the packaged
 * desktop renderer resolves the byte-for-byte-equal key from its Labs registry
 * (`DESKTOP_AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY`, default OFF). Both
 * alias the one `@repo/api` {@link AGENTS_DEFINITION_EMPTY_STATE_FLAG_KEY}
 * constant, so a rename touches a single definition and cannot split the two.
 */
export const AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY =
  AGENTS_DEFINITION_EMPTY_STATE_FLAG_KEY;

/**
 * ISS-4978 (ISS-4779 closed-by-default policy): gates the session-detail
 * Properties Duration row's truth-in-UI pass — ONE key for both halves, so the
 * row cannot end up naming its measure while still padding it with placeholders
 * that are absent by construction.
 *
 * When ON, the row (a) qualifies its headline by the measure the Duration SSOT
 * actually selected — "wall" for the collector's observed running span, but
 * "calendar" for the best-effort `startedAt → end` fallback a legacy /
 * version-skewed session takes — instead of labelling both "wall"; and (b) when
 * only that headline survived (the fallback population has no `active` /
 * "waiting on you" values BY CONSTRUCTION), renders the one real fact alone
 * rather than "4h 54m wall | — active | — waiting on you", two of whose three
 * slots are guaranteed empty every time.
 *
 * When OFF (default, dark launch) the row renders exactly as ISS-4688 shipped it.
 * The NUMBER is untouched on both paths — it stays the one value the Sessions
 * list cell and the Duration MetricCard read, so this flag can never re-open the
 * ISS-4631 list↔detail drift; it gates the QUALIFIER and the placeholder slots
 * only.
 *
 * Shared web+desktop surface: `SessionDurationProperty` mounts on the web app AND
 * the desktop renderer, so this key must stay byte-for-byte equal to
 * `DESKTOP_SESSIONS_DURATION_CALENDAR_QUALIFIER_FEATURE_FLAG_KEY` in
 * `apps/desktop/src/shared/feature-flags.ts`.
 *
 * ISS-5131 RETIRED THIS GATE, and #4409 REMOVED ITS DESKTOP LABS ENTRY. There is
 * one Duration measure now, so there is one word for it and nothing left to
 * qualify; nothing on either surface reads this key. The key constant stays
 * exported for the compatibility guardrail — an installed desktop build may still
 * have the setting persisted — but the toggle is gone from the Labs panel, so
 * there is no desktop registry entry left to resolve it from. Do not add callers.
 */
export const SESSIONS_DURATION_CALENDAR_QUALIFIER_FEATURE_FLAG_KEY =
  "sessions-duration-calendar-qualifier" as const;

/**
 * ISS-4773 (ISS-4779 closed-by-default policy): gates the Sessions "Cost" card's
 * truth-in-UI pass — ONE key for the label, the headline basis, the caption and
 * the tooltip, so the card can never show a confirmed-spend number under the old
 * bucket label or vice versa.
 *
 * The defect: the card's headline reads `apiEstimatedCost`, which BOTH producers
 * define as "everything not covered by a subscription" — metered spend AND every
 * session whose billing mode was never determined. On a subscription-heavy
 * account the unknown share dominates (ISS-4900 verified all 1,302 Claude rows on
 * real history read `subscription_unknown`), so a figure that is mostly
 * unconfirmed usage was rendered as definite out-of-pocket cost.
 *
 * When ON the card reports what it can actually stand behind: the headline is
 * `meteredEstimatedCost` — CONFIRMED API-billed spend only — under its own
 * narrowed label "API-billed Cost" (`SESSIONS_COST_HONEST_METRIC_CARD_LABEL`,
 * what `resolveCostCardPresentation` actually passes; NOT the bare "Cost", which
 * would re-open the ISS-4401 collision this card exists to keep closed); the
 * caption names the API-equivalent value of confirmed
 * subscription-covered usage; and any unconfirmed share is DISCLOSED beside them
 * rather than silently folded into either. When ON but the producer is too old to
 * send the three-way split, the card falls back to the OFF render — an honest
 * "we cannot split this" beats a confident number derived from a bucket that
 * does not carry the distinction.
 *
 * When OFF (default, dark launch) the card renders its shipped default: the
 * ISS-4401 basis and label, with the ISS-6092 tooltip and FEA-4231's
 * "+$X if billed to API" caption. The flag changes the BASIS this doc describes;
 * it does not own that copy, so a copy-only change to the default render (as
 * ISS-6092 was) leaves this flag's behaviour untouched.
 *
 * Shared web+desktop surface: `SessionsSummaryCards` mounts on the web app AND the
 * desktop renderer, so the web app resolves this via PostHog and the packaged
 * desktop renderer resolves the byte-for-byte-equal key from its Labs registry
 * (`DESKTOP_SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY`, default OFF).
 */
export const SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY =
  "sessions-cost-billing-honesty" as const;

/**
 * ISS-5842 (ISS-4779 closed-by-default policy): gates the unified delta-chip
 * treatment on the SHARED metric primitives — `MetricCard`'s delta chip/caption
 * and the Insights `TrendBadge`.
 *
 * ON, every delta tone renders the same pill geometry (same shape, same
 * padding, same type) and varies only by colour, and neither delta family spells
 * out a "better" / "worse" verdict beside the number. OFF (default, dark launch)
 * both render exactly as they did before ISS-5842: scored tones get the filled
 * pill, a neutral tone renders bare so it cannot be mistaken for the muted "No
 * comparison" placeholder, and the caption leads with the verdict word.
 *
 * **Its own key, deliberately.** ISS-5842's instruction was to ship under
 * `sessions-cost-billing-honesty`, but that flag gates Sessions COST SEMANTICS
 * and is read by neither Insights, Branches, the overview dashboard, nor the
 * desktop first-launch dashboard — all of which mount these same primitives. A
 * Sessions flag threaded into a generic primitive would render one component two
 * different ways inside one product; a separate key gates the presentation
 * change across every consumer at once instead (wongk + codex review on #4823).
 *
 * Shared web+desktop surface: these primitives mount on the web app AND the
 * desktop renderer, so the web app resolves this via PostHog and the packaged
 * desktop renderer resolves the byte-for-byte-equal key from its Labs registry
 * (`DESKTOP_METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY`, default OFF).
 *
 * **Do not graduate this flag** until the sentiment-cue question raised on #4823
 * is decided — with the verdict word gone, a `+38%` higher-is-better and a
 * `+38%` lower-is-better are separated by hue alone. See `deltaVerdictCaption`
 * in `packages/design-system/components/ui/primitives/metric-polarity.ts`.
 */
export const METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY =
  "metric-delta-unified-pill" as const;

/**
 * ISS-5037 (ISS-4779 closed-by-default policy): ONE container gate over the
 * ENTIRE Labs navigation section on the web sidebar, plus every destination
 * inside it.
 *
 * OFF (the default) means the Labs `SidebarCollapsibleSection` does not render
 * at all — no header, no items, no empty collapsed shell — and each Labs route
 * (`/insights`, `/judges-analytics`, `/packs`) 404s through
 * `FeatureFlagRouteGate`, so typing the URL directly does not land on the page.
 * ON restores today's behavior exactly.
 *
 * This sits ABOVE the per-item gates rather than replacing them: an item's own
 * `featureFlag` (`maybeFeatureFlagged`) and its `adminOnly` filter still apply
 * inside the section, and toggling this container off never writes to, resets,
 * or shadows those per-item values — flipping it back on restores the previous
 * per-item state untouched.
 *
 * WEB-ONLY key, deliberately. Labs exists on both surfaces, so both are gated
 * (ISS-4779 parity), but the desktop half is NOT a PostHog flag: it is the
 * `DesktopSettings`-backed "Enable Labs" checkbox in the native application
 * menu (`DESKTOP_LABS_NAV_FEATURE_FLAG_KEY` in
 * `apps/desktop/src/shared/feature-flags.ts`), which is a different mechanism
 * with a different (camelCase, settings-field) key. There is therefore no
 * shared literal to alias here.
 */
export const LABS_NAV_SECTION_FEATURE_FLAG_KEY = "labs-nav-section" as const;

/**
 * FEA-1626 (ISS-4779 closed-by-default): gates the My Tasks board REQUESTING a
 * bounded recency + lifecycle window on `GET /documents` instead of its full
 * assigned history.
 *
 * OFF (default) the board sends neither `recencyDays` nor
 * `includeArchivedProjects`, and the endpoint applies no window of its own — the
 * response is exactly what ISS-4576 shipped, and the request stays valid against
 * an API that predates these params. ON, the board asks for
 * {@link DOCUMENT_LIST_DEFAULT_RECENCY_DAYS} and for artifacts in ARCHIVED
 * projects to be dropped, which is perceivable: fewer rows and a smaller "of N"
 * total.
 *
 * **That narrowing is disclosed on screen, not only here.** With the flag on the
 * board renders a removable "Last N days" chip in its filters bar, and its empty
 * state says the queue aged out of the window rather than claiming it is clear —
 * a docstring must not be the only place a user-visible bound is stated
 * (closedloop-ai-stage). Removing the chip drops the window and refetches full
 * history, so there is always a way back out.
 *
 * WEB-ONLY, deliberately: `/my-tasks` redirects to Sessions in the desktop route
 * table, so there is no desktop surface to keep in parity and no Labs twin for
 * this key — the same reasoning that governed the My Tasks copy-polish key
 * before ISS-5280 retired it.
 */
export const MY_TASKS_RECENCY_WINDOW_FEATURE_FLAG_KEY =
  "my-tasks-recency-window" as const;

/**
 * FEA-1651 (parent FEA-908, flagged by wongk in the PR #1077 review).
 *
 * WHAT CHANGES ON SCREEN, first, because that is what rolling this to 100%
 * decides. With the flag ON the My Tasks list view shows the user's OWN work
 * and its immediate context: artifacts assigned to them, branches they have
 * commit authorship on, each of those rows' parent chain, and each of those
 * rows' children. What it stops showing is everything ELSE that lived in the
 * same projects — other people's artifacts, which the per-project fan-out
 * returned wholesale because it asked for every artifact in each project the
 * user was assigned in. Rows genuinely disappear from the tree; nesting under
 * other people's work disappears with them. The endpoint also bounds its walk,
 * and when a bound binds the response says so and the footer marks the total a
 * floor rather than publishing a partial count.
 *
 * The mechanism, second: those rows now come from ONE
 * `GET /artifacts/assigned-tree` request instead of one
 * `GET /projects/:id/tree` per project. That is the reason the work was done,
 * but it is not the reason this flag exists — the corpus change above is.
 *
 * Off by default (ISS-4779 closed-by-default). With the flag off the board
 * fetches and renders exactly as it does today.
 *
 * The key is deliberately NOT `my-tasks-assigned-only-tree`: the scope is not
 * assignee-only. Branches the user contributed to are anchors too, and they
 * rarely carry an assignee — an "assigned-only" name would send the next reader
 * looking for a Branches stream that is in fact present.
 *
 * Web-only: `/my-tasks` redirects to Sessions in the desktop route table
 * (`apps/desktop/src/renderer/navigation/route-table.ts`), so there is no
 * desktop surface to keep in parity and no Labs twin for this key.
 */
export const MY_TASKS_ASSIGNED_ARTIFACT_TREE_FEATURE_FLAG_KEY =
  "my-tasks-own-work-tree" as const;

/**
 * ISS-5355 — the project-scoped Sessions surfaces: the Sessions Project filter
 * facet, and the project-detail "active sessions" strip that replaces the
 * "N loops running" strip and links into that facet.
 *
 * Off by default (ISS-4779 closed-by-default). With the flag off the Project
 * facet is not offered, no `project=` chip is derived, and the project-detail
 * page renders the pre-existing loops strip — so no filter can narrow the list
 * without a control to name and remove it, and neither surface half can ship
 * without the other.
 *
 * Web-only, so there is no Labs twin. A session's project comes from its cloud
 * artifact, and the desktop local producer "cannot resolve cloud projects"
 * (`shared-agent-sessions-api.ts`), so the desktop never mounts either surface —
 * gating it there would gate nothing.
 */
export const SESSIONS_PROJECT_FACET_FEATURE_FLAG_KEY =
  "sessions-project-facet" as const;

/**
 * ISS-5307: gates pagination of the project detail page's artifact tabs — the
 * bounded tree read, the shared paginated footer, the rows-per-page control,
 * and the true-total readout above them.
 *
 * Off by default (ISS-4779 closed-by-default). With the flag off the project
 * page fetches and renders exactly as it does today: one unbounded tree read,
 * every matching row on the tab, no footer.
 *
 * ## Why a new key and not `grid-table-v2`
 *
 * `grid-table-v2` gates the shared `GridTable` primitive's behavior, including
 * ITS rows-per-page control. The project detail page's artifact table is not a
 * `GridTable`: it is `DocumentsView`, the older ARIA-table renderer that
 * `GridTable` has not replaced on this surface. Folding this into that key
 * would tie a change on one component to a flag that flips a different one, and
 * would flip Sessions, Branches, Agents, Routines, and Packs the moment anyone
 * wanted to see the project page paginate.
 *
 * ## Web-only, deliberately
 *
 * No desktop Labs twin. `DocumentsView` is imported by exactly three surfaces,
 * all in `apps/app` (project detail, My Tasks, and the documents index); the
 * desktop renderer does not consume it, so there is no second surface this
 * could leak on. The closed-by-default policy requires parity only where the
 * surface exists on both platforms.
 *
 * Declared HERE and not in `packages/api/src/types` (wongk): that package is
 * reserved for contracts `apps/app` and `apps/api` BOTH consume, and no part of
 * the API reads this key. Putting it there would invent a transport dependency
 * that does not exist.
 */
export const PROJECT_ARTIFACTS_PAGINATION_FEATURE_FLAG_KEY =
  "project-artifacts-pagination" as const;

/**
 * ISS-5271: the Sessions summary cards' honest never-loaded state — when the
 * usage summary is absent with no error, the Sessions and Total Tokens cards
 * skeleton their value slot instead of rendering a confident `0` for a number
 * that was never computed (the Cost card beside them already dashes, so the
 * unflagged row reads `0 / 0 / —`). Display only; last-good values held under
 * `keepPreviousData` are unaffected (the gate covers the never-loaded case
 * only).
 *
 * Shared web+desktop surface: the web app resolves this via PostHog, and the
 * packaged desktop renderer resolves the byte-for-byte-equal key from its Labs
 * registry (`DESKTOP_SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY`, default
 * OFF), so the state cannot leak on one surface while hidden on the other.
 */
export const SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY =
  SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY;

/**
 * ISS-5548 (ISS-4779 closed-by-default policy): gates the Session Timeline's
 * COLUMN-height hit target.
 *
 * `.sd3-bars2` lays the cost bars out `align-items: flex-end`, and each bar's
 * height IS its value (`getBarStyle`, floored at 9% — about 6px of a 62px
 * column). The `<button>` is the control, so its box is also the entire click
 * target: the taller the bar the easier it is to hit, and the quiet buckets a
 * reader is most likely to probe are the hardest. When ON, a bar that has
 * somewhere to jump to grows an invisible hit box up to the top of its own
 * column, and the reachable region is outlined on hover and on keyboard focus —
 * the bar's own hover stroke, moved out to the column it now covers, rather than
 * a second affordance or a fill — so the target is discoverable rather
 * than magic. The bar itself is untouched — it stays the visual encoding of
 * magnitude.
 *
 * ## Only bars that can actually be jumped to
 *
 * The expansion is keyed off `tl0 != null`, not off the bar's value. A bucket
 * with no transcript anchor has nothing to reach, so it gains no hit area at
 * all: this flag can never manufacture a larger dead target. That keeps
 * ISS-5479's distinction intact — an UNREACHABLE bar and a REACHABLE-BUT-INERT
 * bar stay different states — in either position of this gate. (ISS-5479's own
 * gate was retired ON by ISS-6006, so the feedback is now unconditional; this
 * key still governs only where a click LANDS, never what it SAYS.)
 *
 * Shared web+desktop surface: the web app resolves this via PostHog, and the
 * packaged desktop renderer resolves it from its Labs registry
 * (`DESKTOP_SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY`, default OFF),
 * so the hit target cannot grow on one surface while hidden on the other. Both
 * aliases point at ONE literal — `SESSION_TIMELINE_COLUMN_HIT_TARGET_FLAG_KEY`
 * in `@repo/api/src/types/session-timeline-column-hit-target-flag` — so a
 * rename touches a single definition and cannot silently split the surfaces.
 */
export const SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY =
  SESSION_TIMELINE_COLUMN_HIT_TARGET_FLAG_KEY;

/**
 * ISS-5566 (ISS-4779 closed-by-default policy): gates the Session Timeline's
 * disclosure that a strip's bars are SYNTHESIZED rather than measured.
 *
 * When a session carries no persisted `activityBuckets`, the timeline
 * reconstructs the strip from the transcript and manufactures the money on it:
 * a total floored at one cent (`Math.max(estimatedCost, 0.01)`), a per-bucket
 * share from a `turns + toolCalls * 3` guess, and an in/out/cache split of three
 * fixed ratios that therefore repeat identically on every bar. Nothing in the
 * strip, the bar labels, or the hover tooltip distinguished any of that from a
 * real measurement — on a session whose Cost property honestly renders `—`, the
 * same screen simultaneously painted per-bucket dollar amounts.
 *
 * When ON, a synthesized strip stops printing money it cannot back: no bar
 * label, no in/out/cache stack, no tooltip total, and no per-model dollar table.
 * The bars keep their heights, which are an honest relative-activity encoding,
 * and a caption beneath the strip says exactly that. Measured strips — the ones
 * with persisted buckets — are untouched on both branches.
 *
 * Shared web+desktop surface: `AgentSessionDetailView` mounts on the web app
 * AND the desktop renderer, so the web app resolves this via PostHog and the
 * packaged desktop renderer resolves the byte-for-byte-equal key from its Labs
 * registry (`DESKTOP_SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY`,
 * default OFF).
 */
export const SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY =
  "session-timeline-synthesized-cost" as const;

/**
 * ISS-5574 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating per-page browser tab titles on the Sessions and Branches surfaces. All
 * four routes on both surfaces reported the application-wide "Closedloop.ai", so
 * several open tabs were indistinguishable and history/bookmarks carried no
 * record identity.
 *
 * Shared web+desktop surface: the web app resolves this via PostHog and the
 * packaged desktop renderer resolves the byte-for-byte-equal key from its Labs
 * registry (default OFF), so titles cannot appear on one surface while hidden on
 * the other — both alias the same `@repo/api` constant.
 */
export const SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY =
  SESSIONS_BRANCHES_TAB_TITLES_FLAG_KEY;

/**
 * ISS-5564 (ISS-4779 closed-by-default policy): gates the session Activity
 * breakdown's confidence-basis disclosure.
 *
 * The panel prints two different percentages per row that a reader has every
 * reason to conflate: `Conf.` — how sure the classifier is of the phase LABEL —
 * and `Cost %` — that phase's share of real, measured spend. On the reported
 * session the row carrying 79% of the session's cost was labelled `Conf. 0%`, so
 * the panel simultaneously asserted a precise dollar attribution and admitted no
 * confidence in the classification the money was grouped under. A reader
 * resolves that contradiction by distrusting the dollars, which is the wrong
 * conclusion: the dollars are measured token cost attributed by time window, and
 * only the phase NAME is a guess.
 *
 * When ON, a footer sentence says exactly that, and only when the contradiction
 * is actually on screen — a phase whose confidence ROUNDS TO the `0%` the reader
 * sees while still carrying a nonzero cost. It is the same move the panel
 * already makes for its other ambiguous column with `ShareBasisLine` ("Shares
 * are by cost, not time.") and for its residual row with
 * `UnattributedResidualLine`; this closes the third gap of the same kind. No
 * number changes — the disclosure is additive copy.
 *
 * Shared web+desktop surface: `SessionActivityBreakdown` mounts on the web app
 * AND the desktop renderer, so the web app resolves this via PostHog and the
 * packaged desktop renderer resolves the byte-for-byte-equal key from its Labs
 * registry (`DESKTOP_SESSION_PHASE_CONFIDENCE_DISCLOSURE_FEATURE_FLAG_KEY`,
 * default OFF).
 */
export const SESSION_PHASE_CONFIDENCE_DISCLOSURE_FEATURE_FLAG_KEY =
  "session-phase-confidence-disclosure" as const;

/**
 * ISS-5123 (ISS-4779 closed-by-default policy): gates the admin "Stop
 * distributing" affordance on a pack's Distribution tab.
 *
 * Promotion to the organization was one-way — a pack promoted by mistake,
 * superseded, or deprecated stayed on offer to the whole org with no control
 * anywhere on the Packs surface to take it back. This flag turns on the control
 * that withdraws it.
 *
 * WEB-ONLY BY CONSTRUCTION, not by omission. The affordance lives inside the
 * Distribution tab, which renders only where `PacksCapabilities.manageDistribution`
 * is true — and that is `PacksMode.WebAdmin` alone. Both desktop modes
 * (`DesktopSolo`, `DesktopTeam`) set it false, so the desktop renderer never
 * mounts the tab and there is no desktop surface for a Labs toggle to hide. Per
 * the closed-by-default policy, cross-surface parity is required only when the
 * surface exists on both platforms; this one does not.
 *
 * Desktop is still AFFECTED — a withdrawn pack drops out of its assigned
 * distributions poll — but that is the server-side consequence of an admin
 * action, not a desktop UI change, and with this flag off no such action can be
 * initiated at all.
 */
export const PACK_UNDISTRIBUTE_FEATURE_FLAG_KEY = "pack-undistribute" as const;

/**
 * ISS-4803 (ISS-4779 closed-by-default policy): gates the Agents catalog
 * type-tab strip disclosing the tabs it cannot fit.
 *
 * FEA-4019 grew the strip to eight segments. On a phone the trailing four are
 * clipped by the strip's scroll track, whose only cue is an edge fade — and
 * because the strip is a Radix `ToggleGroup` (roving tabindex, so the whole
 * strip is ONE tab stop) the clipped kinds are reachable only by arrowing blind
 * inside a control that never says there is more. When ON, the strip fits itself
 * to its measured width and collapses the remainder behind a real focusable
 * overflow menu that names what it hides. When OFF (default) every segment is
 * rendered in the strip exactly as it ships today.
 *
 * Shared web+desktop surface: `AgentsGroupedList` is the default layout for the
 * web `/[orgSlug]/agents` route AND the packaged desktop Agents view, so the web
 * app resolves this via PostHog and the desktop renderer resolves the
 * byte-for-byte-equal key from its Labs registry
 * (`DESKTOP_AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY`, default OFF). Both alias
 * the one `@repo/api` {@link AGENTS_TYPE_TAB_OVERFLOW_FLAG_KEY} constant, so a
 * rename touches a single definition and cannot split the two surfaces.
 */
export const AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY =
  AGENTS_TYPE_TAB_OVERFLOW_FLAG_KEY;

/**
 * ISS-5125 (ISS-4779 closed-by-default policy): gates the MEMBER self-service
 * install affordance on the packs per-machine block.
 *
 * The block (`MemberTargetsBlock`, FEA-4077) shipped as a pure READ — it says
 * where a pack stands on each of a member's machines, per harness, and offers
 * no way to change it. ON, an actionable cell (not installed, or a failed
 * install) also carries an Install/Retry control that dispatches the member's
 * own install to that node through `POST /compute-targets/{id}/member-installs`
 * (FEA-4082, which shipped with no caller). OFF, the block renders exactly the
 * read-only rows it always did.
 *
 * This gates an AFFORDANCE, not a permission. Every org member already holds
 * `PackAdminCapability.InstallToOwnMachines`, and the API already authorizes
 * owner-only, org-scoped access to the target node, so flipping this key grants
 * nobody a capability they did not have.
 *
 * Shared web+desktop surface: both shells mount the block, so the web app
 * resolves this via PostHog and the packaged desktop renderer resolves the
 * byte-for-byte-equal key from its Labs registry
 * (`DESKTOP_MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY`, default OFF) — the
 * affordance cannot leak on one surface while hidden on the other.
 */
export const MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY =
  MEMBER_SELF_SERVICE_INSTALL_FLAG_KEY;

/**
 * ISS-5523 (ISS-4779 closed-by-default policy): gates distinguishable series
 * colors on the categorical time-series charts that draw per-model series.
 *
 * OFF (default, dark launch) every chart renders exactly as it does today:
 * series take palette slots in order and the palette CYCLES, so a chart with
 * more series than the palette has slots draws two unrelated series in the same
 * fill. ON, each chart caps at {@link CHART_SERIES_COLOR_LIMIT} distinctly
 * colored series, seats them in the validated adjacent-distinguishable order,
 * and folds the remaining low-magnitude series into one neutral "Other (N)"
 * band that names how many series it stands for.
 *
 * ONE key over all three model-series charts — the Insights dashboard row
 * (`ModelUsageChart`), the Insights dashboard tile (`tile-content`), and the
 * agent-detail trend (`TokenTrendChart`) — because they draw the same data
 * through the same component. Gating them apart would leave one surface
 * cycling the palette beside a neighbour that did not.
 *
 * Shared web+desktop surface: the Insights dashboard row and tile mount on the
 * web app AND the desktop renderer, so the web app resolves this via PostHog and
 * the packaged desktop renderer resolves the byte-for-byte-equal key from its
 * Labs registry (`DESKTOP_CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY`,
 * default OFF) — the fix cannot land on one surface while the other still
 * cycles. Both alias the same `@repo/api` constant.
 */
export const CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY =
  CHART_DISTINGUISHABLE_SERIES_FLAG_KEY;

/**
 * ISS-5508 (ISS-4779 closed-by-default policy): gates the stated cause on an
 * artifact-detail run action that is unavailable because a run is in flight.
 *
 * ISS-5474 removed the run-state badge, the generation banner and indicator, and
 * the plan sidebar's Loop section, and deliberately did NOT replace them. What it
 * left behind is a control that greys out and will not say why: the header run
 * actions (Generate Plan, Execute, Request Changes, Regenerate Plan, Evaluate …)
 * and the Build section's `Start Building` all disable themselves mid-run via
 * `isCommandDisabled`, with nothing on screen distinguishing "a run is already
 * going" from "this button is dead".
 *
 * When ON, the one disabled-for-that-reason control carries an accessible
 * explanation. It is NOT a revived run-state indicator: nothing reports which
 * run, its status, its outcome, or links to it, and the copy uses the product's
 * current vocabulary (an agent run) rather than the retired Loop noun. It also
 * fires ONLY for the in-flight cause — a control disabled because its mutation is
 * pending, because the status fetch is still loading, or because the artifact is
 * not ready is untouched, so the explanation can never assert a run that is not
 * happening.
 *
 * The gated control also swaps native `disabled` for `aria-disabled`, because a
 * `disabled` element is out of the tab order and its description is unreachable —
 * the explanation would otherwise exist for sighted mouse users only. OFF
 * (default) restores native `disabled` and renders no explanation at all.
 *
 * WEB-ONLY BY CONSTRUCTION, not by omission. `apps/desktop/src/renderer` mounts
 * no artifact editor header and no `BranchesSection`, and reads no
 * `generationStatus`, so there is no desktop surface for a Labs toggle to hide.
 * Per the closed-by-default policy, cross-surface parity is required only when
 * the surface exists on both platforms; this one does not.
 */
export const ARTIFACT_RUN_ACTION_UNAVAILABLE_REASON_FEATURE_FLAG_KEY =
  "artifact-run-action-unavailable-reason" as const;

/**
 * ISS-5841 (ISS-4779 closed-by-default policy): gates ACTIVITY PHASES on the
 * Session detail page — the phases strip AND the "Activity phase" cut in the
 * Timeline's Group-by control. Supersedes FEA-3906, which asked to delete the
 * breakdown outright; a flag reaches the same outcome reversibly.
 *
 * Shared web+desktop surface: `AgentSessionDetailView` mounts on both, so the
 * web app resolves this via PostHog and the packaged desktop renderer resolves
 * the SAME key from its Labs registry
 * (`DESKTOP_SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY`, default OFF), or phases
 * leak on one surface while hidden on the other. Both sides alias the one
 * `@repo/api` leaf constant rather than redeclaring the literal.
 */
export const SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY =
  SESSION_ACTIVITY_PHASES_FLAG_KEY;

/**
 * ARTIFACT RUN IN FLIGHT (ISS-4779 closed-by-default policy): gates the
 * treatment that tells an operator a run is executing against the artifact they
 * are looking at, and links them to the session where it is happening.
 *
 * OFF (default) the artifact detail pages render exactly as they do today —
 * which, for a freshly created artifact, is a blank page with nothing saying
 * work is under way.
 *
 * Web-only: `apps/desktop` has no artifact detail route, so there is no Labs
 * analogue to keep in parity. Aliases the one `@repo/api` leaf constant so a
 * fixture or the project-row follow-up can import the key without the
 * treatment's component graph.
 */
export const ARTIFACT_RUN_IN_FLIGHT_FEATURE_FLAG_KEY =
  ARTIFACT_RUN_IN_FLIGHT_FLAG_KEY;

/**
 * ISS-5061 (ISS-4779 closed-by-default policy): gates the "Agent Collaboration
 * Network" row on the Insights overview dashboard — the aggregate
 * subagent-collaboration graph (FEA-3537) that sits below the model-usage
 * chart.
 *
 * ON, the row is part of the dashboard and renders the graph (or the graph's own
 * empty-state) subject to the same data-driven filter as its rowmates. OFF (the
 * default) the row is ABSENT — no card, no skeleton, no grid slot — rather than
 * degrading to the graph's "No agent collaboration data" empty state, which
 * would claim there is no data when the feature is simply off.
 *
 * DELIBERATELY RE-INTRODUCED. ISS-5280 (#4482) retired this gate to its enabled
 * state as an approved rollout; the operator asked for this one flag of that
 * batch to come back, so the row ships closed-by-default again on both surfaces.
 *
 * Shared web+desktop surface: the web app resolves this via PostHog and the
 * packaged desktop renderer resolves the byte-for-byte-equal key from its Labs
 * registry (`DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY`, default
 * OFF), so the row cannot leak on one surface while hidden on the other — both
 * alias the same `@repo/api` constant.
 */
export const AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY =
  AGENT_COLLABORATION_NETWORK_FLAG_KEY;

/**
 * ISS-5534 (ISS-4779 closed-by-default policy): gates the Agents list
 * Invocations summary card's plugin de-duplication. A `plugin` component is
 * never invoked directly — its `invocations` are the SUM of its
 * skill/command/subagent/mcp children's — so on the "All" type tab, where the
 * plugin AND its children are both rows, the card's flat sum counts every child
 * invocation twice.
 *
 * ON, the card counts each invocation once (plugin rollups contribute nothing
 * whenever their child kinds are present in the population). OFF (the default,
 * dark launch) the card renders exactly the prior total, so the surface is
 * unchanged for every user until the flag is lit.
 *
 * Shared web+desktop surface — the Invocations card is rendered by the shared
 * `AgentsGroupedList` on both. The packaged desktop renderer resolves the
 * byte-for-byte-equal key from its Labs registry
 * (`DESKTOP_AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY`, default OFF), so the
 * change cannot leak on one surface while hidden on the other. Aliases the
 * shared `@repo/api` constant rather than redeclaring the literal.
 */
export const AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY =
  AGENTS_INVOCATIONS_DEDUPE_FLAG_KEY;

/**
 * ISS-5490 (ISS-4779 closed-by-default policy): gates the invite spotlight on
 * My Tasks — the one-time, non-modal nudge pointing at the checklist's "Invite
 * your team" row once a new workspace has finished onboarding.
 *
 * It does NOT gate the wizard trim it was scoped alongside. That change deleted
 * the nine-step sequence rather than parking it behind an OFF branch, so there
 * is no second sequence to fall back to and nothing left to switch. The
 * spotlight is purely additive, so it can still be closed by default, and is.
 *
 * WEB-ONLY BY CONSTRUCTION — no desktop Labs twin, which is why it is declared
 * here rather than in `@repo/api/src/types` beside the cross-surface flag keys:
 * that module is for contracts BOTH `apps/app` and `apps/api` (or a desktop
 * twin) consume, and nothing outside `apps/app` reads this one. My Tasks lives
 * in an `apps/app` route group the desktop renderer never mounts.
 */
export const INVITE_SPOTLIGHT_FEATURE_FLAG_KEY = "invite-spotlight" as const;

/**
 * ISS-5518 / ISS-5519 (ISS-4779 closed-by-default): gates the Agents component
 * detail page saying only what it can back up — a content-hash route that stops
 * publishing its 64-hex digest and names the component instead, and the
 * permanently-dashed "Lines shipped" / "Total cost" cards dropped rather than
 * left sitting beside `LOC / $` as its apparent missing operands.
 *
 * ISS-6462 took the ISS-5521 "Merged PRs" cap disclosure OUT of this flag: the
 * Packs tile discloses the same cap ungated, so gating it here made one screen
 * contradict the other by default.
 *
 * Shared web+desktop surface: `AgentDetail` mounts on the web app AND the
 * desktop renderer, so the web app resolves this via PostHog and the packaged
 * desktop renderer resolves the byte-for-byte-equal key from its Labs registry
 * (`DESKTOP_AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY`, default OFF). Both alias
 * the one `@repo/api` {@link AGENTS_DETAIL_HONESTY_FLAG_KEY} constant, so a
 * rename touches a single definition and cannot split the two.
 */
export const AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY =
  AGENTS_DETAIL_HONESTY_FLAG_KEY;

/**
 * ISS-5951 (ISS-4779 closed-by-default policy): gates the Branch PR-activity
 * timeline's fallback-cost marker.
 *
 * The headline cost prefers the Branch's authoritative total and falls back to
 * the rendered chartable subtotal when timing evidence is incomplete OR when
 * there is no authoritative total. Only the first reason was ever marked, so the
 * second rendered a fallback figure with nothing saying it was one. When ON, the
 * marker is read from the SAME `resolveTimelineCostEvidence` result that selects
 * the value, so the figure and its marker cannot disagree. That result also
 * carries the aggregate-trace-incompleteness reason, which used to mark figures
 * with no sentence to point at.
 *
 * shafty023 review — it gates one behavior change beyond disclosure. A Branch
 * whose trace never arrived (`traceQuery.data ?? null`, the window
 * `NormalizedBranchTracePage` reserves for legacy or failed responses) has no
 * completeness evidence in either direction, yet its cost, LOC/$, and duration
 * rendered exactly as they do for a confirmed-complete trace. When ON those
 * three read "Unavailable" rather than a figure no evidence backs; when OFF the
 * historical figures render unchanged.
 *
 * Shared web+desktop surface: `BranchDetailPage` mounts on both, so the packaged
 * desktop renderer resolves the byte-for-byte-equal key from its Labs registry
 * (`DESKTOP_BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY`, default
 * OFF) rather than the build-type default.
 */
export const BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY =
  BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY;
