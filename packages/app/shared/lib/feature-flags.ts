/**
 * Frontend-only PostHog feature-flag keys for apps/app.
 *
 * These gate client UI rollout and are never read by apps/api, so they live
 * here rather than in `@repo/api` (which is reserved for contract types shared
 * by both apps). Flag keys are kebab-case to match the existing PostHog
 * convention (e.g. `branch-pr`, `compute-target-signing`).
 */

import { AGENT_COLLABORATION_NETWORK_FLAG_KEY } from "@repo/api/src/types/agent-collaboration-network-flag";
import { AGENT_OPS_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/agent-ops-complete-surface-flag";
import { AGENTS_BOUNDED_PAGE_DATA_FLAG_KEY } from "@repo/api/src/types/agents-bounded-page-data-flag";
import { AGENTS_BRANCH_USAGE_SIGNAL_STATES_FLAG_KEY } from "@repo/api/src/types/agents-branch-usage-signal-states-flag";
import { AGENTS_CARD_ATTRIBUTE_LABELS_FLAG_KEY } from "@repo/api/src/types/agents-card-attribute-labels-flag";
import { AGENTS_DEFAULT_SORT_USAGE_FLAG_KEY } from "@repo/api/src/types/agents-default-sort-usage-flag";
import { AGENTS_DEFINITION_EMPTY_STATE_FLAG_KEY } from "@repo/api/src/types/agents-definition-empty-state-flag";
import { AGENTS_DETAIL_HONESTY_FLAG_KEY } from "@repo/api/src/types/agents-detail-honesty-flag";
import { AGENTS_INVOCATIONS_DEDUPE_FLAG_KEY } from "@repo/api/src/types/agents-invocations-dedupe-flag";
import { AGENTS_LOCAL_DATE_WINDOW_FLAG_KEY } from "@repo/api/src/types/agents-local-date-window-flag";
import { AGENTS_NAV_FLAG_KEY } from "@repo/api/src/types/agents-nav-flag";
import { AGENTS_SOURCE_PROVENANCE_FLAG_KEY } from "@repo/api/src/types/agents-source-provenance-flag";
import { AGENTS_TYPE_TAB_OVERFLOW_FLAG_KEY } from "@repo/api/src/types/agents-type-tab-overflow-flag";
import { AGENTS_VERSION_USAGE_FLAG_KEY } from "@repo/api/src/types/agents-version-usage-flag";
import { ARTIFACT_BULK_ACTION_BAR_FLAG_KEY } from "@repo/api/src/types/artifact-bulk-action-bar-flag";
import { ARTIFACT_CELL_PRIMITIVES_FLAG_KEY } from "@repo/api/src/types/artifact-cell-primitives-flag";
import { ARTIFACT_STATUS_LABEL_HONESTY_FLAG_KEY } from "@repo/api/src/types/artifact-status-label-honesty-flag";
import { ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY } from "@repo/api/src/types/artifact-status-root-order-flag";
import { BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY } from "@repo/api/src/types/branch-detail-measured-checks-flag";
import { BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY } from "@repo/api/src/types/branch-detail-metric-honesty-flag";
import { BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FLAG_KEY } from "@repo/api/src/types/branch-detail-pr-base-and-author-flag";
import { BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY } from "@repo/api/src/types/branch-timeline-cost-fallback-marker-flag";
import { BRANCH_TRACE_PARTIAL_SESSION_FLAG_KEY } from "@repo/api/src/types/branch-trace-partial-session-flag";
import { BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY } from "@repo/api/src/types/branches-cohort-transparency-flag";
import { BRANCHES_COLUMN_REGISTRY_FLAG_KEY } from "@repo/api/src/types/branches-column-registry-flag";
import { BRANCHES_LINKED_SESSION_CHIPS_FLAG_KEY } from "@repo/api/src/types/branches-linked-session-chips-flag";
import { BRANCHES_PINNED_NAME_COLUMN_FLAG_KEY } from "@repo/api/src/types/branches-pinned-name-column-flag";
import { CHART_DISTINGUISHABLE_SERIES_FLAG_KEY } from "@repo/api/src/types/chart-distinguishable-series-flag";
import { CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY } from "@repo/api/src/types/custom-field-editor-contracts-flag";
import { DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/diagnostics-complete-surface-flag";
import { DOCUMENT_UNIFIED_COMMENTS_FLAG_KEY } from "@repo/api/src/types/document-unified-comments-flag";
import { DOCUMENTS_CREATE_FAILURE_RECOVERY_FLAG_KEY } from "@repo/api/src/types/documents-create-failure-recovery-flag";
import { DOCUMENTS_INDEX_PAGED_FLAG_KEY } from "@repo/api/src/types/documents-index-paged-flag";
import { DOCUMENTS_INDEX_SERVER_SEARCH_FLAG_KEY } from "@repo/api/src/types/documents-index-server-search-flag";
import { DOCUMENTS_INDEX_STATES_FLAG_KEY } from "@repo/api/src/types/documents-index-states-flag";
import { DOCUMENTS_INDEX_SUMMARY_CARDS_FLAG_KEY } from "@repo/api/src/types/documents-index-summary-cards-flag";
import { ELIGIBLE_BRANCH_NAVIGATION_FLAG_KEY } from "@repo/api/src/types/eligible-branch-navigation-flag";
import { GITHUB_BRAND_MARK_FILLED_FLAG_KEY } from "@repo/api/src/types/github-brand-mark-filled-flag";
import { HELP_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/help-complete-surface-flag";
import { INSIGHTS_SPEND_OUTCOME_FLAG_KEY } from "@repo/api/src/types/insights-spend-outcome-flag";
import { MEMBER_SELF_SERVICE_INSTALL_FLAG_KEY } from "@repo/api/src/types/member-self-service-install-flag";
import { PENSERO_INTEGRATION_FLAG_KEY } from "@repo/api/src/types/pensero-integration-flag";
import { PENSERO_POINTS_PER_DOLLAR_FLAG_KEY } from "@repo/api/src/types/pensero-points-per-dollar-flag";
import { PENSERO_TEAM_IDENTIFIERS_FLAG_KEY } from "@repo/api/src/types/pensero-team-identifiers-flag";
import { PORTABLE_SEARCH_SURFACE_FLAG_KEY } from "@repo/api/src/types/portable-search-surface-flag";
import { PROJECTS_PORTABLE_SURFACE_FLAG_KEY } from "@repo/api/src/types/projects-portable-surface-flag";
import { SESSION_CLAUDE_REPORTED_COST_FLAG_KEY } from "@repo/api/src/types/session-claude-reported-cost-flag";
import { SESSION_LAUNCH_ATTRIBUTION_FLAG_KEY } from "@repo/api/src/types/session-launch-attribution-flag";
import { SESSION_METRIC_POPULATION_DISCLOSURE_FLAG_KEY } from "@repo/api/src/types/session-metric-population-disclosure-flag";
import { SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY } from "@repo/api/src/types/session-timeline-coverage-disclosure-flag";
import { SESSION_TIMELINE_LEGEND_FLAG_KEY } from "@repo/api/src/types/session-timeline-legend-flag";
import { SESSION_TIMELINE_RESOLVABLE_REACH_FLAG_KEY } from "@repo/api/src/types/session-timeline-resolvable-reach-flag";
import { SESSION_TIMELINE_SOURCE_EXTENT_FLAG_KEY } from "@repo/api/src/types/session-timeline-source-extent-flag";
import { SESSION_TOKENS_RECORDED_HONESTY_FLAG_KEY } from "@repo/api/src/types/session-tokens-recorded-honesty-flag";
import { SESSION_TOUCHED_BRANCHES_FLAG_KEY } from "@repo/api/src/types/session-touched-branches-flag";
import { SESSION_TRACE_EVIDENCE_DISCLOSURE_FLAG_KEY } from "@repo/api/src/types/session-trace-evidence-disclosure-flag";
import { SESSION_TRACE_IDLE_ROWS_FLAG_KEY } from "@repo/api/src/types/session-trace-idle-rows-flag";
import { SESSION_TRACE_TAB_FLAG_KEY } from "@repo/api/src/types/session-trace-tab-flag";
import { SESSION_TRANSCRIPT_LOAD_MORE_EVENTS_FLAG_KEY } from "@repo/api/src/types/session-transcript-load-more-events-flag";
import { SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY } from "@repo/api/src/types/session-transcript-never-expected-flag";
import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag";
import { SESSIONS_BRANCHES_TAB_TITLES_FLAG_KEY } from "@repo/api/src/types/sessions-branches-tab-titles-flag";
import { SESSIONS_BRANCHES_TIMEZONE_MODE_FLAG_KEY } from "@repo/api/src/types/sessions-branches-timezone-mode-flag";
import { SESSIONS_COMMENT_COUNT_TAG_FLAG_KEY } from "@repo/api/src/types/sessions-comment-count-tag-flag";
import { SESSIONS_CUSTOM_DATE_WINDOW_FLAG_KEY } from "@repo/api/src/types/sessions-custom-date-window-flag";
import { SESSIONS_FOCUS_RESTORATION_FLAG_KEY } from "@repo/api/src/types/sessions-focus-restoration-flag";
import { SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY } from "@repo/api/src/types/sessions-summary-honest-loading-flag";
import { SHELL_SIDEBAR_V2_FLAG_KEY } from "@repo/api/src/types/shell-sidebar-v2-flag";
import { TABLE_PAGE_SIZE_LADDER_FLAG_KEY } from "@repo/api/src/types/table-page-size-ladder-flag";
import { TAG_CREATE_COLOR_FLAG_KEY } from "@repo/api/src/types/tag-create-color-flag";
import { TRACE_COMMENT_SYNC_ABANDONED_FLAG_KEY } from "@repo/api/src/types/trace-comment-sync-abandoned-flag";
import { UNDO_KEYBINDINGS_FLAG_KEY } from "@repo/api/src/types/undo-keybindings-flag";
import { ArtifactFlag as ArtifactFlagValue } from "./artifact-flags";

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

/** Shared PostHog key for the default-off eligible Branch navigation cutover. */
export const ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY =
  ELIGIBLE_BRANCH_NAVIGATION_FLAG_KEY;
/** Default-off shared flag for the finite-window Branch cohort explanation. */
export const BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY =
  BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY;
/**
 * Default-off shared flag for DISPLAYING the Pensero points per-dollar
 * numerator instead of LOC (ISS-9814). Separate from `pensero-integration`,
 * which gates whether rows may be written at all — see the key's own module for
 * why one key cannot answer both.
 */
export const PENSERO_POINTS_PER_DOLLAR_FEATURE_FLAG_KEY =
  PENSERO_POINTS_PER_DOLLAR_FLAG_KEY;

/**
 * ISS-6959 (ISS-4779 closed-by-default policy): gates the pinned Name column on
 * the Branches list, so a horizontally scrolled row keeps the identifier that
 * says which branch its values belong to.
 *
 * Shared web+desktop surface: the web app resolves this via PostHog, and the
 * packaged desktop renderer resolves the byte-for-byte-equal key from the
 * signed-in account's PostHog assignment
 * (`DESKTOP_BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY`, default
 * OFF), so the pin cannot leak on one surface while hidden on the other.
 */
export const BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY =
  BRANCHES_PINNED_NAME_COLUMN_FLAG_KEY;

/**
 * ISS-10737 (ISS-4779 closed-by-default policy): gates the session Trace tab on
 * the Sessions detail surface.
 *
 * ONE key for both shells. `SessionDetailWorkspace` is shared through
 * `@repo/app` and mounted by `apps/app` AND the desktop renderer, and the
 * desktop resolves the signed-in account's PostHog assignment from the same key
 * space `apps/app` reads — so there is no desktop-named twin and no desktop
 * registry entry. Read at exactly ONE site, which branches between two whole
 * shapes (tab bar present, or today's single document), so the tab, the
 * `?tab=trace` deep link and the invocation-tree query are all gated by the same
 * decision rather than by a boolean threaded into each of them.
 */
export const SESSION_TRACE_TAB_FEATURE_FLAG_KEY = SESSION_TRACE_TAB_FLAG_KEY;

export const JUDGES_FEATURE_FLAG_KEY = "the-one-flag" as const;

/**
 * Gates session owner attribution across the Sessions surface (FEA-3330). When
 * enabled, the session detail Properties panel shows an "Owner" row, the
 * Sessions table gains an "Owner" column, and the Sessions filter menu exposes
 * an "Owner" facet (options sourced from the usage `byUser` breakdown). Each
 * session already carries its Owner on the data contract — its assignee
 * (`AgentSessionListItem.assignee`, falling back to `user` from a producer
 * that omits it; ISS-12251 D-1) — and the server already honors the `userIds`
 * query param, so this flag only controls the UI rollout (dark launch, off by
 * default) — with it off every surface renders exactly as before.
 *
 * The shared filter facet (`SessionsToolbar`) and detail row
 * (`AgentSessionDetailView`) read this flag via `useFeatureFlagEnabled`; the
 * opt-in table column is surfaced by the host that owns column visibility (the
 * web Sessions page injects `"owner"` into `visibleColumns` when the flag is
 * on). This rolls out on web first: the desktop renderer resolves the SAME
 * PostHog key, so the surface stays dark there until the rollout reaches that
 * account. Lighting it up on desktop needs only the desktop Sessions table's
 * column wiring — there is no registration step.
 */
export const SESSIONS_OWNER_ATTRIBUTION_FEATURE_FLAG_KEY =
  "sessions-owner-attribution" as const;

/**
 * FEA-4204 (ISS-4779 closed-by-default policy): gates the comment-count tag in
 * the Sessions list's lead cell. Off by default — with it off the lead cell is
 * the session name and nothing else.
 *
 * Shared web+desktop surface: the web app resolves this via PostHog, and the
 * packaged desktop renderer resolves the byte-for-byte-equal key from the
 * signed-in account's PostHog assignment
 * (`DESKTOP_SESSIONS_COMMENT_COUNT_TAG_FEATURE_FLAG_KEY`, default OFF),
 * so the tag cannot leak on one surface while hidden on the other.
 */
export const SESSIONS_COMMENT_COUNT_TAG_FEATURE_FLAG_KEY =
  SESSIONS_COMMENT_COUNT_TAG_FLAG_KEY;

/**
 * ISS-9329 (ISS-4779 closed-by-default policy): gates the artifact bulk action
 * rail on the project all-artifacts surface. Off by default — with it closed
 * the project selection bar renders exactly the controls it renders today, and
 * neither bar can reach an operation the other cannot.
 */
export const ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY =
  ARTIFACT_BULK_ACTION_BAR_FLAG_KEY;

/**
 * ISS-8712 (ISS-4779 closed-by-default policy): gates the Sessions list's `Tags`
 * column — the org tag vocabulary applied to a session's Artifact. Off by
 * default.
 *
 * WEB-ONLY, unlike the two keys above: per operator directive (2026-08-30) Labs
 * toggles are deprecated, so there is no desktop registry entry to keep in step
 * with this one. The desktop renderer reads the same shared column declaration
 * through `useFeatureFlagEnabledOptional`, which resolves OFF with no PostHog
 * provider — so the column stays hidden there by construction rather than by a
 * second gate that could drift.
 */
export const SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY =
  SESSIONS_ARTIFACT_TAGS_FLAG_KEY;

/**
 * ISS-9555 (ISS-4779 closed-by-default policy): gates keyboard focus
 * restoration on the Sessions list — the grid taking focus back to its entry
 * cell after a page turn instead of leaving it on `<body>`, and its roving tab
 * stop resuming on the row the reader opened instead of the first row. Off by
 * default, which is today's behaviour on both shells.
 *
 * ONE key for both shells: `apps/app` and the desktop renderer mount the same
 * `SessionsListSurfaceV2`, and the desktop renderer resolves the signed-in
 * account's PostHog assignment from this same key space — so there is no
 * desktop Labs toggle and no desktop registry entry to keep in step. See the
 * key's own module for what it gates and why the two behaviours share a key.
 */
export const SESSIONS_FOCUS_RESTORATION_FEATURE_FLAG_KEY =
  SESSIONS_FOCUS_RESTORATION_FLAG_KEY;

/**
 * ISS-8940 (ISS-4779 closed-by-default policy): gates the Documents index's
 * six-state contract — loading, populated, first-use empty, no-results,
 * blocking error, and a failed background refresh that keeps its rows. Off by
 * default, which leaves the index deriving its states exactly as it does today.
 *
 * WEB-ONLY: the desktop shell has no Documents destination at all, so there is
 * no second surface to keep in step. See the key's own module for why.
 */
export const DOCUMENTS_INDEX_STATES_FEATURE_FLAG_KEY =
  DOCUMENTS_INDEX_STATES_FLAG_KEY;

/**
 * ISS-9724 (ISS-4779 closed-by-default policy): gates whether the Documents
 * index sends its search term to `GET /documents` — where it is matched against
 * the whole population in the database — or leaves it to the client filter over
 * the rows already loaded. Off by default, which leaves the index searching
 * exactly as it does today.
 *
 * WEB-ONLY, same as its ISS-8940 sibling above: the desktop shell has no
 * Documents destination. Per operator directive (2026-08-30) Labs toggles are
 * deprecated, so there is no desktop registry entry either way.
 */
export const DOCUMENTS_INDEX_SERVER_SEARCH_FEATURE_FLAG_KEY =
  DOCUMENTS_INDEX_SERVER_SEARCH_FLAG_KEY;

/**
 * ISS-9157 (ISS-4779 closed-by-default policy): gates whether the Documents
 * index reads one server page (`limit`/`offset` + `includeTotal`) and renders
 * a pager, or the shipped unbounded read. Off by default; off is the shipped
 * request byte-for-byte. Web-only for the same reason its two siblings above
 * are: the desktop shell has no Documents destination.
 */
export const DOCUMENTS_INDEX_PAGED_FEATURE_FLAG_KEY =
  DOCUMENTS_INDEX_PAGED_FLAG_KEY;

/**
 * ISS-8938 (ISS-4779 closed-by-default policy): gates how the one-field New
 * Document dialog reports a FAILED create — one message the dialog owns, with
 * the typed title intact and a retry, instead of today's raw error line plus a
 * second, generic toast from the shared QueryClient. Off by default, which
 * leaves the failure path reporting exactly as it does today.
 *
 * WEB-ONLY for the same structural reason as its two siblings above, and not as
 * a choice: the desktop shell has no Documents destination, so there is no
 * second surface for the gate to leak on. See the key's own module.
 */
export const DOCUMENTS_CREATE_FAILURE_RECOVERY_FEATURE_FLAG_KEY =
  DOCUMENTS_CREATE_FAILURE_RECOVERY_FLAG_KEY;

/**
 * ISS-6888 (ISS-4779 closed-by-default policy): gates the Agents workspace's
 * date-window comparisons on the DESKTOP LOCAL inventory — the prior-period
 * delta and the unwindowed facet universe. Off by default.
 *
 * DESKTOP-ONLY in effect, and read by `DesktopAgentsDateWindowGate` — which
 * wraps the Agents view in `App`, the nearest point to the source seam that
 * sits UNDER the real PostHog-backed provider — rather than inside the shared
 * list: the HTTP source has rendered both reads since FEA-3178, so gating the
 * shared component would have withdrawn a shipped web capability. Per operator
 * directive (2026-08-30) Labs toggles are deprecated, so there is no desktop
 * registry alias; ISS-8753 has the desktop renderer resolve this same PostHog
 * key from the signed-in user's assignment, which is why one key suffices.
 */
export const AGENTS_LOCAL_DATE_WINDOW_FEATURE_FLAG_KEY =
  AGENTS_LOCAL_DATE_WINDOW_FLAG_KEY;

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
 * packaged desktop renderer resolves the byte-for-byte-equal key from the
 * signed-in account's PostHog assignment
 * (`DESKTOP_INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY`, default OFF), so
 * the lens cannot leak on one surface while hidden on the other — both alias the
 * same `@repo/api` constant.
 */
export const INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY =
  INSIGHTS_SPEND_OUTCOME_FLAG_KEY;

/**
 * FEA-4201 (ISS-4779 closed-by-default policy): gates the Sessions listing's
 * explicit from/to date window — the `?from=`/`?to=` params, the Custom entry
 * point beside the preset pills, and the clear control beside it.
 *
 * Off, the listing reads over the rolling `?range=` preset exactly as before and
 * the two params are inert, so a link written by a build that has the flag on
 * cannot narrow a listing whose viewer has no control to see or clear it.
 *
 * Shared web+desktop surface: the web app resolves this via PostHog and the
 * packaged desktop renderer resolves the byte-for-byte-equal key from the
 * signed-in account's PostHog assignment
 * (`DESKTOP_SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY`, default OFF)
 * — both alias the same `@repo/api` constant.
 */
export const SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY =
  SESSIONS_CUSTOM_DATE_WINDOW_FLAG_KEY;

/**
 * ISS-4728 (ISS-4779 closed-by-default policy): gated folding the web Sessions
 * page's `?userId=` selected-user narrower into the ISS-4605 active-filter chip
 * row, replacing the legacy "User filtered" badge.
 *
 * **RETIRED ENABLED by ISS-10301, and no longer READ anywhere.** The OFF arm was
 * the badge plus its "Showing sessions for the selected user." sentence, and both
 * lived in the v1 Sessions host this ticket deleted — so the key's only remaining
 * effect would have been to withhold the chip from every reader who cannot
 * resolve it (every signed-out or unassigned one), leaving a `?userId=`-narrowed
 * list with nothing naming the narrower and a scoped-away result labelled "No
 * sessions yet". `sessions-v2-page.tsx` now derives `scopeUserId` from the param
 * unconditionally.
 *
 * The constant is kept because `POSTHOG_FLAG_REGISTRATION_LEDGER`'s contract
 * pairs its row with this declaration; removing the pair, and archiving the
 * PostHog flag itself, is its own reviewable change.
 *
 * WEB-ONLY, deliberately: `?userId=` is a web-route narrower with no desktop
 * analogue (the desktop Sessions view threads only the multi-select Owner facet,
 * and its hash router has no `userId` param), so there was never a desktop
 * surface to keep in parity and no desktop twin for this key.
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
 * the signed-in account's PostHog assignment
 * (`DESKTOP_AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY`,
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
 * byte-for-byte-equal key from the signed-in account's PostHog assignment
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
 * desktop renderer resolves the byte-for-byte-equal key from the signed-in
 * account's PostHog assignment
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
 * **Its own key, deliberately.** ISS-5842's instruction was to ship under the
 * Sessions cost flag of the day (`sessions-cost-billing-honesty`, since retired
 * by ISS-8791), but that flag gated Sessions COST SEMANTICS and was read by
 * neither Insights, Branches, the overview dashboard, nor the desktop
 * first-launch dashboard — all of which mount these same primitives. A
 * Sessions flag threaded into a generic primitive would render one component two
 * different ways inside one product; a separate key gates the presentation
 * change across every consumer at once instead (whitlockk + codex review on #4823).
 *
 * Shared web+desktop surface: these primitives mount on the web app AND the
 * desktop renderer, so the web app resolves this via PostHog and the packaged
 * desktop renderer resolves the byte-for-byte-equal key from the signed-in
 * account's PostHog assignment
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
 * ISS-6493 (ISS-4779 closed-by-default policy): gates the NEUTRAL delta chip
 * taking the same pill as its scored siblings, on the same shared metric
 * primitives — and nothing else.
 *
 * ON, a neutral movement renders the pill geometry improvement and regression
 * already render (same shape, same padding, same type) and differs from them by
 * colour alone, so one row of metric cards reads as one component in three tonal
 * states rather than three different components. OFF (default, dark launch) a
 * neutral tone renders bare, exactly as it does today. The verdict word is NOT
 * this flag's business under either state: "better" / "worse" keep rendering.
 *
 * **Its own key, and specifically NOT `metric-delta-unified-pill`.** ISS-5842
 * built the neutral pill and the verdict-word removal as one treatment behind
 * that one key, which cannot graduate until the #4823 sentiment-cue question is
 * decided — with the verdict word gone, a `+38%` higher-is-better and a `+38%`
 * lower-is-better are separated by hue alone. That question is about the WORD. A
 * neutral delta makes no good/bad claim at all, so it has no hue-alone problem
 * and was only ever held by being bundled. Splitting the gate ships the half
 * that is unblocked and leaves the blocked half gated; graduating
 * `metric-delta-unified-pill` remains forbidden.
 *
 * Shared web+desktop surface: these primitives mount on the web app AND the
 * desktop renderer, so the web app resolves this via PostHog and the packaged
 * desktop renderer resolves the byte-for-byte-equal key from the signed-in
 * account's PostHog assignment
 * (`DESKTOP_METRIC_DELTA_NEUTRAL_PILL_FEATURE_FLAG_KEY`, default OFF).
 */
export const METRIC_DELTA_NEUTRAL_PILL_FEATURE_FLAG_KEY =
  "metric-delta-neutral-pill" as const;

/**
 * ISS-9730 (ISS-4779 closed-by-default policy): a metric card whose value is
 * NOT COMPUTABLE renders nothing at all, instead of the muted "No data" glyph
 * over a caption saying why.
 *
 * Reverses a deliberate, tested design — see the ISS-4737 note in
 * `branches-summary-cards.tsx` — so it ships closed and graduates only once the
 * hidden-card row layout has been walked on every consuming surface.
 *
 * Shared web+desktop surface: `MetricCard` mounts on the web app AND the
 * desktop renderer, and the renderer resolves `packages/app` flags through the
 * PostHog-backed `DesktopFeatureFlagProvider`, so this ONE key moves both
 * surfaces together. That is the point: a card hidden on web while its desktop
 * twin still shows "Unavailable" is the two surfaces disagreeing about the same
 * record, which is worse than not shipping it.
 */
export const METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY =
  "metric-card-hide-unavailable" as const;

/**
 * ISS-7845 (ISS-4779 closed-by-default policy): gates the two Sessions delivery
 * cards (`PRs Shipped`, `LOC / $`) dashing through `MetricCard`'s own no-data
 * treatment instead of a literal em dash passed as a value.
 *
 * OFF (default) each renders `value="—"`, which is a non-empty string, so the
 * primitive's `noData` branch stays false and the dash paints in the normal
 * value treatment — semibold, full foreground — beside the three always-
 * available cards, whose dashes go through `noData` and paint muted at normal
 * weight. ON, all five derive the dash from one code path. ISS-5401 already
 * ruled that an absent value is muted rather than emphasized and applied it to
 * the trio; this is that ruling reaching the pair it missed, not a fresh design
 * question. The GLYPH is unchanged under both states (`KPI_NO_VALUE`, the same
 * em dash the trio renders) — only weight and colour move.
 *
 * Shared web+desktop surface: `SessionsSummaryCards` mounts on the web app AND
 * the desktop renderer, so the web app resolves this via PostHog and the
 * packaged desktop renderer resolves the byte-for-byte-equal key from the
 * signed-in account's PostHog assignment
 * (`DESKTOP_SESSIONS_DELIVERY_CARD_NO_DATA_FEATURE_FLAG_KEY`, default
 * OFF).
 */
export const SESSIONS_DELIVERY_CARD_NO_DATA_FEATURE_FLAG_KEY =
  "sessions-delivery-card-no-data" as const;

/**
 * ISS-5037 (ISS-4779 closed-by-default policy): the web sidebar's SHAPE, and
 * the reachability of the routes Labs owns. It NO LONGER decides whether the
 * Labs MENU renders — {@link ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY} owns
 * that mount, and this key is going to 100% while that one stays closed.
 *
 * WHAT IT STILL OWNS. Two things, and only these.
 *  - The SHAPE: ON, the sidebar takes the ISS-8759 moved layout, where Inbox,
 *    My Tasks, Documents, Issues, Agents and Search are grouped under
 *    Labs rather than in the nav (`labsMovedNavGroup`). OFF, it reads the
 *    pre-move grouping (`currentNavGroup`) and those rows sit in the nav.
 *  - The ROUTES: each Labs route (`/insights`, `/insights/lost-work`,
 *    `/insights/tokenops-waste`, `/judges-analytics`, `/packs`, `/help`) gates
 *    on THIS key through `FeatureFlagRouteGate`, so the URL is reachable
 *    whenever the shape is on — including for a viewer whose Labs menu is
 *    closed, which is the whole point of the split. The moved destinations
 *    leave the nav and stay reachable by URL.
 *
 * It still sits ABOVE the per-item gates rather than replacing them: an item's
 * own `featureFlag` (`maybeFeatureFlagged`) and its `adminOnly` filter still
 * apply, and toggling this off never writes to, resets, or shadows those
 * per-item values.
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
 * ISS-4779 closed-by-default: the Labs MENU MOUNT, and nothing else. ON, the
 * Labs `SidebarCollapsibleSection` renders — header, rows, and the dev-mode
 * switch inside it. OFF, nothing of the section renders at all, on either
 * sidebar implementation.
 *
 * Split off {@link LABS_NAV_SECTION_FEATURE_FLAG_KEY} so the two can hold
 * different positions: that key goes to 100% (every viewer gets the moved
 * layout, and every Labs route stays URL-reachable) while this one stays closed
 * to everyone but staff, and can be pulled without reverting the move.
 *
 * IT IS NEVER READ ALONE. A menu with no shape behind it would list rows whose
 * routes are gated by the OTHER key and land the viewer on a not-found, so
 * `useLabsMenuVisible` ANDs the two and is the only module that answers this
 * question. Nothing reads this key outside that hook.
 */
export const ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY =
  "enable-labs-nav-section" as const;

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
 * table, so there is no desktop surface to keep in parity and no desktop twin
 * for this key — the same reasoning that governed the My Tasks copy-polish key
 * before ISS-5280 retired it.
 */
export const MY_TASKS_RECENCY_WINDOW_FEATURE_FLAG_KEY =
  "my-tasks-recency-window" as const;

/**
 * ISS-5355: the Sessions Project filter facet, which the project-detail
 * "active sessions" strip links into.
 *
 * Off by default (ISS-4779 closed-by-default). With the flag off the Project
 * facet is not offered and no `project=` chip is derived, so no filter can
 * narrow the list without a control to name and remove it.
 *
 * Web-only, so there is no desktop twin. A session's project comes from its
 * cloud artifact, and the desktop local producer "cannot resolve cloud
 * projects"
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
 * would flip Sessions, Branches, Agents, and Packs the moment anyone
 * wanted to see the project page paginate.
 *
 * ## Web-only, deliberately
 *
 * No desktop twin. `DocumentsView` is imported by exactly three surfaces,
 * all in `apps/app` (project detail, My Tasks, and the documents index); the
 * desktop renderer does not consume it, so there is no second surface this
 * could leak on. The closed-by-default policy requires parity only where the
 * surface exists on both platforms.
 *
 * Declared HERE and not in `packages/api/src/types` (whitlockk): that package is
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
 * packaged desktop renderer resolves the byte-for-byte-equal key from the
 * signed-in account's PostHog assignment
 * (`DESKTOP_SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY`, default
 * OFF), so the state cannot leak on one surface while hidden on the other.
 */
export const SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY =
  SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY;

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
 * packaged desktop renderer resolves the byte-for-byte-equal key from the
 * signed-in account's PostHog assignment
 * (`DESKTOP_SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY`,
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
 * packaged desktop renderer resolves the byte-for-byte-equal key from the
 * signed-in account's PostHog assignment (default OFF), so titles cannot appear
 * on one surface while hidden on
 * the other — both alias the same `@repo/api` constant.
 */
export const SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY =
  SESSIONS_BRANCHES_TAB_TITLES_FLAG_KEY;

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
 * mounts the tab and there is no desktop surface for a gate to hide. Per
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
 * byte-for-byte-equal key from the signed-in account's PostHog assignment
 * (`DESKTOP_AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY`, default OFF). Both alias
 * the one `@repo/api` {@link AGENTS_TYPE_TAB_OVERFLOW_FLAG_KEY} constant, so a
 * rename touches a single definition and cannot split the two surfaces.
 */
export const AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY =
  AGENTS_TYPE_TAB_OVERFLOW_FLAG_KEY;

/**
 * ISS-5527 / ISS-5530 / ISS-5524 / ISS-5528 (ISS-4779 closed-by-default
 * policy): gates the Agents inventory honesty batch —
 * group headers dropping their page-scoped counts and empty kind headers, the
 * KPI strip leaving the table's horizontal scroll plane, a multi-harness badge
 * reading "Multiple harnesses" instead of the raw `both`, and the Source column
 * (a verbatim duplicate of Component until the provenance projection graduates)
 * becoming opt-in rather than a default column.
 *
 * The summary strip is NOT one of its swaps: ISS-9931 made that treatment
 * unconditional, so graduating this key will not change what the KPI cards
 * render. Each module that swaps on it reads it ITSELF rather than being handed
 * the boolean, per the one-read-site rule. When OFF (default) every one of them
 * renders exactly what ships today.
 *
 * WEB-ONLY gate, and that is why the literal is declared HERE rather than in a
 * `@repo/api/src/types/*-flag` module like every Agents sibling above. Those
 * live in `@repo/api` because a SECOND process outside `packages/app` — the
 * desktop main process — imports the same literal to register a Labs toggle, and
 * a shared module is the only way both can spell one key. This key has no Labs
 * registration (toggles were retired as a gating mechanism by the operator
 * directive of 2026-08-30) and no server-side reader, so `packages/app` is its
 * only consumer and `@repo/api/src/types` — which is for types BOTH `apps/app`
 * and `apps/api` consume — would be the wrong owner.
 *
 * `AgentsGroupedList` still drives both surfaces. The desktop renderer resolves
 * this key through whatever flag adapter it mounts — closed when it mounts none
 * — so one gate still covers both and neither can show the other's screen.
 */
export const AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY =
  "agents-surface-honesty" as const;

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
 * byte-for-byte-equal key from the signed-in account's PostHog assignment
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
 * the packaged desktop renderer resolves the byte-for-byte-equal key from the
 * signed-in account's PostHog assignment
 * (`DESKTOP_CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY`,
 * default OFF) — the fix cannot land on one surface while the other still
 * cycles. Both alias the same `@repo/api` constant.
 */
export const CHART_DISTINGUISHABLE_SERIES_FEATURE_FLAG_KEY =
  CHART_DISTINGUISHABLE_SERIES_FLAG_KEY;

/**
 * ISS-8155 AC-1 (ISS-4779 closed-by-default policy): the pull-request picker
 * row's base ref and CI rollup.
 *
 * `GitHubPullRequestSummary` has carried `baseBranch` and `checksStatus` all
 * along; this row rendered neither, so the projection served the fields and the
 * surface dropped them — the absence was hidden rather than stated. ON adds both
 * with explicit unmeasured states: an unreported base takes the same `—`
 * placeholder the Branches table uses, and an absent rollup says so in words
 * instead of borrowing the provider's measured `UNKNOWN`. OFF is byte-identical
 * to the row that shipped.
 *
 * Scoped to the two fields this row never rendered. The sibling half of ISS-8155
 * — naming an unattributed author honestly instead of as the literal `unknown` —
 * ships UNFLAGGED as a bug fix (operator decision, 2026-08-26): a login a real
 * GitHub account can hold was never intended output, so ISS-4779's
 * already-intended-behavior exemption covers it. Adding two fields nobody has
 * seen before is not that, and keeps its gate.
 *
 * WEB-ONLY BY CONSTRUCTION, same reason as the author flag above:
 * `apps/desktop/src/renderer` mounts no `SelectPullRequestDialog`, so there is
 * no desktop surface for a gate to hide.
 */
export const PULL_REQUEST_ROW_PROJECTION_FIELDS_FEATURE_FLAG_KEY =
  "pull-request-row-projection-fields" as const;

/**
 * ISS-8241 Half A (ISS-4779 closed-by-default policy): the Branch detail's
 * "Checks & review" box served from the MEASURED projection instead of a live
 * GitHub read. Aliases the shared `@repo/api` leaf so the web PostHog gate and
 * the desktop gate cannot drift; the leaf's docstring carries the
 * contract, the four states, and the freshness cost Perrin accepted.
 */
export const BRANCH_DETAIL_MEASURED_CHECKS_FEATURE_FLAG_KEY =
  BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY;

/**
 * ISS-8241 Half B (ISS-4779 closed-by-default policy): the Branch detail
 * pull-request box's base ref and author. Aliases the shared `@repo/api` leaf so
 * the web PostHog gate and the desktop gate cannot drift; the leaf's
 * docstring carries the contract and why this is NOT the picker-row key above.
 */
export const BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FEATURE_FLAG_KEY =
  BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FLAG_KEY;

/**
 * ISS-6954/6955/6957/6958 (ISS-4779 closed-by-default policy): the Branch detail
 * outcome presentation — one name for the outcome metric, a heading that does
 * not claim the wrong measurement, a PR-less card that names the pull request as
 * the reason, and durations that scale past minutes. Aliases the shared
 * `@repo/api` leaf so the web PostHog gate and the desktop gate cannot
 * drift; the leaf's docstring carries the contract and why it is one key.
 */
export const BRANCH_DETAIL_METRIC_HONESTY_FEATURE_FLAG_KEY =
  BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY;

/**
 * ISS-5850 (ISS-4779 closed-by-default policy): the Session Timeline's
 * unmeasured-interval disclosure — a column the producer's stated activity
 * extent does not reach stops rendering as an observed quiet stretch.
 *
 * Shared web+desktop surface: `AgentSessionDetailView` mounts on both, so both
 * sides alias the one `@repo/api` leaf constant
 * (`SESSION_TIMELINE_SOURCE_EXTENT_FLAG_KEY`) rather than redeclaring the
 * literal, so the disclosure cannot appear on one surface while hidden on the
 * other. The full rationale lives on that constant.
 */
export const SESSION_TIMELINE_SOURCE_EXTENT_FEATURE_FLAG_KEY =
  SESSION_TIMELINE_SOURCE_EXTENT_FLAG_KEY;

/**
 * ISS-8727 (ISS-4779 closed-by-default policy): the Session Timeline's
 * full-column hit target follows the RESOLVED jump rather than the transcript
 * anchor alone, so a bar can no longer wear the enlarged target and the
 * withdrawn `.no-jump` affordance at the same time.
 *
 * Web-side only — Labs toggles are deprecated (operator directive 2026-08-30),
 * and the desktop resolves this same key from the signed-in PostHog assignment
 * its provider already holds, so one key still flips both surfaces together.
 * The leaf's docstring carries the full contract.
 */
export const SESSION_TIMELINE_RESOLVABLE_REACH_FEATURE_FLAG_KEY =
  SESSION_TIMELINE_RESOLVABLE_REACH_FLAG_KEY;

/**
 * ISS-10598 (ISS-4779 closed-by-default policy): the Session Timeline renders a
 * colour key for its bar segments and its event dots.
 *
 * Web-side only — Labs toggles are deprecated (operator directive 2026-08-30),
 * and the desktop resolves this same key from the signed-in PostHog assignment
 * its provider already holds, so one key still flips both surfaces together.
 * The leaf's docstring carries the full contract.
 */
export const SESSION_TIMELINE_LEGEND_FEATURE_FLAG_KEY =
  SESSION_TIMELINE_LEGEND_FLAG_KEY;

/**
 * ISS-9560 (ISS-4779 closed-by-default policy): gates one artifact-status label
 * per vocabulary and one honest render for a status this build does not
 * recognize — the My Tasks board's raw `CHANGES_REQUESTED` chip, the search
 * project row's raw token, the badges' `?? status` fallback, and the two
 * per-type status icons' literal "Status" name.
 *
 * NOT the status PICKER, despite an earlier draft of this comment: its options
 * are drawn from the same closed enums its label maps exhaust, so it has no
 * unrecognized-status case for a gate to change.
 *
 * ONE key for a surface both shells mount: the desktop renderer resolves the
 * signed-in account's PostHog assignment from this same key space, so there is
 * no second desktop key and no registry entry to pair with it. Every consumer
 * reads it through `useArtifactStatusDisplay`
 * (`@repo/app/shared/hooks/use-artifact-status-display`), which is the single
 * read site; see that module for why the read is not inlined per component.
 *
 * NOT gated by this key, deliberately: `apps/app/lib/og-metadata.ts`. It is a
 * server module with no flag seam, and its unfurl falling through to the
 * artifact TYPE label ("Issue, Issue") is a defect fix restoring already-intended
 * behavior.
 */
export const ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY =
  ARTIFACT_STATUS_LABEL_HONESTY_FLAG_KEY;

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
 * Shared web+desktop surface gated by ONE PostHog key: the web app resolves it
 * through its PostHog adapter, and the desktop renderer resolves the
 * byte-for-byte-equal key from the signed-in account's PostHog assignment
 * delivered over the IPC bridge (`DesktopFeatureFlagProvider`). Both alias the
 * same `@repo/api` constant, so the row cannot leak on one surface while hidden
 * on the other.
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
 * byte-for-byte-equal key from the signed-in account's PostHog assignment
 * (`DESKTOP_AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY`, default OFF), so the
 * change cannot leak on one surface while hidden on the other. Aliases the
 * shared `@repo/api` constant rather than redeclaring the literal.
 */
export const AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY =
  AGENTS_INVOCATIONS_DEDUPE_FLAG_KEY;

/**
 * ISS-6822 (ISS-4779 closed-by-default policy): gates the Agents list's BOUNDED
 * page-data read.
 *
 * OFF (the default) the list pulls the inventory populations in full and
 * sorts/filters/pages/counts/aggregates them in the browser — up to three
 * 5,000-row requests for one ~50-row page. ON, it asks the data source for the
 * page, the facet counts, and both window aggregates in one bounded call, and
 * the identical shared reduction runs at the producer instead.
 *
 * Shared web+desktop surface — the list is rendered by the shared
 * `AgentsGroupedList` on both. The packaged desktop renderer resolves the
 * byte-for-byte-equal key from the signed-in account's PostHog assignment
 * (`DESKTOP_AGENTS_BOUNDED_PAGE_DATA_FEATURE_FLAG_KEY`, default OFF), so the
 * change cannot leak on one surface while hidden on the other. Aliases the
 * shared `@repo/api` constant rather than redeclaring the literal.
 */
export const AGENTS_BOUNDED_PAGE_DATA_FEATURE_FLAG_KEY =
  AGENTS_BOUNDED_PAGE_DATA_FLAG_KEY;

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
 * desktop renderer resolves the byte-for-byte-equal key from the signed-in
 * account's PostHog assignment
 * (`DESKTOP_AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY`, default OFF). Both alias
 * the one `@repo/api` {@link AGENTS_DETAIL_HONESTY_FLAG_KEY} constant, so a
 * rename touches a single definition and cannot split the two.
 */
export const AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY =
  AGENTS_DETAIL_HONESTY_FLAG_KEY;

/**
 * ISS-5951 / ISS-5747 (ISS-4779 closed-by-default policy): gates Branch
 * PR-activity timeline cost evidence.
 *
 * When ON, the headline cost marker is read from the same predicate that
 * selects the value, missing trace evidence makes cost/LOC/$/duration read
 * "Unavailable", and a loaded subset reads "Unavailable" if any loaded Session
 * lacks explicit cost evidence. Explicit zero cost still reads `$0.00`. When
 * OFF, historical figures render unchanged.
 *
 * Shared web+desktop surface: `BranchDetailPage` mounts on both, so the packaged
 * desktop renderer resolves the byte-for-byte-equal key from the signed-in
 * account's PostHog assignment
 * (`DESKTOP_BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY`, default
 * OFF); an unknown key settles CLOSED in every build.
 */
export const BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY =
  BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY;

/**
 * ISS-7229 (ISS-4779 closed-by-default): adds a "Claude reported" cost row to the
 * session-detail Properties panel beside our estimate, for sessions where Claude
 * reported a `result.total_cost_usd`. An observed session read $1,438.84
 * estimated against $1,502.10 reported; only the estimate was ever shown.
 *
 * OFF ⇒ the panel is byte-identical to today. ON ⇒ the row appears ONLY when a
 * reported figure exists, because the alternative is publishing our estimate
 * under Claude's name.
 *
 * Shared web+desktop surface: `SessionPropertiesPanel` mounts on both, so the
 * packaged desktop renderer resolves the byte-equal key from the signed-in
 * account's PostHog assignment
 * (`DESKTOP_SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY`, default OFF).
 */
export const SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY =
  SESSION_CLAUDE_REPORTED_COST_FLAG_KEY;

/**
 * ISS-7259 (ISS-4779 closed-by-default): adds the harness-stamped launch
 * attribution rows to the session-detail Properties panel — how the harness
 * itself said the thread came to run (Codex spawn facts; Claude's first
 * attributed skill and prompt source).
 *
 * OFF ⇒ the panel is byte-identical to today. ON ⇒ each row appears ONLY when
 * the harness actually stamped that fact, because a labeled em-dash would assert
 * this build looked and found nothing when most sessions were never stamped at
 * all.
 *
 * Shared web+desktop surface: `SessionPropertiesPanel` mounts on both, so the
 * packaged desktop renderer resolves the byte-equal key from the signed-in
 * account's PostHog assignment
 * (`DESKTOP_SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY`, default OFF).
 */
export const SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY =
  SESSION_LAUNCH_ATTRIBUTION_FLAG_KEY;

/**
 * ISS-5637 (ISS-4779 closed-by-default): gates the session-detail Tokens row
 * telling apart a session that RECORDED no token usage from one measured at
 * zero.
 *
 * ISS-5565 gave the row a per-counter null unknown state that neither producer
 * can reach (cloud: four `BigInt @default(0)` columns read through a `toNumber`
 * that maps null to `0`; desktop: `sumTokenUsage` folding out of `zeroTotals()`),
 * so a zero-usage session still printed `0 in | 0 out | 0 cache read | 0 cache
 * write` two rows above a Cost dash that means "no token usage recorded to
 * price".
 *
 * ON ⇒ the row asks the SAME question the Cost row already asks —
 * `hasRecordedTokenUsage` (`agents/lib/cost-availability`) — so the two cannot
 * state opposite things about one session. A per-counter zero inside a session
 * that DID record usage still renders as a measured `0`. OFF ⇒ the panel is
 * byte-identical to today.
 *
 * Shared web+desktop surface: `SessionPropertiesPanel` mounts on both, so the
 * packaged desktop renderer resolves the byte-equal key from the signed-in
 * account's PostHog assignment
 * (`DESKTOP_SESSION_TOKENS_RECORDED_HONESTY_FEATURE_FLAG_KEY`, default OFF).
 */
export const SESSION_TOKENS_RECORDED_HONESTY_FEATURE_FLAG_KEY =
  SESSION_TOKENS_RECORDED_HONESTY_FLAG_KEY;

/**
 * ISS-7427 (ISS-4779 closed-by-default policy): the Session Trace header's
 * evidence disclosure.
 *
 * ON ⇒ when the served `evidenceCoverage` is `metadataOnly` — the main
 * transcript is terminally absent yet the response still carries independent
 * evidence — the trace count says which population it counted, so "216 events"
 * no longer reads as a description of the panel below it saying "Transcript not
 * archived". OFF ⇒ the header is byte-identical to today.
 *
 * Shared web+desktop surface: the Session Trace header mounts on both through
 * `AgentSessionDetailView`, so the packaged desktop renderer resolves the
 * byte-equal key from the signed-in account's PostHog assignment
 * (`DESKTOP_SESSION_TRACE_EVIDENCE_DISCLOSURE_FEATURE_FLAG_KEY`, default OFF).
 */
export const SESSION_TRACE_EVIDENCE_DISCLOSURE_FEATURE_FLAG_KEY =
  SESSION_TRACE_EVIDENCE_DISCLOSURE_FLAG_KEY;
/**
 * ISS-8652 (ISS-4779 closed-by-default): gates the Session Trace's IDLE ROWS.
 * `buildMergedTrace` already computes the gap between two stamped items and the
 * branch adapter already carries it as an `idle` turn item; `buildTraceGroups`
 * then dropped it, so a multi-minute pause rendered as two adjacent turns with
 * nothing between them saying time had passed. ON ⇒ the pause is its own row
 * carrying its duration. OFF ⇒ the trace is byte-identical to today.
 *
 * Shared web+desktop surface: `SessionTrace` mounts on both — the agents Session
 * detail transcript panel and the branch merged trace — so the gate lives on
 * both and the packaged desktop renderer resolves the byte-equal key from the
 * signed-in account's PostHog assignment (default OFF).
 */
export const SESSION_TRACE_IDLE_ROWS_FEATURE_FLAG_KEY =
  SESSION_TRACE_IDLE_ROWS_FLAG_KEY;
/**
 * ISS-7516 (ISS-4779 closed-by-default): gates the session-detail transcript
 * panel's NEVER-EXPECTED absence state — "this machine's data sync level keeps
 * transcripts local, so this one is never coming" — as distinct from the
 * not-yet-arrived "It'll show up here once the source machine uploads it".
 * OFF ⇒ the panel is byte-identical to today.
 *
 * Shared web+desktop surface: `SessionTranscriptPanel` mounts on both, so the
 * gate lives on both and the packaged desktop renderer resolves the byte-equal
 * key from the signed-in account's PostHog assignment (default OFF).
 *
 * ISS-7516 wire half: this key now gates something observable on the WEB too.
 * The evidence used to be desktop-only, because the data-sync level was a
 * device-local setting the cloud had no representation of; the recording
 * machine's level now rides `AgentSessionDetail.dataSyncLevel`, so `apps/app`
 * derives the panel's verdict from the response
 * (`resolveTranscriptNeverExpected`) instead of leaving the prop absent. One
 * key, one flag, two surfaces — which is why it was registered here before it
 * had anything to gate.
 */
export const SESSION_TRANSCRIPT_NEVER_EXPECTED_FEATURE_FLAG_KEY =
  SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY;

/**
 * ISS-7427 AC5 + AC4 (ISS-4779 closed-by-default policy): the session detail's
 * evidence-coverage disclosures.
 *
 * ON ⇒ when the served `evidenceCoverage` is `metadataOnly`, the caption line
 * under the timeline strip says the bars are drawn from synced activity alone,
 * so the tiling no longer reads as complete coverage of the session (AC5); and
 * the Properties panel's Cost, Tokens and Duration rows each state where their
 * figure came from (AC4). Every one of them claims only its own value's
 * PROVENANCE and nothing about which archives survive — `metadataOnly` means the
 * MAIN transcript is terminally absent, and such a session can still carry
 * readable subagent archives or a desktop-local copy. OFF ⇒ every one of those
 * surfaces is byte-identical to today.
 *
 * ONE KEY FOR BOTH, deliberately. AC4's rows and AC5's caption disclose the same
 * fact about the same response on the same screen; splitting them would let an
 * operator enable the strip's caption while the three numbers beside it stayed
 * bare, which is the ISS-6462 shape — one screen contradicting itself about one
 * response. Still SEPARATE from
 * `SESSION_TRACE_EVIDENCE_DISCLOSURE_FEATURE_FLAG_KEY`, which qualifies a COUNT
 * in the trace heading and shipped on its own gate in #5686.
 *
 * Shared web+desktop surface: the timeline and `SessionPropertiesPanel` both
 * mount on both surfaces through `AgentSessionDetailView`, so the packaged
 * desktop renderer resolves the byte-equal key from the signed-in account's
 * PostHog assignment
 * (`DESKTOP_SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY`, default
 * OFF).
 */
export const SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY =
  SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY;

/**
 * ISS-6384 (ISS-4779 closed-by-default policy): gates ADOPTION of the shared
 * artifact cell primitives by the four production surfaces that were each
 * hand-rolling the same data types — the Agents catalog's private `NumberCell`,
 * the Branches linked-sessions count, the agent-detail Sessions tab's bare
 * version `<span>`, and the documents grid's duplicated due-date branches.
 *
 * ONE key for all four, deliberately: gating them apart would ship a build
 * where one table's count is the shared cell and the next table's count beside
 * it is still its own private copy, which is the drift the primitives exist to
 * remove. See the `@repo/api` leaf constant for the per-surface list of what
 * changes on screen — notably that a `0` on the Agents catalog becomes the
 * shared em-dash named "No invocations", the rule ISS-6384 took from Branches.
 *
 * Shared web+desktop surface: every one of the four mounts on the web app AND
 * the desktop renderer, so the web app resolves this via PostHog and the
 * packaged desktop renderer resolves the byte-for-byte-equal key from the
 * signed-in account's PostHog assignment
 * (`DESKTOP_ARTIFACT_CELL_PRIMITIVES_FEATURE_FLAG_KEY`, default OFF).
 * Both alias the one {@link ARTIFACT_CELL_PRIMITIVES_FLAG_KEY} constant, so a
 * rename touches a single definition and cannot split the two surfaces.
 */
export const ARTIFACT_CELL_PRIMITIVES_FEATURE_FLAG_KEY =
  ARTIFACT_CELL_PRIMITIVES_FLAG_KEY;

/**
 * ISS-8972 (ISS-4779 closed-by-default policy): the Branches list's Linked
 * Sessions column rendering one chip per linked Session instead of a count.
 * Aliases the shared `@repo/api` leaf so the web PostHog gate and the desktop
 * renderer's read of the same assignment cannot drift; the leaf's docstring
 * carries the contract and what a local-only desktop row does.
 */
export const BRANCHES_LINKED_SESSION_CHIPS_FEATURE_FLAG_KEY =
  BRANCHES_LINKED_SESSION_CHIPS_FLAG_KEY;

/**
 * ISS-7235 (ISS-4779 closed-by-default policy): gates the read-only Related
 * Sessions field on non-Session artifact detail surfaces.
 *
 * Web-only, and that now takes an explicit mount decision rather than a happy
 * accident. The field has two mount sites: `DocumentEditorDetails` (the shared
 * stack below every PRD / Plan / Feature-Issue / Doc editor, which the desktop
 * route table never composes) and — since ISS-7235 AC1 — Branch detail, which
 * desktop DOES render via `branch-detail-view.tsx`.
 *
 * Branch is therefore injected as a node from the web route into
 * `BranchDetailPage`'s `relatedSessionsSlot`, never mounted inside that shared
 * component. Desktop passes no such node, so it composes no subtree that reads
 * this key. That is what keeps "web-only" TRUE of a cross-surface page, and it
 * is why no separate desktop gate is needed: the renderer resolves every key
 * from the signed-in account's PostHog assignment, and an unknown key settles
 * CLOSED in every build, so a web-only key cannot leak there. Mount
 * desktop-visible UI on this key and it stops being web-only — the SAME
 * PostHog key then gates both surfaces.
 *
 * That mechanism keeps the CODE honest; it does not make the resulting product
 * asymmetry acceptable, and the two must not be confused. Branch detail is a
 * both-shell surface, unlike `DocumentEditorDetails`, so enabling this key
 * gives web readers a section desktop readers of the same branch can never see
 * and have no toggle to ask for. ISS-7807 owns the desktop half (mount point,
 * Labs registration, and the desktop tests that currently pin the absence);
 * until it lands, do not enable this key for BRANCH detail. Enabling it for the
 * document surfaces is unaffected — desktop composes no document detail stack
 * at all, which is the case L78 of `packages/app/AGENTS.md` is describing when
 * it says to gate only the platforms that actually mount the surface.
 *
 * Declared inline, like every other web-only key here, rather than imported
 * from `packages/api`. That package is for values BOTH apps consume; a rollout
 * key the API never reads does not qualify, and being web-only is exactly why
 * it never will.
 */
export const RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY =
  "related-sessions-field" as const;

/**
 * ISS-7514 (ISS-4779 closed-by-default policy): gates deferring the org
 * dashboard's Recent Sessions read until the three insights sections behind the
 * KPI and chart rows have settled, so `GET /agent-sessions` stops competing
 * with `/insights/*` for API and database capacity during the slowest moment of
 * first paint.
 *
 * Perceivable, which is why it is gated: with the flag ON the card holds its
 * "Loading sessions…" state for longer before the table arrives. It never shows
 * an empty table for a read that has not run — `InsightsOverviewDashboard`
 * feeds the card a settled-or-not signal rather than `isLoading`, which
 * TanStack reports as `false` for a query it has not been allowed to start.
 * OFF ⇒ the read is issued on mount exactly as today.
 *
 * Web-only. `InsightsOverviewDashboard` mounts on the `apps/app` dashboard
 * route alone; the desktop renderer composes its own `first-launch-dashboard`,
 * whose sessions read is a local SQLite call over IPC that additionally gates
 * the first-launch reveal. There is no desktop surface for this to leak on, so
 * there is no companion desktop gate; adding one would register a switch that
 * controls nothing.
 *
 * Declared inline, like every other web-only key here, rather than imported
 * from `packages/api` — that package is for values BOTH apps consume.
 */
export const DASHBOARD_DEFERRED_FIRST_PAINT_READS_FEATURE_FLAG_KEY =
  "dashboard-deferred-first-paint-reads" as const;

/**
 * ISS-5532 (ISS-4779 closed-by-default policy): gates the Agents catalog's
 * narrow-surface card NAMING the attributes it promotes into its header.
 *
 * The card has no column header row, so a promoted value arrives with nothing
 * saying what it is: the card opened `Tool —`, a type word and a dash. ON, Type
 * and the LOC/$ metric are `dt`/`dd` pairs carrying their own column's label,
 * so the pairing is announced to assistive tech rather than implied by
 * proximity. OFF (default) the header renders exactly as it ships today.
 *
 * Shared web+desktop surface: `AgentsTable` (via `AgentsGroupedList`) is the
 * default layout for the web `/[orgSlug]/agents` route AND the packaged desktop
 * Agents view, so the web app resolves this via PostHog and the desktop
 * renderer resolves the byte-for-byte-equal key from the signed-in account's
 * PostHog assignment (`DESKTOP_AGENTS_CARD_ATTRIBUTE_LABELS_FEATURE_FLAG_KEY`,
 * default OFF). Both
 * alias the one `@repo/api` {@link AGENTS_CARD_ATTRIBUTE_LABELS_FLAG_KEY}
 * constant, so a rename touches a single definition and cannot split the two
 * surfaces.
 */
export const AGENTS_CARD_ATTRIBUTE_LABELS_FEATURE_FLAG_KEY =
  AGENTS_CARD_ATTRIBUTE_LABELS_FLAG_KEY;

/**
 * ISS-5041 / ISS-7835 (ISS-4779 closed-by-default policy): gates the Agents
 * DESTINATION on web — the sidebar entry, the ⌘K palette command, the mobile
 * bottom-nav slot, and the `/[orgSlug]/agents` index and detail routes. OFF by
 * default, so the destination is absent and deep-linking it lands on the
 * in-shell "Page not found" recovery state rather than opening the surface.
 *
 * Two tickets converge on this one key. ISS-5041 asked for the gate itself.
 * ISS-7835 is why it must be a CLIENT-evaluated PostHog flag specifically: dev
 * mode OFF renders the customer view by suppressing client flag reads
 * (`suppressesFeatureFlag`), and Agents previously carried no flag at all, so
 * there was nothing for that suppression to act on and a staff viewer asking
 * for the customer view still saw Agents. A server-side entitlement would gate
 * the destination but stay invisible to dev mode, leaving that bug intact.
 *
 * Per-CUSTOMER access is this flag's PostHog rollout, not a second gate: the
 * org(s) already using Agents must be targeted in the rollout so re-gating does
 * not withdraw a live feature from them.
 *
 * Shared web+desktop surface: the desktop renderer resolves the byte-for-byte
 * identical key from the signed-in account's PostHog assignment
 * (`DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY`, default OFF, nested inside the
 * `labsNav` container gate). Both alias the one `@repo/api`
 * {@link AGENTS_NAV_FLAG_KEY} constant, so Agents cannot leak on one surface
 * while hidden on the other.
 */
export const AGENTS_NAV_FEATURE_FLAG_KEY = AGENTS_NAV_FLAG_KEY;

/**
 * ISS-7737 (ISS-4779 closed-by-default policy): gates the session-detail
 * Properties rows naming the population each figure counts.
 *
 * Turns and Tokens/Cost sit on one panel and count different populations —
 * `agent_turns` is the parent transcript alone, the token and cost rollup folds
 * in every delegated subagent transcript. Nothing in the product divides one by
 * the other, but two investigators did it by hand off this panel and both
 * reported the resulting per-turn figure as physically impossible. ON ⇒ Turns,
 * Tokens, and Cost each carry one sentence saying what they count. OFF ⇒ the
 * panel is byte-identical to today. No figure is removed and no row moves under
 * either state (Marisol Ashgrove, 2026-08-23, recorded on the ticket).
 *
 * Shared web+desktop surface: `SessionPropertiesPanel` mounts on both, so the
 * packaged desktop renderer resolves the byte-equal key from the signed-in
 * account's PostHog assignment
 * (`DESKTOP_SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY`, default
 * OFF).
 */
export const SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY =
  SESSION_METRIC_POPULATION_DISCLOSURE_FLAG_KEY;

/**
 * FEA-4203 (ISS-4779 closed-by-default policy): gates the Sessions list's
 * active-row refetch — a 30s re-read of the list AND its summary that runs ONLY
 * while the page on screen holds a row displaying Active, so a running session's
 * server-owned fields keep up with the pulse and the elapsed-time ticker that
 * already mark it. A row that has been silent past the 24h staleness cutoff
 * reads Stale and stops holding it open, so a wedged `active` row costs at most
 * a day of polling rather than an unbounded one. OFF
 * ⇒ the list fetches exactly when it does today (mount, filter/page/sort
 * change, window focus) and no timer is scheduled at all.
 *
 * WEB-ONLY, which is why the key is declared here rather than in a shared
 * `@repo/api` module.
 *
 * In the desktop renderer's LOCAL mode this gate would be actively harmful, and
 * that is what settled the scope. `createQueryClientForMode` calls
 * `applyDesktopSessionsListPollDefaults` on the local client, which sets a
 * self-healing background poll on the `pageData` key prefix (its
 * `refetchIntervalInBackground: true` is load-bearing for a permanently-hidden
 * renderer), and the local live bridge invalidates that prefix on every local DB
 * write. Wiring this gate there OVERRIDES the first — per-observer options beat
 * `setQueryDefaults`, so even a flag-OFF build replaces the heal poll with
 * nothing — while duplicating the second on a coarser cadence (PR review:
 * design-system-steward and synchronizing-susan, independently).
 *
 * Desktop CLOUD mode is a different story and is NOT covered by either of those:
 * `createQueryClientForMode` returns before the poll defaults are applied, and
 * `CloudSessionsSyncBridge` fires only on movement in THIS machine's upload
 * lane, so a session advanced on another device is not seen until focus, a
 * filter change, or Refresh (whitlockk, PR review). That gap predates this change —
 * desktop is byte-identical to `main` here — and closing it is a desktop product
 * decision with its own gate, not a rider on this flag; the renderer
 * already names the intended fix ("SSE change-stream is the flagged v1
 * follow-up"). Tracked separately in ISS-7893.
 */
export const SESSIONS_ACTIVE_ROW_REFETCH_FEATURE_FLAG_KEY =
  "sessions-active-row-refetch" as const;

/**
 * Default-off flag for the per-org Pensero credential card (ISS-8007), which
 * ISS-10316 moved onto the Settings v2 API Keys panel. That panel renders on
 * web AND desktop, and the desktop renderer resolves this same PostHog key, so
 * one key gates both.
 */
export const PENSERO_INTEGRATION_FEATURE_FLAG_KEY =
  PENSERO_INTEGRATION_FLAG_KEY;

/**
 * Default-off flag for the team-identifiers field INSIDE the Pensero card
 * (ISS-8761). A separate key from the card's own gate because that gate is
 * already on for the credential rollout, so folding this field under it would
 * ship a new control, on, to everyone already in that rollout. It reaches the
 * same two surfaces as its sibling.
 */
export const PENSERO_TEAM_IDENTIFIERS_FEATURE_FLAG_KEY =
  PENSERO_TEAM_IDENTIFIERS_FLAG_KEY;

/**
 * Default-off flag for the create-a-tag-then-pick-its-colour step in
 * `TagPicker` (ISS-6385). Shared web+desktop surface: `TagPicker` mounts in the
 * desktop renderer through `BranchesView` -> `BranchesListSurfaceV2` ->
 * `ApprovedBranchesTable`, so the desktop half resolves that same
 * key (`DESKTOP_TAG_CREATE_COLOR_FEATURE_FLAG_KEY`) and both alias the one
 * `@repo/api` constant.
 */
export const TAG_CREATE_COLOR_FEATURE_FLAG_KEY = TAG_CREATE_COLOR_FLAG_KEY;

/**
 * Default-off flag for the per-record "Clear" control on the SINGLE-SELECT
 * custom-field grid cells — ENUM and REFERENCE (ISS-8713).
 *
 * OFF ⇒ those two cells behave exactly as they do today: `CustomFieldType.Enum`
 * renders a `DropdownMenuRadioGroup` with no "none" member and a radio group
 * cannot be un-picked by re-picking, while `CustomFieldType.Reference` commits
 * the chosen target and closes. So a value set on ONE session in the grid was
 * permanent, and the only escape was deleting the field DEFINITION for the whole
 * organization. Their multi-select siblings (MULTI_ENUM, REFERENCE_MULTI,
 * PEOPLE) were never stuck — each entry toggles off individually — and the
 * detail-panel `EnumFieldEditor` has carried a "None" option all along, which is
 * the behavior this key brings to the grid.
 *
 * CLEARING WRITES NO VALUE, IT DOES NOT WRITE AN EMPTY ONE. The affordance sends
 * `null`, so the route deletes the row and the record returns to "no value set"
 * — byte-identical to a record the field was never set on. A third persisted
 * state ("explicitly cleared") would have to be taught to every reader (the
 * values query, the grid render, the sort comparator, the option and range
 * facets), and any reader left behind would report a population it cannot
 * justify. Note this is NOT the wire value a multi-select writes when its last
 * entry is toggled off: that sends `[]`, which UPSERTS a row holding empty
 * arrays. Reconciling row-absent with row-present-but-empty is a separate
 * decision this key does not make.
 *
 * DECLARED HERE, NOT IN `@repo/api` (whitlockk review). The literal lives with its
 * web alias because the gated surface is web-only: the Sessions grid's
 * custom-field columns reach `CustomFieldTableCell` only through
 * `apps/app/components/agent-sessions/sessions-list-v2-host.tsx`, the desktop
 * renderer's `SessionsView` mounts no custom-field columns, and `@repo/app` is
 * the only package that consumes the key. `packages/api/src/types` is for
 * contracts BOTH the app and the API speak, where both surfaces alias the same
 * literal; an app-only key belongs in its owning package until a second
 * package actually needs it. Should a desktop custom-field surface ever appear,
 * promote the literal to `@repo/api` then and alias it from both sides.
 *
 * THE FLAG MUST EXIST IN POSTHOG BEFORE IT CAN BE ENABLED. Declaring this
 * constant creates nothing in PostHog. An unknown key resolves to `false`, the
 * safe direction for a closed-by-default gate, but enabling it requires creating
 * the flag in PostHog first.
 */
export const CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY =
  "custom-field-value-clear" as const;

/**
 * Default-off flag for the two custom-field editor contract corrections
 * deferred from PR #6074 (ISS-8215 canonical option colour ids, ISS-8214
 * self-reference exclusion). Shared web+desktop surface: `CustomFieldTableCell`
 * and `SessionsAddFieldDialog` live in `@repo/app`, so the desktop half
 * resolves that same key
 * (`DESKTOP_CUSTOM_FIELD_EDITOR_CONTRACTS_FEATURE_FLAG_KEY`) and both alias the
 * one `@repo/api` constant.
 */
export const CUSTOM_FIELD_EDITOR_CONTRACTS_FEATURE_FLAG_KEY =
  CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY;

/**
 * ISS-7210 / ISS-4779 closed-by-default UI policy: `NumberFormat.Duration`
 * already exists on the wire (the API accepts and normalizes it), so the gate
 * is here — offering the radio the moment the enum grew would let a user create
 * a DURATION field with no matching value editor yet.
 *
 * THREE surfaces read this ONE key, and they must be ungated together: the
 * "Duration" radio in `number-format-config.tsx`, the detail-panel
 * `DurationFieldEditor`, and — since ISS-8213 — the grid cell in
 * `custom-field-table-cell.tsx`, which before that read `Number(draft)` and so
 * refused "1h 12m" and stored a bare `90` as 90 milliseconds. Each reads the key
 * at its own swap site and branches there; none passes the boolean on.
 *
 * DECLARED HERE rather than beside the radio (ISS-8213). The grid cell is a
 * bundle-sensitive `"use client"` surface and `number-format-config.tsx`, its
 * previous home, pulls in react-hook-form — so importing one constant from it
 * would drag a form runtime into every Sessions grid render.
 *
 * Web-only gate: `NumberFormatConfig` mounts inside `CreateCustomFieldDialog` on
 * the `apps/app` org settings page, and the desktop renderer mounts no
 * custom-field columns, so there is no second surface to hold in parity. Should
 * one appear, the same key gates it — the desktop renderer resolves the
 * signed-in account's PostHog assignment from this same key space.
 */
export const CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY =
  "custom-field-duration-format" as const;

/**
 * Default-off flag for the document editor's loading region reserving the
 * content area's height instead of collapsing to its own padding (ISS-8514).
 *
 * Web-only by construction, so there is no desktop gate to keep in parity with:
 * `DocumentEditorScaffold` — the only mount site of the region this gates — is
 * imported solely by the four `apps/app` editors (`issue-editor`, `prd-editor`,
 * `plan-editor`, `document-editor`). The desktop renderer links OUT to the web
 * app for documents (`artifact-web-href.ts`) and mounts no editor of its own.
 */
export const DOCUMENT_EDITOR_STABLE_LOADING_REGION_FEATURE_FLAG_KEY =
  "document-editor-stable-loading-region" as const;

/**
 * ISS-8692 (ISS-4779 closed-by-default policy): gates the artifact table
 * drawing a failed session with the `failed` status icon — the danger-toned
 * bolt — instead of the document-phase `wont-do` mark, a neutral X that
 * is also what a closed pull request gets, so a run that crashed read as a
 * deliberate decision not to do the work.
 *
 * WHAT THIS DOES NOT CHANGE, because it was never broken HERE: the rendered
 * accessible name. `ArtifactNameCell` passes the row's own caption down as an
 * `aria-label`, and `StatusIcon` spreads caller props AFTER its default, so a
 * failed session's icon on this table already announced "Failed". The wrong
 * thing was the MARK. The `wont-do` member's own name is still "Won't do" —
 * that is what the mapping asserted and what any consumer that does not
 * override it would announce, which is the half `row-type-registry` fixes.
 *
 * OFF, the row renders exactly the mark it renders today. The session→icon
 * MAPPING is corrected unconditionally in `row-type-registry`; this key gates
 * only what the row draws, so the mapping has one answer and the rollout has
 * one switch.
 *
 * Web-only, so there is no desktop twin to hold byte-equal. The gated
 * surface is `DocumentsView`, imported by exactly three `apps/app` surfaces
 * (project detail, My Tasks, the documents index) and by no desktop route —
 * `apps/desktop/src/renderer/App.tsx` mounts no artifact table, and the desktop
 * renderer imports nothing from `@repo/app/documents/components/table`. A Labs
 * toggle here would gate nothing. Registering one is also refused by the
 * operator directive of 2026-08-30, which retires Labs toggles as the gate.
 */
export const FAILED_SESSION_STATUS_ICON_FEATURE_FLAG_KEY =
  "failed-session-status-icon" as const;

/**
 * ISS-8722 (ISS-4779 closed-by-default): gates `sessionsSavedViewValue` letting
 * an ABSENT `hiddenSummaryCardIds` stay absent instead of materializing it as an
 * empty set.
 *
 * Perceivable, which is why it is gated at all: absent defers to the host's own
 * hidden set, empty overrides it with "nothing hidden", so applying a view
 * written before the axis existed currently un-hides whatever the host hid. OFF
 * keeps that collapse.
 *
 * NOT web-only, and the reason there is no parity gap is not the one this
 * docblock used to give. The desktop renderer DOES mount `SessionsListSurfaceV2`
 * (`apps/desktop/src/renderer/components/sessions/sessions-v2-view.tsx:1,329`,
 * passing `hiddenSummaryCards` at `:339` — the very axis this key gates), so the
 * read in `useSessionsSavedViewApplyHandler` runs on both shells. A docblock here
 * once claimed desktop composed its own v1 toolbar and body instead; that stopped
 * being true when the v2 mount landed, and ISS-10301 deleted both.
 *
 * What is actually absent is the CONTROLLER, on BOTH shells equally — no
 * production host passes `savedViews` today (the only `savedViews=` in the tree
 * is `sessions-list-surface-v2.tsx:699` handing the prop down), so the apply
 * handler no-ops everywhere and the flag currently gates nothing on either
 * shell. That is a fact about the hosts, not about desktop.
 *
 * When a host does supply one, this ONE PostHog key is the gate of record for
 * both shells — the desktop renderer resolves it from the same key space — so
 * there is no second desktop key to invent and no Labs toggle to pair with it.
 */
export const SESSIONS_SAVED_VIEW_HIDDEN_CARDS_AXIS_FEATURE_FLAG_KEY =
  "sessions-saved-view-hidden-cards-axis" as const;

/**
 * ISS-8427 (ISS-4779 closed-by-default): the session-detail "Branches" row.
 *
 * ON ⇒ the Properties pane lists every branch the session touched, one pill per
 * branch, each addressing its own branch detail. OFF ⇒ the pane renders the
 * single-branch "Branch" row exactly as it does today, naming only the branch
 * the session was attributed to.
 *
 * Shared web+desktop surface: `SessionPropertiesPanel` mounts on both surfaces
 * through `AgentSessionDetailView`, so the packaged desktop renderer resolves
 * the byte-equal key from the signed-in account's PostHog assignment
 * (`DESKTOP_SESSION_TOUCHED_BRANCHES_FEATURE_FLAG_KEY`, default OFF).
 */
export const SESSION_TOUCHED_BRANCHES_FEATURE_FLAG_KEY =
  SESSION_TOUCHED_BRANCHES_FLAG_KEY;

/**
 * Default-off flag letting a `GridTableV2` column's declared alignment move the
 * VALUE and not only its header (ISS-9821).
 *
 * THE DEFECT IT OPENS THE FIX FOR. `TableNumberCell` right-aligns itself with
 * `ml-auto`, which eats the free space a data cell's `justify-end` would
 * otherwise distribute, so `column.align` was inert over the one node shape
 * every real host renders. A Number column declaring `align: Start` painted a
 * start-aligned header over a right-aligned figure.
 *
 * ON ⇒ each data cell publishes its column's alignment to the primitive inside,
 * which takes it as a DEFAULT (an explicit `alignEnd` on the cell still wins).
 * OFF ⇒ byte-identical to today.
 *
 * IT MOVES NOTHING AS SHIPPED, which is the audit ISS-9821 asked for rather
 * than an argument that the gate is unnecessary: no production column set
 * declares `align` at all, so every reachable `TableNumberCell` resolves to the
 * primitive's own trailing default with the flag either way. The gate is what
 * makes the FIRST column to declare `align: Start` a deliberate flip rather
 * than a silent re-alignment nobody reviewed.
 *
 * ONE COLUMN IT CANNOT REACH, recorded rather than left to be discovered. The
 * Sessions Cost column is right-aligned by a wrapper the HOST paints —
 * `renderSessionGridCell` wraps every numeric column in
 * `<span className="flex w-full justify-end">` (`sessions-list-surface-rows.tsx`)
 * — so opening this key would move that column's header and not its figure.
 * Inert today, because Cost declares no `align`; unwiring that wrapper is a
 * Sessions change with its own review, not this key's. Sessions custom-field
 * number cells DO answer the key: they bypass the wrapper.
 *
 * ONE KEY, BOTH SHELLS. `apps/desktop` resolves the signed-in account's PostHog
 * assignment from the same key space `apps/app` reads, and the desktop renderer
 * does mount this grid — `sessions-v2-view.tsx` renders `SessionsListSurfaceV2`,
 * which renders `GridTableV2`. There is no desktop Labs twin key and no desktop
 * flag-registry shadow entry; PostHog is the whole gate.
 *
 * THE FLAG MUST EXIST IN POSTHOG BEFORE IT CAN BE ENABLED. An unknown key
 * resolves to `false`, which is the safe direction for a closed-by-default gate.
 */
export const GRID_TABLE_V2_NUMBER_CELL_ALIGN_FEATURE_FLAG_KEY =
  "grid-table-v2-number-cell-align" as const;

/**
 * ISS-8694 (ISS-4779 closed-by-default): gates the artifact tables on Projects
 * and My Tasks rendering the DERIVED session display states — Stale and Unknown
 * — from the server's `displayedSessionStatus` instead of the raw stored
 * `status`.
 *
 * Perceivable, which is why it is gated: a silent run currently badges "In
 * progress" here while the Sessions list badges the same row "Stale". OFF keeps
 * the raw-status mapping byte-for-byte, including for a row whose response
 * carries the new field.
 *
 * Web-only by construction, so there is no desktop gate to keep in parity with:
 * the only consumers of the documents table are the `apps/app` Projects page and
 * My Tasks, and the desktop renderer imports nothing from
 * `@repo/app/documents/components/table` — it links OUT to the web app for
 * artifacts (`artifact-web-href.ts`). Desktop's Sessions surface already folds
 * through `resolveDisplayedSessionStatus` and is unchanged by this key.
 */
export const ARTIFACT_TABLE_DISPLAYED_SESSION_STATUS_FEATURE_FLAG_KEY =
  "artifact-table-displayed-session-status" as const;

/**
 * ISS-4704 (ISS-4779 closed-by-default): gates section-aware paging on a
 * GROUPED `DocumentsView` list — the My Tasks board and the project detail
 * page's artifact tabs.
 *
 * Perceivable, which is why it is gated. ON, a page boundary falls BETWEEN
 * status/assignee/priority sections instead of through one, so a section is no
 * longer split under a header repeated on two consecutive pages, and each
 * header's count is that section's size over the whole list rather than over
 * the page. Only a section larger than one page still splits, and its
 * continuation pages say so. Page row-counts become variable as a result — the
 * cost of keeping a section whole. OFF keeps the ISS-4466 fixed-`pageSize`
 * slice and the page-local header count, byte for byte.
 *
 * Web-only, so there is no desktop twin to keep in parity: `DocumentsView` is
 * imported only by `apps/app` surfaces, and `/my-tasks` redirects to Sessions
 * in the desktop route table
 * (`apps/desktop/src/renderer/navigation/route-table.ts`).
 */
export const GROUPED_SECTION_PAGING_FEATURE_FLAG_KEY =
  "grouped-section-paging" as const;

/**
 * Whether the artifact-tags capability exists in the product at all.
 *
 * NOT a rollout flag for any one surface: it gates the Tags tab in legacy
 * Settings, the tags cell and filter on the documents table, and the project
 * page's tag affordances. The Settings v2 Tags panel reads it for that reason —
 * registering that panel without consulting this key would resurrect, for every
 * organization, a capability an operator has switched off.
 *
 * The key predates this constant and is still written as a bare literal at its
 * older call sites (`posthog-flag-registration-scan.ts` names that shape and
 * resolves it either way). New readers import this; the sweep of the existing
 * literals is deliberately not part of ISS-8367.
 */
export const ARTIFACT_TAGS_FEATURE_FLAG_KEY = "artifact-tags" as const;

/**
 * ISS-9094 (ISS-4779 closed-by-default policy): the establishing key for the
 * `batch-706-champion-ui` set, gating the artifact priority surfaces onto one
 * semantic order.
 *
 * OFF (default) every priority menu keeps today's lowest-first reading order,
 * the My Tasks board keeps printing the raw enum, and no priority bulk action
 * is offered. ON, option lists follow the same urgent-first rank that sorting
 * and grouping already use, the board shows a label, and priority joins the
 * documents bulk actions.
 *
 * Declared here rather than in `@repo/api` because no `apps/desktop` renderer
 * module reaches any of these three surfaces: desktop's `route-table.ts` marks
 * Documents, Issues, MyIssues and MyTasks as `null`, so it has no documents,
 * my-tasks or project-detail surface to gate. Promote the literal if a desktop
 * surface ever mounts one.
 *
 * THE FLAG MUST EXIST IN POSTHOG BEFORE IT CAN BE ENABLED. Declaring this
 * constant creates nothing there; an unknown key resolves to `false`, which is
 * the safe direction for a closed-by-default gate.
 */
export const ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY =
  "artifact-priority-surfaces" as const;

/**
 * ISS-9622 (ISS-4779 closed-by-default policy): gates the agent-detail token
 * trend disclosing the slice of history it actually drew.
 *
 * OFF (default) the chart renders exactly as it does today. ON it prints the
 * window the producer applied — and, when the read hit its raw-row ceiling, that
 * only the most recent sessions inside that window are plotted — from the
 * `appliedWindow` / `truncated` fields ISS-6887 added to the wire and which no
 * client has ever read.
 *
 * WEB-ONLY BY CONSTRUCTION, not by omission. `TokenTrendChart` mounts at exactly
 * one site, `apps/app/.../agents/[slug]/agent-detail-with-promote.tsx`; the
 * desktop renderer draws its own `optimization-analytics-panel`, which already
 * captions its window as `({windowDays}d)` and is untouched here. Per the
 * closed-by-default policy, cross-surface parity is required only when the
 * surface exists on both platforms, and this one does not.
 */
export const TOKEN_TREND_WINDOW_DISCLOSURE_FEATURE_FLAG_KEY =
  "token-trend-window-disclosure" as const;

/**
 * PRD-730 `batch-fs-agent-ops`: gates the agent-operations routes mounting their
 * named COMPLETE surface instead of the host-composed workspace that ships
 * today (ISS-9398 establishes it for `AgentsListSurfaceV2`).
 *
 * One key for the batch, and one key for BOTH shells — the rationale and the
 * Labs-deprecation history live at the canonical
 * {@link AGENT_OPS_COMPLETE_SURFACE_FLAG_KEY}, which this only aliases so a
 * rename touches a single definition.
 */
export const AGENT_OPS_COMPLETE_SURFACE_FEATURE_FLAG_KEY =
  AGENT_OPS_COMPLETE_SURFACE_FLAG_KEY;

/**
 * ISS-9692 (ISS-4779 closed-by-default policy): gates the two large rungs of the
 * rows-per-page ladder — 250 and 500 — on every list surface that renders the
 * shared `TablePageSizeSelect`.
 *
 * OFF (default) the control offers 25 / 50 / 100, exactly what shipped. ON it
 * offers 25 / 50 / 100 / 250 / 500, and a page size the reader has already
 * chosen is restored on the next visit. A value persisted while the flag was on
 * degrades to the nearest still-legal rung when it goes back off, so turning the
 * flag off never leaves a surface requesting a size it can no longer offer.
 *
 * ONE key for every surface: the ladder is a single control, and per-surface
 * keys would let Sessions offer 500 while Branches did not. The server caps that
 * back it are raised unconditionally — see `table-page-size-ladder-flag.ts` for
 * why a cap is not the perceivable half of this change, and for why the desktop
 * registers no Labs alias.
 */
export const TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY =
  TABLE_PAGE_SIZE_LADDER_FLAG_KEY;

/**
 * ISS-9723 (ISS-4779 closed-by-default policy): gates the Branch combined
 * trace's PARTIAL Sessions.
 *
 * ON ⇒ a Session carrying an item the merged-trace contract cannot parse keeps
 * every item that did parse, and the trace heading states how many were dropped.
 * OFF ⇒ that Session is withheld whole and named in the unavailable-Sessions
 * notice, as it was before this change — bar a synthesized `idle` marker sized
 * over the withheld Session, which is dropped rather than restated.
 *
 * ONE key for the drop and its disclosure — see
 * `branch-trace-partial-session-flag.ts` for why they must not be separately
 * switchable, and for why the gate reverses a partial trace on the client rather
 * than gating the two producers that cannot read a common flag.
 *
 * Shared web+desktop surface: `BranchSessionsTimelineTab` mounts on both through
 * the shared `BranchDetailPage`, and the packaged desktop renderer resolves its
 * PostHog assignment by this same key. No desktop Labs alias is registered —
 * that registry is retired, and the desktop flag provider reads the PostHog
 * assignment alone.
 */
export const BRANCH_TRACE_PARTIAL_SESSION_FEATURE_FLAG_KEY =
  BRANCH_TRACE_PARTIAL_SESSION_FLAG_KEY;

/**
 * ISS-9726 (ISS-4779 closed-by-default policy): gates ORGANIZATION-NAMESPACED
 * persisted table view state. Default OFF.
 *
 * Which localStorage key a table's persisted view state — search text, sort,
 * scroll offset, filters, column visibility, column order, group expansion — is
 * read from and written to. OFF, every surface addresses the same global key it
 * always has (`table:search:my-tasks`), so a reader who switches from
 * organization A to organization B is handed A's view of B's data: a restored
 * search term silently narrows the new organization's list, and a restored
 * filter names A's members and tags by UUID. ON, each key carries the signed-in
 * identity, so two organizations keep separate views of the same surface.
 *
 * ONE key for every surface. The namespace is a convention, not a feature:
 * Documents, My Tasks, and the project/team tables all persist through the same
 * three hooks, and a per-surface key would let My Tasks be namespaced while the
 * documents index still leaked — the second convention this ticket exists to
 * avoid.
 *
 * Gating it at all is load-bearing. Changing a storage key is perceivable. For
 * the older search/filter view-state hooks, the namespaced path still never
 * reads, writes, or deletes the legacy key, so turning the flag back OFF
 * restores exactly the view the reader had. Persisted table views are the one
 * exception (ISS-10091): when this flag is ON they read the org-scoped key
 * first, then the prior per-user and legacy keys as migration fallbacks, and
 * re-save only under the org-scoped key. Nothing is migrated INTO an
 * organization it cannot be attributed to, and nothing is destroyed.
 *
 * SHARED WEB+DESKTOP key. Both shells mount the `packages/app` hooks that read
 * it, and the desktop renderer resolves the signed-in account's PostHog
 * assignment from the same key space as web. There is no Labs registration and
 * no desktop twin. The literal stays here rather than in an
 * `@repo/api/src/types/*-flag` module because `apps/api` does not read it.
 */
export const ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY =
  "org-scoped-table-view-state" as const;

/**
 * ISS-9437 (ISS-4779 closed-by-default policy): gates root-first artifact-status
 * ordering on every status sort and status grouping — the Documents table on all
 * four of its render sites and the Branches list on both its server page and its
 * client comparator. Default OFF, and an unresolved assignment is also OFF.
 *
 * A RE-EXPORT of the literal in `@repo/api/src/types/artifact-status-root-order-flag`
 * because `apps/api` reads the
 * same key through its ISS-7778 server registry and the desktop main process reads it
 * from the assignment it already fetches. Three readers, one literal — never a second
 * spelling.
 */
export const ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY =
  ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY;

/**
 * ISS-5529 (ISS-4779 closed-by-default policy): gates the Agents component-detail
 * Branches tab telling the truth about a branch set it never measured.
 *
 * The tab reads two arms — an attributed `branchName`, or "No branches reference
 * this component yet." — so a payload that simply carries no branch attribution
 * lands on the denial. It is the same conflation ISS-5363 removed from the
 * Sessions tab and the token-trend chart, missed here because this signal rides a
 * nested field rather than the top-level count that pass was hunting. ON, the tab
 * routes through the shared `resolveUsageSignal` and keeps the unmeasured case
 * apart from the measured zero; OFF (default) it renders exactly as shipped.
 *
 * ONE key for both shells. `AgentDetail` mounts on the web app AND the packaged
 * desktop renderer, and the renderer resolves the signed-in account's PostHog
 * assignment from this same key space — the ISS-8024 local-registry cutover is
 * retired, so there is no Labs toggle to pair with this and no desktop registry
 * shadow entry to add.
 *
 * Aliases the canonical {@link AGENTS_BRANCH_USAGE_SIGNAL_STATES_FLAG_KEY}, the
 * same shape every sibling `agents-*` gate here takes. The literal used to be
 * declared inline, on the reasoning that `packages/app` was its only consumer —
 * which the cross-shell E2E regressions falsified: the Electron spec cannot
 * import THIS module (its extension-less `@repo/api` specifiers abort the
 * desktop-e2e suite at load), so the key had to live somewhere both shells can
 * reach. That canonical module carries the rest of the rationale.
 */
export const AGENTS_BRANCH_USAGE_SIGNAL_STATES_FEATURE_FLAG_KEY =
  AGENTS_BRANCH_USAGE_SIGNAL_STATES_FLAG_KEY;

/**
 * ISS-9857 (ISS-4779 closed-by-default policy): the session transcript panel's
 * "Load more events" control, which walks past the detail read's 10,000-event
 * prefix through the paged events read (`GET /agent-sessions/[id]/events` on
 * the cloud, the IPC twin on the desktop). One key, one flag, two surfaces —
 * read once, in `agents/hooks/use-transcript-load-more.ts`.
 */
export const SESSION_TRANSCRIPT_LOAD_MORE_EVENTS_FEATURE_FLAG_KEY =
  SESSION_TRANSCRIPT_LOAD_MORE_EVENTS_FLAG_KEY;

/**
 * ISS-9450 (ISS-4779 closed-by-default policy): gates server-backed persistence
 * for the grid view state — column order, width, visibility and the rest of the
 * saved-view blob — on top of the `localStorage` record that ships today.
 *
 * OPEN: the surface reads `GET /settings/grid-preferences` on mount, adopts the
 * account's stored layout, imports the local one when the server holds none
 * (idempotently — see `planGridPreferenceAdoption`), and writes every later
 * change back through `POST /settings/grid-preferences`, debounced, rolling the
 * view back visibly when the server rejects or the write fails. CLOSED
 * (default), and while the assignment is unresolved, the surface behaves exactly
 * as it shipped: `localStorage` only, no request, nothing imported.
 *
 * ONE key for both shells. The Sessions, Branches and Agents grids mount on the
 * web app AND the packaged desktop renderer through `@repo/app`, and the
 * renderer resolves the signed-in account's PostHog assignment from this same
 * key space — the ISS-8024 local-registry cutover is retired, so there is no
 * Labs toggle to pair with this and no desktop registry shadow entry to add.
 *
 * Declared inline rather than aliased from `@repo/api/src/types/*-flag` because
 * `packages/app` is its only reader: `apps/api` gates nothing on it (the route
 * ISS-9448 shipped is always live and always authorizes for itself) and the
 * desktop MAIN process never sees it.
 */
export const GRID_PREFERENCE_SERVER_PERSISTENCE_FEATURE_FLAG_KEY =
  "grid-preferences-server-persistence" as const;

/**
 * ISS-10004 (ISS-4779 closed-by-default policy): gates the Diagnostics route's
 * move to `DiagnosticsSurfaceV2`. Default OFF; an unresolved assignment is OFF.
 *
 * Every consumer reads it ITSELF rather than taking the boolean threaded from
 * another (`no-threaded-feature-flag`). On desktop that is the mount site,
 * `apps/desktop/src/renderer/components/diagnostics/diagnostics-view.tsx`,
 * which picks between two siblings that do not know the flag exists. Web has no
 * such sibling: its readers are the route gate, the shell navigation and the
 * workspace-menu adapter, and OFF there is a 404 rather than a fallback body.
 *
 * A RE-EXPORT of {@link DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY} so a rename
 * touches one definition and the desktop E2E can import the literal from a
 * module Playwright's loader resolves. No desktop Labs toggle accompanies it.
 */
export const DIAGNOSTICS_COMPLETE_SURFACE_FEATURE_FLAG_KEY =
  DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY;

/**
 * ISS-5010 (ISS-4779 closed-by-default policy): gates the actor-led inbox
 * notification rows — the assigning or mentioning person's avatar and name,
 * with the row's headline leading on them instead of the identical "You were
 * assigned to artifact" preamble every assignment row otherwise shares.
 *
 * Moved here from `apps/app/lib/inbox-notification-flags.ts` by ISS-9406, with
 * the literal unchanged because it is a live PostHog key: the actor treatment is
 * presentation the Inbox surface owns, and a surface in this package cannot
 * reach an app's path alias. It is resolved ONCE, inside `InboxSurfaceV2`, which
 * is the module that swaps on it — a host reading it and threading the boolean
 * in is how two shells come to disagree about the same row.
 */
export const INBOX_NOTIFICATION_ACTOR_FEATURE_FLAG_KEY =
  "inbox-notification-actor" as const;

/**
 * ISS-9406 (ISS-4779 closed-by-default policy): gates the `InboxSurfaceV2` mount
 * on the Inbox route. Default OFF; an unresolved assignment is also OFF.
 *
 * ONE key, read once per host at its mount site, choosing between the complete
 * surface and the app-local composition it replaces. Neither branch knows the
 * gate exists.
 *
 * Declared as a literal HERE rather than in a `@repo/api/src/types/*-flag`
 * module — the same reasoning as {@link ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY}
 * above. `DESKTOP_SHELL_ROUTE_NAV_IDS` maps Inbox to `null` and `apps/desktop`
 * ships no notification transport, so `apps/app` is the only host that reads
 * this and there is no second process that must spell the key. When PRD-702
 * lands desktop notification delivery, the desktop renderer resolves this same
 * key from the same PostHog key space — it is not a web-only gate, only a
 * currently web-only mount.
 */
export const INBOX_COMPLETE_SURFACE_FEATURE_FLAG_KEY =
  "inbox-complete-surface" as const;

/**
 * ISS-10005: gates the Help route's move to `HelpSurfaceV2`. Default OFF; an
 * unresolved assignment is OFF. Read ONCE per shell, at the mount site
 * (`apps/desktop/src/renderer/components/help/help-view.tsx`). A RE-EXPORT
 * because every shell reads flag keys from this registry; the desktop E2E is the
 * exception and imports the `@repo/api` literal directly, since Playwright's
 * loader cannot resolve this module. No desktop Labs toggle accompanies it.
 */
export const HELP_COMPLETE_SURFACE_FEATURE_FLAG_KEY =
  HELP_COMPLETE_SURFACE_FLAG_KEY;

/**
 * PRD-730 `batch-fs-detail-context`: gates the Web `/search` route and the
 * Desktop command palette mounting their named COMPLETE surface,
 * `SearchSurfaceV2`, instead of the two parallel result components that ship
 * today (ISS-9414 establishes it).
 *
 * One key for BOTH shells — the rationale, and why a page and a palette share
 * one gate rather than one each, lives at the canonical
 * {@link PORTABLE_SEARCH_SURFACE_FLAG_KEY}, which this only aliases so a rename
 * touches a single definition.
 */
export const PORTABLE_SEARCH_SURFACE_FEATURE_FLAG_KEY =
  PORTABLE_SEARCH_SURFACE_FLAG_KEY;

/**
 * ISS-10476: gates the team Projects route mounting the portable `ProjectList`
 * surface promoted out of the Web Master prototype, instead of today's
 * `DocumentRow`-based table.
 *
 * The rationale, and why one key covers every shell that grows this screen,
 * lives at the canonical {@link PROJECTS_PORTABLE_SURFACE_FLAG_KEY}, which this
 * only aliases so a rename touches a single definition.
 */
export const PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY =
  PROJECTS_PORTABLE_SURFACE_FLAG_KEY;

/**
 * ISS-9619 (ISS-4779 closed-by-default policy): gates the `Local | UTC`
 * day-boundary control on the Sessions and Branches filter bars.
 *
 * Off, neither filter bar renders the control and every window stays the UTC
 * calendar day it is today — the mode itself defaults to UTC, so the gate being
 * shut and the feature being unused are the same state rather than two.
 *
 * Shared web+desktop surface gated by ONE key: the web app resolves it through
 * PostHog and the packaged desktop renderer resolves the byte-for-byte-equal key
 * from the signed-in account's PostHog assignment. Per the 2026-08-30 operator
 * directive there is no desktop Labs alias for it and no desktop registry entry.
 */
export const SESSIONS_BRANCHES_TIMEZONE_MODE_FEATURE_FLAG_KEY =
  SESSIONS_BRANCHES_TIMEZONE_MODE_FLAG_KEY;

/**
 * ISS-6925 (ISS-4779 closed-by-default policy): gates pack-detail selection
 * becoming ADDRESSABLE — the `/packs/{id}` route, the detail view reached by a
 * direct load or a reload, and the back-to-grid affordance rendering as a real
 * link rather than a state reset.
 *
 * ONE key for both shells. `PacksWorkspace` is mounted by the web catalog
 * dashboard and by the desktop `PluginsPanel`, and the desktop renderer
 * resolves this key from the same PostHog key space `apps/app` reads, so there
 * is no second desktop key and no Labs toggle beside it. Each shell reads it
 * ONCE, at its host, and picks between two whole selection shapes: routed
 * selection, or the component-state selection that ships today. Neither the
 * workspace nor anything below it learns that a flag exists.
 *
 * OFF (default) the `/packs/{id}` route is not reachable — its
 * `FeatureFlagRouteGate` 404s a direct visit — and selection stays in
 * `useState`, exactly as it renders today.
 */
export const PACKS_DETAIL_ROUTE_FEATURE_FLAG_KEY =
  "packs-detail-route" as const;

/**
 * FEA-3570 `github-brand-mark-filled`: gates the GitHub logo's swap from
 * lucide's outline glyph to the filled Invertocat mark. Default OFF; an
 * unresolved assignment is OFF, which renders today's outline.
 *
 * One key for BOTH shells and for the marketing site — the rationale, and why
 * the two flag ports read one literal rather than one each, lives at the
 * canonical {@link GITHUB_BRAND_MARK_FILLED_FLAG_KEY}, which this only aliases
 * so a rename touches a single definition. No desktop Labs toggle accompanies
 * it.
 */
export const GITHUB_BRAND_MARK_FILLED_FEATURE_FLAG_KEY =
  GITHUB_BRAND_MARK_FILLED_FLAG_KEY;

/**
 * ISS-9092 (ISS-4779 closed-by-default policy): gates the undo/redo KEYBINDING
 * layer — the `keydown` listener that resolves the host platform's undo chord
 * and drives the session undo stack. Off by default, and with it off the layer
 * attaches no listener at all, so a user outside the rollout keeps the
 * browser's and the OS's own Cmd+Z behaviour byte for byte.
 *
 * ONE KEY, BOTH SHELLS. The layer ships in `@repo/app`, which the web shell and
 * the Electron renderer both mount, and the desktop renderer resolves the
 * signed-in account's PostHog assignment from this same key space — so this is
 * the whole gate on both. There is no desktop Labs toggle to pair with it and
 * no desktop registry entry to add. A RE-EXPORT because every shell reads flag
 * keys from this registry; the canonical literal is
 * {@link UNDO_KEYBINDINGS_FLAG_KEY}, so a rename touches one definition.
 */
export const UNDO_KEYBINDINGS_FEATURE_FLAG_KEY = UNDO_KEYBINDINGS_FLAG_KEY;

/**
 * ISS-9731 (ISS-4779 closed-by-default): whether a desktop Labs destination
 * whose OWN per-item gate is closed withdraws to the shared
 * `LabsPageUnavailable` panel, or renders nothing.
 *
 * WHAT IT CHANGES. `#/help` resolved the route, painted the breadcrumb, and
 * then rendered a blank body, because the view self-guarded to `null` — a page
 * titled "Help" with nothing in it is indistinguishable from a Help page that is
 * merely empty or slow. ON, every per-item Labs destination (Agents, Help)
 * answers a closed gate with the same panel, which names the destination and
 * offers one way out. OFF is byte-identical to today at rest: Agents withdraws,
 * Help renders nothing.
 *
 * DEFAULT OFF, and gated at all, because opening it newly RENDERS UI on two
 * surfaces in their default state. ISS-9715 escalated exactly that rather than
 * ship it; ISS-9731 is the approval, and this key is how it rolls out.
 *
 * DECLARED HERE rather than in `apps/desktop`, and that is load-bearing. The
 * gated surfaces are desktop-only, so there is no web analogue to pair — but
 * `apps/desktop` is deliberately EXCLUDED from the flag scan
 * (`scripts/lint/posthog-flag-registration-scan.ts`), which enumerates desktop
 * keys only through `LABS_SETTING_KEY_LEDGER`. That ledger is for keys resolved
 * from the local `DesktopSettings` store, which this one is NOT: the renderer
 * resolves it from the signed-in account's PostHog assignment like every other
 * UI gate. Putting it in the ledger to satisfy the scan would be precisely the
 * desktop registry shadow entry the closed-by-default policy forbids, so it is
 * declared in this scanned, PostHog-owned registry instead.
 *
 * ONE KEY, and PostHog is the whole gate: no desktop Labs toggle, no registry
 * entry, and an unknown key settles CLOSED in every build, dev included.
 *
 * THE FLAG MUST EXIST IN POSTHOG BEFORE IT CAN BE ENABLED. Declaring this
 * constant creates nothing in PostHog.
 */
export const DESKTOP_LABS_ROUTE_WITHDRAWAL_FEATURE_FLAG_KEY =
  "desktop-labs-route-withdrawal" as const;

/**
 * ISS-8597 (PRD-699 §5 D2; ISS-4779 closed-by-default policy): gates the
 * trace-comment dead letter at its SOURCE — the terminal `sync_abandoned` write.
 * Default OFF, and an unresolved assignment is also OFF. Whether a PostHog flag
 * carries the key at all, and the `(flag-pending)` marker an attesting PR must
 * carry, are stated once in the declaring module.
 *
 * It does not gate the failed badge or the retry door. Those are keyed on the
 * row's own `syncAbandoned`, which only this gated write can set, so they ship
 * closed by construction and stay reachable for a row already dead-lettered.
 *
 * OFF, a rejected comment keeps retrying exactly as it does today: no row
 * reaches `Abandoned`, so nothing leaves the drain and there is no terminal
 * state for the rail to report. ON, the lane gives up after the ITEM budget and
 * the rail tells the author their comment was permanently rejected and offers
 * the one action that can move it.
 *
 * Rows abandoned during an open window survive a rollback, so closing the key
 * stops new dead letters rather than undoing existing ones. Their badge and retry
 * door survive it too: the rail reads no key at all, because the write gate is
 * what makes the field exist and a second read here could only hide a failure
 * from its author — see the declaring module for the whole statement.
 *
 * THE TWO HALVES ARE ONE GATE by operator ruling (2026-09-16), replacing this
 * key's first shape, which gated only the badge while the terminal write shipped
 * unconditionally — a closed key then left a comment permanently undrainable
 * with no affordance to recover it, which is the reachable-door violation
 * `apps/desktop/src/main/sync/AGENTS.md` invariant 5 forbids.
 *
 * A RE-EXPORT of the literal in
 * `@repo/api/src/types/trace-comment-sync-abandoned-flag`, where it is declared
 * because the desktop MAIN process of builds older than ISS-11213 reads it — it
 * imports that module directly, NOT this re-export, so main is why the literal
 * moved and not why this line exists. ISS-11213 deleted that reader from this
 * tree.
 *
 * THIS LINE IS WHAT PUTS THE KEY IN FRONT OF THE POSTHOG SCAN, and is load-bearing
 * despite `packages/app` having no runtime reader of it. `scanFlagKeys` collects
 * only constants whose exported name ends in `_FEATURE_FLAG_KEY`; the declaring
 * constant is `TRACE_COMMENT_SYNC_ABANDONED_FLAG_KEY`, which does not match, so
 * the scan finds this key here or nowhere. Running the scanner reports exactly
 * one declaration site and it is this line. Two specs also spell the key through
 * `@repo/app`.
 *
 * Unlike {@link ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY} above, which is a
 * re-export with real `packages/app` consumers — the analogy is the mechanism,
 * not the reason. One literal either way, never a second spelling, and no Labs
 * toggle beside it (the 2026-08-30 directive retired those; PRD-699 D2's
 * "PostHog + desktop Labs" pair wording predates it).
 */
export const TRACE_COMMENT_SYNC_ABANDONED_FEATURE_FLAG_KEY =
  TRACE_COMMENT_SYNC_ABANDONED_FLAG_KEY;

/**
 * Default-off flag for the Google Drive connection card (ISS-10316 named the
 * key it already used as a bare literal). Read where the Settings v2 Plugins
 * panel mounts the card; the Plugins panel is web-only, so no desktop surface
 * reads it there.
 */
export const GOOGLE_DRIVE_FEATURE_FLAG_KEY = "google-drive" as const;

/**
 * ISS-9734 / PLN-2016 D11 (ISS-4779 closed-by-default policy): gates the v2
 * shell SIDEBAR — the shared `ShellSidebar` composite fed by the navigation
 * view model — on both shells. OFF renders each shell's current sidebar,
 * unchanged, which is what every unresolved, errored and out-of-rollout read
 * gets.
 *
 * One key for BOTH shells: the desktop renderer resolves it from the signed-in
 * account's PostHog assignment, so there is no second desktop key, no Labs
 * toggle to pair with it and no desktop registry entry. A RE-EXPORT because
 * every shell reads flag keys from this registry; the canonical literal is
 * {@link SHELL_SIDEBAR_V2_FLAG_KEY}, which carries why the key is new and
 * where it may be read.
 */
export const SHELL_SIDEBAR_V2_FEATURE_FLAG_KEY = SHELL_SIDEBAR_V2_FLAG_KEY;

/**
 * ISS-9316 / PRD-716 phase 06 (ISS-4779 closed-by-default policy): gates where
 * the Branches list's column facts are DERIVED — four hand-built derivations
 * beside each other, or one `resolveColumnLayout` call over one declaration
 * set. Nothing the reader sees changes; OFF is the rollback.
 *
 * One key for BOTH shells, since `BranchesListSurfaceV2` is the component the
 * web page and the desktop renderer each mount, and the desktop renderer
 * resolves this key from the signed-in account's PostHog assignment. A
 * RE-EXPORT because every shell reads flag keys from this registry; the
 * canonical literal is {@link BRANCHES_COLUMN_REGISTRY_FLAG_KEY}.
 */
export const BRANCHES_COLUMN_REGISTRY_FEATURE_FLAG_KEY =
  BRANCHES_COLUMN_REGISTRY_FLAG_KEY;

/**
 * ISS-12135 (operator ruling, 2026-10-20 flag consolidation): gates the
 * shared-grid adoption program, PRD-721 to PRD-729, on Sessions, Branches,
 * Documents and Issues, inline editing included. OFF is the rollback and the
 * default (ISS-4779 closed-by-default policy). The ruling renamed this key from
 * `inline-editable-cells`, which was never created in PostHog, so no account
 * held it and no old-key alias is kept.
 *
 * Today it gates ISS-9352 (PRD-706 R11-06): whether the Session custom-field
 * ENUM and MULTI_ENUM grid columns render the mastered `InlineSelectCell` /
 * `InlineMultiSelectCell` or this package's own hand-rolled `DropdownMenu`.
 *
 * ## What flipping it ON changes on screen
 *
 * - **A refused write puts the previous option back.** The hand-rolled editor
 *   commits fire-and-forget, so a PUT the server rejects leaves the picked
 *   option on screen looking saved. That is the defect the shared cell's commit
 *   ledger exists to close.
 * - **The trigger names the value it holds**: "Edit Severity for Session one,
 *   currently High" rather than "Edit Severity for Session one", which named
 *   the field and never what was in it (WCAG 2.4.6).
 * - **The per-record clear (ISS-8713) stays an ACTION, not a value**: a
 *   trailing entry that writes `null`, never `[]`, still gated by its own
 *   {@link CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY}. Two independent gates on
 *   one cell, not one.
 *
 * ## One key for both shells
 *
 * The web app and the Electron renderer read THIS literal out of this same
 * registry from the signed-in account's PostHog assignment. There is no second
 * desktop key, no Labs toggle beside it and no registry shadow entry: since
 * ISS-8753 `DesktopFeatureFlagProvider` reads the PostHog assignment and
 * nothing else.
 *
 * Declaring the constant creates nothing in PostHog. An unknown key resolves to
 * `false`, the safe direction for a closed-by-default gate.
 */
// PRD-723 shares this adoption key for pointer/cursor/hover behavior in both
// shells (Daveth's consolidation ruling, 2026-10-20); it has no separate flag.
export const GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY = "gridview-adoption" as const;

/**
 * ISS-10467 / ISS-10468 (ISS-4779 closed-by-default policy): gates the agent
 * component detail's per-CONTENT-VERSION usage drill-down and the side-by-side
 * version compare inside it. OFF renders today's page, unchanged — the family
 * headline with no drill-down affordance at all.
 *
 * One key for BOTH shells and BOTH tickets. `AgentDetail` is the component the
 * web page and the desktop renderer each mount, and the desktop renderer
 * resolves this key from the signed-in account's PostHog assignment, so there is
 * no second desktop key and no Labs toggle. A RE-EXPORT because every shell
 * reads flag keys from this registry; the canonical literal is
 * {@link AGENTS_VERSION_USAGE_FLAG_KEY}, which carries why one key covers both.
 */
export const AGENTS_VERSION_USAGE_FEATURE_FLAG_KEY =
  AGENTS_VERSION_USAGE_FLAG_KEY;

/**
 * ISS-8936 (ISS-4779 closed-by-default policy): gates the summary metric band
 * above the Documents index — four server-measured counts over the same
 * population the list beneath them describes. OFF renders today's index
 * unchanged, and issues no `GET /documents/summary` request at all.
 *
 * A RE-EXPORT because every shell reads flag keys from this registry; the
 * canonical literal is {@link DOCUMENTS_INDEX_SUMMARY_CARDS_FLAG_KEY}, which
 * carries why one key covers every shell the surface reaches and why that is one
 * shell today.
 */
export const DOCUMENTS_INDEX_SUMMARY_CARDS_FEATURE_FLAG_KEY =
  DOCUMENTS_INDEX_SUMMARY_CARDS_FLAG_KEY;

/**
 * Operator instruction, 2026-09-30: gates the desktop opt-in distributions
 * banner (`OptInDistributionsBanner`, mounted app-level in the Electron
 * renderer's `AppShell`) — the org-shared-an-item prompt with Accept & install /
 * Dismiss. It was surfacing during first-run demos, where a stakeholder audience
 * reads an unsolicited install prompt as part of the product's first impression,
 * so the operator asked for a gate rather than a removal: the distribution
 * motion is unchanged and the prompt returns for anyone the key is opened for.
 *
 * OFF (default) renders no banner at all, which is the state the demos need.
 * The main-process push, the headless `auto_install` path, and the Packs surface
 * itself are all untouched — only this one renderer prompt is gated.
 *
 * Desktop-only surface: `apps/app` has no app-level distribution prompt, so
 * there is no web sibling to keep in parity. The key still lives in this shared
 * registry, and there is no Labs toggle and no desktop registry shadow entry
 * beside it — the desktop renderer resolves it from the signed-in account's
 * PostHog assignment, the same key space `apps/app` reads.
 */
export const DISTRIBUTION_OPT_IN_BANNER_FEATURE_FLAG_KEY =
  "distribution-opt-in-banner" as const;

/** ISS-10796 / PRD-751: one default-off account assignment across both hosts. */
export const ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY =
  "artifact-detail-shell" as const;

/** The universal Documents list replaces the legacy org index only when enabled. */
export const DOCUMENTS_UNIVERSAL_LIST_FEATURE_FLAG_KEY =
  "documents-universal-list" as const;

/** PLN-2187 DD-2; declared in `@repo/api` because `apps/api` also gates on it. */
export const DOCUMENT_UNIFIED_COMMENTS_FEATURE_FLAG_KEY =
  DOCUMENT_UNIFIED_COMMENTS_FLAG_KEY;

/** The Documents and Issues list metrics summary row stays off until PRD-800 lands. */
export const ARTIFACT_LIST_SUMMARY_FEATURE_FLAG_KEY =
  "artifact-list-summary" as const;

/**
 * Operator instruction, 2026-10-21: the Lost work Labs nav row, gated on its
 * own default-off key so it can be shown independently of TokenOps waste.
 * Nested under {@link LABS_NAV_SECTION_FEATURE_FLAG_KEY}: both must be on for
 * the row to render. The nav row only; `/insights/lost-work` stays behind the
 * Labs key alone. Web only (desktop has no Lost work view).
 */
export const LOST_WORK_NAV_FEATURE_FLAG_KEY = "lost-work-nav" as const;

/**
 * Operator instruction, 2026-10-21: the TokenOps waste Labs nav row, gated
 * independently of Lost work. Same shape as
 * {@link LOST_WORK_NAV_FEATURE_FLAG_KEY}.
 */
export const TOKENOPS_WASTE_NAV_FEATURE_FLAG_KEY =
  "tokenops-waste-nav" as const;
