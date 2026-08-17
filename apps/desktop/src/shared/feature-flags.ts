/**
 * Feature flag registry — single source of truth for all boolean feature flags.
 *
 * Adding a new flag: append an entry to FEATURE_FLAGS. The registry drives the
 * Feature Flags settings panel and the generic getFlag/setFlag accessors in
 * settings-store.ts.
 *
 * TWO CLASSES OF KEY LIVE HERE, and they have different obligations (#4739
 * review, wongk — this note used to state only the first, which read as a
 * contract every shared UI flag below was breaking):
 *
 *  - DESKTOP-OWNED flags (camelCase: `agentCoachingTips`, `verboseLogging`, …)
 *    are persisted settings. Their key MUST match the corresponding field on
 *    `DesktopSettings` in contracts.ts, and carry a typed default in
 *    `DEFAULT_DESKTOP_SETTINGS`, because they are also read through `getAll()`
 *    and the settings UI.
 *  - SHARED UI flags (kebab-case, aliasing a `@repo/api` leaf constant the web
 *    app imports too) ALSO need a `DesktopSettings` field carrying the same
 *    default. `getFlag` alone would not require it — it reaches this registry's
 *    own `default` through a `FlagKey` cast, so a key that never landed on
 *    `DesktopSettings` still resolves. But `getAll()` spreads
 *    `DEFAULT_DESKTOP_SETTINGS` over the raw store, so without the field the key
 *    is simply ABSENT from `getAll()` on a fresh profile — reading `undefined`
 *    rather than the closed default, which for an ISS-4779 closed-by-default UI
 *    gate is the one answer that must never be ambiguous.
 *    `apps/desktop/test/feature-flags-shared-ui.test.ts` asserts exactly this
 *    for every shared UI flag below ("the shared key must have a
 *    `DesktopSettings` field defaulting to false"), so it is an enforced
 *    contract, not a convention.
 *
 *    (ISS-5534: this bullet previously said the opposite — that shared UI flags
 *    are NOT `DesktopSettings` fields "and must not be added as ones" — which
 *    every shared UI flag in this registry was already breaking, and which
 *    contradicted the test above. Corrected to describe the enforced behavior.)
 */

import { AGENT_COLLABORATION_NETWORK_FLAG_KEY } from "@repo/api/src/types/agent-collaboration-network-flag";
// ISS-4774: leaf, dependency-free constant (no Zod, no `@repo/app`) — safe in
// this main-process module. Both surfaces import this same literal so a rename
// can't silently split PostHog and the Desktop Labs toggle (wongk, PR #4202).
import { AGENTS_DEFAULT_SORT_USAGE_FLAG_KEY } from "@repo/api/src/types/agents-default-sort-usage-flag";
import { AGENTS_DEFINITION_EMPTY_STATE_FLAG_KEY } from "@repo/api/src/types/agents-definition-empty-state-flag";
import { AGENTS_DETAIL_HONESTY_FLAG_KEY } from "@repo/api/src/types/agents-detail-honesty-flag";
import { AGENTS_INVOCATIONS_DEDUPE_FLAG_KEY } from "@repo/api/src/types/agents-invocations-dedupe-flag";
import { AGENTS_SOURCE_PROVENANCE_FLAG_KEY } from "@repo/api/src/types/agents-source-provenance-flag";
import { AGENTS_TYPE_TAB_OVERFLOW_FLAG_KEY } from "@repo/api/src/types/agents-type-tab-overflow-flag";
import { BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY } from "@repo/api/src/types/branch-timeline-cost-fallback-marker-flag";
import { CHART_DISTINGUISHABLE_SERIES_FLAG_KEY } from "@repo/api/src/types/chart-distinguishable-series-flag";
import { GRID_TABLE_V2_FLAG_KEY } from "@repo/api/src/types/grid-table-v2-flag";
import { INSIGHTS_SPEND_OUTCOME_FLAG_KEY } from "@repo/api/src/types/insights-spend-outcome-flag";
import { MEMBER_SELF_SERVICE_INSTALL_FLAG_KEY } from "@repo/api/src/types/member-self-service-install-flag";
import { SESSION_ACTIVITY_PHASES_FLAG_KEY } from "@repo/api/src/types/session-activity-phases-flag";
import { SESSION_TIMELINE_COLUMN_HIT_TARGET_FLAG_KEY } from "@repo/api/src/types/session-timeline-column-hit-target-flag";
import { SESSIONS_BRANCHES_TAB_TITLES_FLAG_KEY } from "@repo/api/src/types/sessions-branches-tab-titles-flag";
import { SESSIONS_DISPLAYED_STATUS_PARITY_FLAG_KEY } from "@repo/api/src/types/sessions-displayed-status-parity-flag";
import { SESSIONS_GRID_FOLD_LEGIBILITY_FLAG_KEY } from "@repo/api/src/types/sessions-grid-fold-legibility-flag";
import { SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY } from "@repo/api/src/types/sessions-summary-honest-loading-flag";
import { DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY } from "./desktop-compute-progress-count-flag.js";
import { DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY } from "./desktop-docs-help-flag.js";
import { DESKTOP_REQUESTS_LIVE_REFRESH_FEATURE_FLAG_KEY } from "./desktop-requests-live-refresh-flag.js";
import { DESKTOP_STOPPED_LANE_READINESS_FEATURE_FLAG_KEY } from "./stopped-lane-readiness-flag.js";

export type FlagDefinition = {
  key: string;
  default: boolean;
  label: string;
  description: string;
  category:
    | "CLI Tools"
    | "Cloud"
    | "Data Collection"
    | "Diagnostics"
    | "Experimental"
    | "Labs"
    | "Security";
  /** If true, flag requires an app restart to take full effect. */
  requiresRestart?: boolean;
  /**
   * ISS-5310 (stage cid 3726701542): the key of a PARENT flag this one is inert
   * without. A dependency stated only in prose is not a dependency the UI
   * enforces — the Labs panel reads this to nest the row under its parent and
   * DISABLE its switch while the parent is off, so a user cannot flip a toggle
   * that provably cannot do anything and be left to find the reason in the last
   * sentence of a description they already skimmed.
   *
   * One level only, by construction: every current parent (`agentsNav`) is a
   * destination gate with no parent of its own, and the panel renders exactly
   * one nesting tier.
   */
  dependsOn?: string;
  /** Env var that overrides the persisted value when set to "1"/"0"/"true"/"false". */
  envOverride?: string;
  /**
   * If true, the flag is registered for getFlag/setFlag soundness but is NOT
   * rendered as a generic toggle in the Labs settings panel. Use for flags that
   * are not user-set (shared kebab-case UI flags resolved via
   * `useFeatureFlagEnabled`) or that already have a dedicated, purpose-built
   * control elsewhere (e.g. the Relay/Gateway tab), so the Labs panel does not
   * duplicate them and desync the two controls.
   */
  hiddenFromLabs?: boolean;
};

export const DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY = "agentCoachingTips";
export const DESKTOP_AGENT_COACHING_PACKS_FEATURE_FLAG_KEY =
  "agentCoachingPacks";
export const DESKTOP_TRANSCRIPT_SYNC_FEATURE_FLAG_KEY = "transcriptSyncEnabled";
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
 * picker's rendered option set is gated. Desktop-only surface (the onboarding
 * sync-consent already omits redacted), so the generic Labs toggle is the only
 * opt-in.
 */
export const DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY =
  "showRedactedSyncLevel";
/**
 * PRD-536 G1 (Phase 3): shared web+desktop UI flag (kebab-case, PostHog key
 * "sessions-transcript-sync-status") gating the per-session transcript-freshness
 * affordance on the Sessions LIST rows (and turned on together with the detail
 * Properties Sync row). The packaged desktop renderer has no PostHog wiring, so
 * unknown shared flags resolve to false in release builds via
 * `DesktopFeatureFlagProvider` — so WITHOUT this registry entry the desktop
 * `SyncedSessionsTable` rows would always render `null` even when local/cloud
 * rows carry `lastSyncedAt`, leaving the affordance web-only. Registering it here
 * surfaces a Labs toggle so desktop users can opt in (parity with the web
 * PostHog rollout). Off by default (dark launch); the shared
 * `SessionSyncStatusBadge` gates on
 * `useFeatureFlagEnabled("sessions-transcript-sync-status")`. Must stay
 * byte-for-byte equal to `SESSIONS_TRANSCRIPT_SYNC_STATUS_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`; the literal is redeclared here
 * (instead of imported) to keep this main-process module free of the
 * `@repo/app`/`@repo/api` transitive graph.
 */
export const DESKTOP_SESSIONS_TRANSCRIPT_SYNC_STATUS_FEATURE_FLAG_KEY =
  "sessions-transcript-sync-status";
/**
 * ISS-5566: shared web+desktop UI flag (kebab-case, PostHog key
 * "session-timeline-synthesized-cost") gating the Session Timeline's disclosure
 * that a strip's bars were reconstructed from the transcript rather than
 * measured — and the withdrawal of the manufactured dollar figures that went
 * with them.
 *
 * `AgentSessionDetailView` mounts on the desktop renderer as well as the web
 * app, and the packaged renderer has no PostHog wiring, so unknown shared flags
 * resolve to false there via `DesktopFeatureFlagProvider` — without this entry
 * desktop keeps painting the synthesized cents as measured money and the
 * disclosure would be web-only. Off by default (ISS-4779 closed-by-default).
 * Must stay byte-for-byte equal to
 * `SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`; the literal is redeclared here
 * (instead of imported) to keep this main-process module free of the
 * `@repo/app` transitive graph.
 */
export const DESKTOP_SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY =
  "session-timeline-synthesized-cost";
/**
 * ISS-5841: Labs counterpart to the web `SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY`.
 * Aliases the same `@repo/api` leaf so "byte-for-byte equal to the web key" is a
 * fact of the import rather than a comment two files must keep agreeing on.
 */
export const DESKTOP_SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY =
  SESSION_ACTIVITY_PHASES_FLAG_KEY;
/**
 * ISS-5564: shared web+desktop UI flag (kebab-case, PostHog key
 * "session-phase-confidence-disclosure") gating the Activity breakdown's
 * confidence-basis footer sentence — the one that tells a reader a phase's
 * `Conf. 0%` describes only how sure we are of its LABEL, not of the measured
 * dollars attributed to it.
 *
 * `SessionActivityBreakdown` mounts on the desktop renderer as well as the web
 * app, and the packaged renderer has no PostHog wiring, so unknown shared flags
 * resolve to false there via `DesktopFeatureFlagProvider` — without this entry
 * desktop keeps the unexplained contradiction and the disclosure would be
 * web-only. Off by default (ISS-4779 closed-by-default). Must stay
 * byte-for-byte equal to `SESSION_PHASE_CONFIDENCE_DISCLOSURE_FEATURE_FLAG_KEY`
 * in `packages/app/shared/lib/feature-flags.ts`; the literal is redeclared here
 * (instead of imported) to keep this main-process module free of the
 * `@repo/app` transitive graph.
 */
export const DESKTOP_SESSION_PHASE_CONFIDENCE_DISCLOSURE_FEATURE_FLAG_KEY =
  "session-phase-confidence-disclosure";
/**
 * ISS-4978: shared web+desktop UI flag (kebab-case, PostHog key
 * "sessions-duration-calendar-qualifier") gating the session-detail Properties
 * Duration row's truth-in-UI pass — qualifying the calendar fallback as
 * "calendar" rather than "wall", and dropping the two placeholders that are
 * absent by construction for exactly that population.
 *
 * `SessionDurationProperty` mounts on the desktop renderer as well as the web
 * app. Off by default (ISS-4779 closed-by-default). Must stay byte-for-byte
 * equal to `SESSIONS_DURATION_CALENDAR_QUALIFIER_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`; the literal is redeclared here
 * (instead of imported) to keep this main-process module free of the
 * `@repo/app` transitive graph.
 *
 * ISS-5131 RETIRED THIS GATE, and #4409 REMOVED ITS LABS ENTRY. There is one
 * Duration measure now, so there is no qualifier to choose and no
 * absent-by-construction placeholder to drop; nothing reads this key. The key
 * constant stays exported for the compatibility guardrail — an installed build
 * may still have the setting persisted — but the toggle is gone from the panel,
 * because a switch a user can flip that moves nothing on screen is worse than
 * no switch at all. Do not add callers.
 */
export const DESKTOP_SESSIONS_DURATION_CALENDAR_QUALIFIER_FEATURE_FLAG_KEY =
  "sessions-duration-calendar-qualifier";
/**
 * ISS-4773: shared web+desktop UI flag (kebab-case, PostHog key
 * "sessions-cost-billing-honesty") gating the Sessions "Cost" card's truth-in-UI
 * pass — a headline restricted to CONFIRMED API-billed spend, a caption naming
 * the API-equivalent value of confirmed subscription-covered usage, and an
 * explicit disclosure of any share whose billing mode was never determined.
 *
 * `SessionsSummaryCards` mounts on the desktop renderer as well as the web app.
 * Off by default (ISS-4779 closed-by-default). Must stay byte-for-byte equal to
 * `SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`; the literal is redeclared here
 * (instead of imported) to keep this main-process module free of the
 * `@repo/app` transitive graph.
 */
export const DESKTOP_SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY =
  "sessions-cost-billing-honesty";
/**
 * ISS-5842: shared web+desktop UI flag (kebab-case, PostHog key
 * "metric-delta-unified-pill") gating the unified delta-chip treatment on the
 * shared metric primitives — one pill geometry per tone, colour-only variation,
 * and no "better"/"worse" verdict word.
 *
 * `MetricCard` and the Insights `TrendBadge` mount on the desktop renderer as
 * well as the web app — the Sessions strip, the Branches strip and the
 * first-launch dashboard all render them — and the packaged renderer has no
 * PostHog wiring, so without this entry desktop could never opt in and the
 * change would be web-only. Off by default (ISS-4779 closed-by-default). Must
 * stay byte-for-byte equal to `METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`; the literal is redeclared here
 * (instead of imported) to keep this main-process module free of the
 * `@repo/app` transitive graph.
 */
export const DESKTOP_METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY =
  "metric-delta-unified-pill";
/**
 * ISS-5548: shared web+desktop UI flag (kebab-case, PostHog key
 * "session-timeline-column-hit-target") growing a Session Timeline bar's click
 * target to the full height of its own column, so a low-value bucket is no
 * harder to hit than a tall one.
 *
 * `SessionActivityTimeline` mounts on the desktop renderer as well as the web
 * app, and the packaged renderer has no PostHog wiring, so unknown shared flags
 * resolve to false there via `DesktopFeatureFlagProvider` — without this entry
 * desktop keeps the ~6px slivers and the fix would be web-only. Off by default
 * (ISS-4779 closed-by-default).
 *
 * Aliases the leaf, dependency-free `@repo/api` constant that the web alias
 * (`SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`) also points at, so the two
 * surfaces share ONE definition instead of parallel literals that could drift
 * apart under a rename. Importing from `@repo/api` — not `@repo/app` — keeps
 * this main-process module free of the heavy transitive graph.
 */
export const DESKTOP_SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY =
  SESSION_TIMELINE_COLUMN_HIT_TARGET_FLAG_KEY;
/**
 * FEA-3741 (slice 1) — per-tool collector enable/disable toggles ("Data
 * Collection" first-run permissions & access UX; Mike's decision 2026-07-22:
 * collectors ON by default, individually disableable).
 *
 * Each key gates whether the desktop agent-data collector for that harness runs
 * at all. Default ON (unchanged always-on posture). When a user flips one off,
 * `getActiveCollectionMode` resolves that harness to `"disabled"` — the single
 * source-of-truth routing seam (FEA-1839) — so neither the live JSONL watcher
 * nor the hook path attaches for it, and its tool-home walk (`~/.claude`,
 * `~/.cursor`, Copilot workspace storage) is never started. These are the
 * collectors that can incidentally touch TCC-protected folders when a user's
 * real projects live under Desktop/Downloads/Documents, so a disable is the
 * user's lever to stop that scan entirely. `requiresRestart` because the toggle
 * is snapshotted at collector (re)start; the CLI Tools settings surface restarts
 * collectors on change so it takes effect immediately.
 *
 * These do NOT loosen any sandbox/security invariant — they only ever REDUCE
 * what the collectors read (FEA-3641/#3398 TCC-folder guards remain the
 * enforcement floor and are untouched).
 */
export const DESKTOP_COLLECT_CLAUDE_ENABLED_FEATURE_FLAG_KEY =
  "collectClaudeEnabled";
export const DESKTOP_COLLECT_CURSOR_ENABLED_FEATURE_FLAG_KEY =
  "collectCursorEnabled";
export const DESKTOP_COLLECT_COPILOT_ENABLED_FEATURE_FLAG_KEY =
  "collectCopilotEnabled";
/**
 * PRD-566 / FEA-4348 (formerly FEA-3813 / PRD-553 M1): the desktop-side gate for
 * Routines (the renamed "Scheduled Tasks" feature) — the persisted
 * DesktopSettings field that gates the local crewd (`@repo/crewd`) scheduler host
 * (the `SchedulerService` + its SQLite-mirrored `SqliteTaskStore` daemon) and,
 * through the desktop feature-flag provider, the renderer nav entry + view mount.
 *
 * The literal is `"routines"` — deliberately equal to the PostHog
 * `ROUTINES_FEATURE_FLAG_KEY` (`packages/api/src/types/routines.ts`) so the SAME
 * key resolves the feature on both surfaces through their respective ports: the
 * desktop provider resolves it from this persisted registry value (main-process
 * has no PostHog, and the daemon boots off this local opt-in), while the web app
 * resolves the identical key via PostHog. The literal is redeclared here (not
 * imported) to keep this main-process module free of the `@repo/api` transitive
 * graph — it MUST stay byte-for-byte equal to `ROUTINES_FEATURE_FLAG_KEY`.
 *
 * Compatibility: an install that previously opted into the old `scheduledTasks`
 * Labs flag has its persisted value copied to `routines` by a boot migration
 * (`migrateScheduledTasksToRoutines`), so an already-stored opt-in — and the
 * scheduled-task data behind it — is never stranded. Default OFF (dark launch);
 * `requiresRestart` because the daemon is snapshotted at boot.
 */
export const DESKTOP_ROUTINES_FEATURE_FLAG_KEY = "routines";
/**
 * Legacy desktop Labs flag key for the pre-rename "Scheduled Tasks" feature.
 * Retained ONLY so the one-time settings migration can read a persisted opt-in
 * and copy it to {@link DESKTOP_ROUTINES_FEATURE_FLAG_KEY}; it is no longer in the
 * flag registry (so it renders no Labs toggle) and must not be removed until all
 * installs have migrated (compatibility guardrail).
 */
export const DESKTOP_LEGACY_SCHEDULED_TASKS_FEATURE_FLAG_KEY = "scheduledTasks";
/**
 * FEA-3847 (PRD-556 M1): desktop-owned Labs flag (camelCase, persisted
 * DesktopSettings field) gating the in-app Audit Bot — the on-demand `audit:run`
 * IPC that executes a crewd (`@repo/crewd`) review character (Docs Darwin first)
 * against the open repo via the harness cascade. Default OFF: when off, the
 * `audit:run` handler refuses the run before spawning any harness (and M2's Audit
 * surface stays dark), so it is a hard no-op. M1 ships no UI (that is M2/
 * FEA-3848), so the generic Labs toggle is the only opt-in.
 */
export const DESKTOP_AUDIT_BOT_FEATURE_FLAG_KEY = "auditBot";
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
 * FEA-4130: the Trusted Browser Enforcement opt-in surfaced as a user toggle in
 * the Security Settings card. The Security tab selects the flag by this exact
 * key rather than by `category === "Security"` — `category` groups flags for the
 * registry, and a future internal/registry-only Security flag (e.g. a
 * `hiddenFromLabs` gate with no user control) must NOT auto-inherit a writable
 * toggle. Scope the rendered toggle to the specific key.
 */
export const DESKTOP_COMMAND_SIGNING_ENFORCEMENT_FEATURE_FLAG_KEY =
  "commandSigningEnforcementEnabled";
/**
 * FEA-4174 / PRD-545: desktop-owned Labs flag (camelCase, persisted
 * DesktopSettings field) gating Value Numerator 2.0 — the Pensero-powered
 * delivery-metrics numerator that normalizes Pensero's PERSON-centric metrics
 * onto our SESSION/BRANCH/PR entities (`@repo/pensero`). Default OFF (dark
 * launch): when off, the numerator surfaces stay dark and the Pensero
 * integration is never invoked from the renderer. The Pensero client itself is
 * server-side and reads its credential from env, so an unconfigured install is
 * a hard no-op regardless of this flag. The generic Labs toggle is the only
 * opt-in.
 */
export const DESKTOP_VALUE_NUMERATOR_V2_FEATURE_FLAG_KEY = "valueNumeratorV2";
/**
 * ISS-4792 (ISS-4779 closed-by-default policy for the ISS-4714 UI): desktop-only
 * Labs flag (kebab-case, persisted DesktopSettings field) gating the "DB ahead /
 * update required" banner (`AgentMonitorDbAheadBanner`, mounted in `App.tsx`).
 * Default OFF: with it off the banner is never rendered and the app behaves
 * exactly as before this in-flight UI landed. When on, a runtime that reports the
 * local DB is newer than this app build surfaces the pinned update-required
 * banner. Desktop-only surface, so a Labs toggle is the sole opt-in. Registered
 * here so getFlag/setFlag type casts remain sound.
 */
export const DESKTOP_DB_AHEAD_BANNER_FEATURE_FLAG_KEY = "db-ahead-banner";
/**
 * ISS-4715: desktop-only Labs flag gating the startup-readiness experience that
 * keeps the Sessions shell usable while local history and cloud freshness work
 * continue in the background. Default OFF under the closed-by-default UI
 * policy; restart-scoped because the app-shell gate is resolved at startup.
 */
export const DESKTOP_STARTUP_READINESS_EXPERIENCE_FEATURE_FLAG_KEY =
  "startupReadinessExperience";
/**
 * ISS-4890 / ISS-4906 / ISS-4901 (ISS-4779 closed-by-default policy): shared
 * web+desktop UI flag gating the Sessions grid's horizontal-fold legibility pass
 * — the one-time relocation of a persisted `columnOrder`'s Cost column to its
 * canonical pre-fold slot, the settle-damped fold fit that removes the resize
 * sawtooth, and the scroll affordance signposting the columns past the fold.
 * Default OFF: with it off the persisted order is never rewritten, the fit
 * tracks the live measured width, and the scroll region renders bare. The
 * packaged desktop renderer has no PostHog wiring, so this shared key would
 * otherwise fall through to the build-type default (ON in dev); registering it
 * here surfaces a Labs toggle so the pass cannot leak on desktop while hidden on
 * web. Aliases the shared `@repo/api` constant rather than redeclaring the
 * literal, so a rename touches one definition.
 */
export const DESKTOP_SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY =
  SESSIONS_GRID_FOLD_LEGIBILITY_FLAG_KEY;
/**
 * ISS-5534 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the Agents list Invocations summary card's plugin de-duplication — a
 * plugin's invocations ARE its skill/command/subagent/mcp children's, so on the
 * "All" type tab, where both are rows, the card's flat sum double-counts them.
 * Default OFF: with it off the card renders exactly the prior total. The
 * packaged desktop renderer has no PostHog wiring, so this shared key would
 * otherwise fall through to the build-type default (ON in dev); registering it
 * here surfaces a Labs toggle so the change cannot leak on desktop while hidden
 * on web. Aliases the shared `@repo/api` constant rather than redeclaring the
 * literal, so a rename touches one definition.
 */
export const DESKTOP_AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY =
  AGENTS_INVOCATIONS_DEDUPE_FLAG_KEY;
/**
 * ISS-5271 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the Sessions summary cards' honest never-loaded state — an absent
 * usage summary (no error) skeletons the Sessions/Total Tokens value slots
 * instead of rendering a confident `0` beside a Cost card that dashes. The
 * packaged desktop renderer has no PostHog wiring, so this shared key would
 * otherwise fall through to the build-type default (ON in dev); registering it
 * here surfaces a Labs toggle so the state cannot leak on desktop while hidden
 * on web. Aliases the shared `@repo/api` constant rather than redeclaring the
 * literal, so a rename touches one definition.
 */
export const DESKTOP_SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY =
  SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY;
/**
 * ISS-5951 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the Branch PR-activity timeline's fallback-cost marker — a headline
 * cost chosen BECAUSE there is no authoritative Branch total now carries the
 * same incomplete marker the timing-incomplete fallback already did, read from
 * the one predicate that selects the value. `BranchDetailPage` mounts on web AND
 * desktop, and the packaged desktop renderer has no PostHog wiring, so this
 * shared key would otherwise fall through to the build-type default (ON in dev);
 * registering it here surfaces a Labs toggle so the marker cannot leak on one
 * surface while hidden on the other. Aliases the shared `@repo/api` constant
 * rather than redeclaring the literal, so a rename touches one definition.
 */
export const DESKTOP_BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY =
  BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY;
/**
 * ISS-4556 / ISS-4559: shared web+desktop flag (kebab-case, PostHog key
 * "sessions-displayed-status-parity") gating the Sessions DISPLAYED-status single
 * source of truth — one derivation behind the row's Status cell, the Status sort
 * key, and the Status facet predicates.
 *
 * Unlike most entries here this gate is read in the desktop MAIN process, not the
 * renderer: the Local lane derives the row status and the facet in
 * `shared-agent-sessions-api.ts`, so the toggle is resolved through
 * `displayed-status-parity-gate.ts` at the composition root. Off by default
 * (ISS-4779 closed-by-default).
 *
 * Sharing the KEY is not the same as sharing the SWITCH, and this alias only does
 * the former. Local reads a desktop Labs boolean from the settings store; Cloud
 * reads a per-viewer PostHog rollout in `apps/api`. Nothing reconciles the two,
 * so for the whole rollout window a user genuinely can have the Labs toggle on
 * while PostHog has not enrolled them (or the reverse), and see the Local and
 * Cloud lanes disagree. What the shared constant buys is narrower and still worth
 * having: one definition of the key, so the two surfaces cannot end up gating on
 * DIFFERENT flags, and a rename touches one line. Closing the skew itself would
 * need the desktop toggle to defer to the same per-viewer evaluation, which is
 * out of scope here.
 */
export const DESKTOP_SESSIONS_DISPLAYED_STATUS_PARITY_FEATURE_FLAG_KEY =
  SESSIONS_DISPLAYED_STATUS_PARITY_FLAG_KEY;
/**
 * ISS-5574 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating per-page browser tab titles on the Sessions and Branches surfaces.
 * Every one of those pages reported the application-wide title, so several open
 * tabs were indistinguishable and history carried no record identity. Default
 * OFF: with it off the renderer leaves the window title exactly as the entry HTML
 * set it. The packaged desktop renderer has no PostHog wiring, so this shared key
 * would otherwise fall through to the build-type default (ON in dev);
 * registering it here surfaces a Labs toggle so titles cannot leak on desktop
 * while hidden on web. Aliases the shared `@repo/api` constant rather than
 * redeclaring the literal, so a rename touches one definition.
 */
export const DESKTOP_SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY =
  SESSIONS_BRANCHES_TAB_TITLES_FLAG_KEY;
/**
 * GridTable v2 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the shared `GridTable` enhancement pass — per-column options menu,
 * hover-revealed sort affordance, row selection and activation, click-to-
 * keyboard cell navigation, the leading utility column, and rows-per-page.
 *
 * The packaged desktop renderer has no PostHog wiring, so this shared key would
 * otherwise fall through to the build-type default (ON in dev); registering it
 * here surfaces a Labs toggle so the pass cannot leak on desktop while hidden
 * on web. Aliases the shared `@repo/api` constant rather than redeclaring the
 * literal, so a rename touches one definition.
 */
export const DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY = GRID_TABLE_V2_FLAG_KEY;
/**
 * ISS-5125 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the MEMBER self-service install affordance on the packs per-machine
 * block. Off, the block is the FEA-4077 read-only status list; on, an
 * actionable (machine × harness) cell carries an Install/Retry control.
 *
 * The desktop renderer mounts the same block (via `PluginsPanel` →
 * `PacksWorkspace` → `PackDetail`) and has no PostHog wiring, so this shared key
 * would otherwise fall through to the build-type default; registering it here
 * surfaces a Labs toggle so the affordance cannot leak on desktop while hidden
 * on web. Aliases the shared `@repo/api` constant rather than redeclaring the
 * literal, so a rename touches one definition.
 */
export const DESKTOP_MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY =
  MEMBER_SELF_SERVICE_INSTALL_FLAG_KEY;
/**
 * ISS-4463 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the Insights "Spend by outcome" tiles — the TokenOps lens splitting AI
 * spend by how the originating session ended. The packaged desktop renderer has
 * no PostHog wiring, so this shared key would otherwise fall through to the
 * build-type default (ON in dev); registering it here surfaces a Labs toggle so
 * the lens cannot leak on desktop while hidden on web. Aliases the shared
 * `@repo/api` constant rather than redeclaring the literal, so a rename touches
 * one definition.
 */
export const DESKTOP_INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY =
  INSIGHTS_SPEND_OUTCOME_FLAG_KEY;
/**
 * ISS-5061 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the "Agent Collaboration Network" row on the Insights overview
 * dashboard. The packaged desktop renderer has no PostHog wiring, so this shared
 * key would otherwise fall through to the build-type default (ON in dev);
 * registering it here surfaces a Labs toggle so the row cannot leak on desktop
 * while hidden on web. Aliases the shared `@repo/api` constant rather than
 * redeclaring the literal, so a rename touches one definition.
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
 * Sessions, the same shape the `docsHelp`/`auditBot` route gates already use.
 * ON: the section appears exactly as it does today.
 *
 * Desktop-owned (camelCase, persisted `DesktopSettings` field) because its
 * control is NOT a Labs-panel toggle: it is the deliberately subtle "Enable
 * Labs" checkbox in the native application menu (`main/app-menu.ts`), which is
 * why this entry is `hiddenFromLabs` — a Labs-panel row would both defeat the
 * easter egg and be self-referential. Toggling it writes through the ordinary
 * `setFlag` path and broadcasts `desktop:flags-changed`, so the sidebar reacts
 * live with no relaunch, and the value persists across launches.
 *
 * This gates the CONTAINER only. The per-item Labs flags inside it
 * (`routines`, `auditBot`, `docsHelp`, …) keep their own persisted values —
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
 * ISS-5310 (ISS-4779 closed-by-default): desktop-owned per-item Labs flag over
 * the Agents destination — the sidebar entry AND `#/agents`.
 *
 * Agents moved out of Artifacts and back into the Labs section, so this flag
 * sits INSIDE {@link DESKTOP_LABS_NAV_FEATURE_FLAG_KEY} rather than beside it:
 * the container gate wins, and this one only decides what shows once Labs is
 * already on. Labs off ⇒ Agents hidden whatever this says; Labs on + this off ⇒
 * hidden; both on ⇒ visible. Same nesting the `routines`/`auditBot`/`docsHelp`
 * per-item flags already have, and the same composition rule: turning the
 * container off never writes to this value, so flipping Labs back on restores
 * exactly what was showing before.
 *
 * NOT `hiddenFromLabs` — a user-facing row in the Labs settings card IS the
 * "re-add the Labs configuration toggle" half of ISS-5310. Desktop-only: the
 * web sidebar has its own nav model and is untouched, so there is no PostHog
 * half to keep in parity.
 */
export const DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY = "agentsNav";
/**
 * ISS-5005 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the Agents catalog landing on a usage-bearing default sort
 * (Invocations descending) instead of Component ascending, plus the one-time
 * rewrite of a persisted view still carrying the never-touched legacy default.
 *
 * The catalog (`AgentsGroupedList` via `useAgentComponentsViewState`) mounts on
 * the desktop renderer under the `agents:desktop` persistence key as well as on
 * web. The packaged desktop renderer has no PostHog wiring, so this shared key
 * would otherwise fall through to the build-type default (ON in dev);
 * registering it here surfaces a Labs toggle (default OFF) so the new default
 * cannot leak on desktop while hidden on web. Aliases the shared `@repo/api`
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
 * renderer as well as on web. The packaged desktop renderer has no PostHog
 * wiring, so this shared key would otherwise fall through to the build-type
 * default (ON in dev); registering it here surfaces a Labs toggle (default OFF)
 * so the change cannot leak on desktop while hidden on web. Aliases the shared
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
 * `AgentDetail` mounts on the desktop renderer as well as on web. The packaged
 * desktop renderer has no PostHog wiring, so this shared key would otherwise
 * fall through to the build-type default (ON in dev); registering it here
 * surfaces a Labs toggle (default OFF) so the change cannot leak on desktop
 * while hidden on web. Aliases the shared `@repo/api`
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
 * packaged desktop renderer has no PostHog wiring, so this shared key would
 * otherwise fall through to the build-type default (ON in dev); registering it
 * here surfaces a Labs toggle (default OFF) so the change cannot leak on desktop
 * while hidden on web. Aliases the shared `@repo/api`
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
 * packaged desktop renderer has no PostHog wiring, so this shared key would
 * otherwise fall through to the build-type default (ON in dev); registering it
 * here surfaces a Labs toggle (default OFF) so the change cannot leak on desktop
 * while hidden on web. Aliases the shared `@repo/api`
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
 * the closed-by-default policy exists to prevent. Desktop-only — no PostHog twin.
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
 * Diagnostics view, so a Labs toggle is the only gate this needs. The durable
 * record itself is written regardless of the flag: withholding data because a
 * display toggle is off would recreate the very gap this ticket closes.
 */
export const DESKTOP_OPENCODE_WITHHELD_DIAGNOSTICS_FEATURE_FLAG_KEY =
  "opencode-withheld-diagnostics";
/**
 * ISS-5112 (ISS-4779 closed-by-default): gates guest-mode first-run onboarding.
 * With it OFF the signed-out Dashboard keeps the blocking auth overlay it has
 * shipped since PRD-532 M4; with it ON a guest reaches the populated Dashboard
 * and converts through contextual sign-up entry points instead. Desktop-only
 * surface — `apps/app` has no pre-auth desktop first run — so the Labs toggle is
 * the only opt-in and there is no web flag to keep in parity.
 */
export const DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY = "guest-onboarding";
/**
 * ISS-5607 (ISS-4779 closed-by-default): the `ReadSourceBadge` in the desktop
 * session DETAIL pane's header.
 *
 * The detail is the one screen where a LINK'S PRESENCE depends on which source
 * you are reading — after ISS-5567 the Branch row links only while the Sessions
 * and Branches readers agree — and it was the one screen that never said which
 * source that was. Note that ISS-6005 dropped this pill from the Sessions LIST
 * toolbar at operator direction ("no one asked for it"); it earns its place here
 * on the consequence the list does not have, which is also why it ships behind
 * its own toggle rather than as an assumed win.
 *
 * Desktop-only surface — the split is between the desktop's LOCAL SQLite reader
 * and the cloud reader, and `apps/app` has no local source to disagree with — so
 * the Labs toggle is the only opt-in and there is no PostHog half to keep in
 * parity. Registered here so getFlag/setFlag type casts remain sound.
 */
export const DESKTOP_SESSION_DETAIL_READ_SOURCE_FEATURE_FLAG_KEY =
  "session-detail-read-source";
const FEATURE_FLAGS_INTERNAL = [
  {
    key: DESKTOP_COLLECT_CLAUDE_ENABLED_FEATURE_FLAG_KEY,
    default: true,
    label: "Collect Claude Code sessions",
    description:
      "Reads your local Claude Code transcripts (~/.claude) to populate the Agent Dashboard. Turn off to stop Claude data collection entirely.",
    category: "Data Collection" as const,
    requiresRestart: true,
    // Rendered by a dedicated per-tool card in the CLI Tools settings tab, not
    // the generic Labs list, so it lives beside the tool it collects from.
    hiddenFromLabs: true,
  },
  {
    key: DESKTOP_COLLECT_CURSOR_ENABLED_FEATURE_FLAG_KEY,
    default: true,
    label: "Collect Cursor sessions",
    description:
      "Reads your local Cursor transcripts (~/.cursor) to populate the Agent Dashboard. Turn off to stop Cursor data collection entirely.",
    category: "Data Collection" as const,
    requiresRestart: true,
    hiddenFromLabs: true,
  },
  {
    key: DESKTOP_COLLECT_COPILOT_ENABLED_FEATURE_FLAG_KEY,
    default: true,
    label: "Collect GitHub Copilot sessions",
    description:
      "Reads your local GitHub Copilot chat/CLI history (VS Code workspace storage, ~/.copilot) to populate the Agent Dashboard. Turn off to stop Copilot data collection entirely.",
    category: "Data Collection" as const,
    requiresRestart: true,
    hiddenFromLabs: true,
  },
  {
    key: "planExtractionEnabled" as const,
    default: false,
    label: "Plan Extraction",
    description:
      "Host-owned opt-in for Plans / plan extraction UI in the embedded Agent Dashboard.",
    category: "Experimental" as const,
  },
  {
    key: DESKTOP_SESSION_DETAIL_READ_SOURCE_FEATURE_FLAG_KEY,
    default: false,
    label: "Session Detail Read Source",
    description:
      "Shows which store a session's details were read from, on the session detail pane.",
    category: "Labs" as const,
  },
  {
    key: DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY,
    default: false,
    label: "Agent Coaching Tips",
    description:
      "Shows personalized coaching tips in Sessions based on local agent history and prior tip feedback.",
    category: "Experimental" as const,
  },
  {
    key: DESKTOP_AGENT_COACHING_PACKS_FEATURE_FLAG_KEY,
    default: false,
    label: "Coaching Packs",
    description:
      "Lets an installed coaching pack override the built-in best-practice signals that power coaching tips. Requires Agent Coaching Tips.",
    category: "Experimental" as const,
  },
  {
    key: DESKTOP_COMMAND_SIGNING_ENFORCEMENT_FEATURE_FLAG_KEY,
    default: false,
    label: "Trusted Browser Enforcement",
    description:
      "Requires browser commands to carry an approved signing key before execution.",
    category: "Security" as const,
    // FEA-4130: rendered by a dedicated card on the Security settings tab
    // (beside the other security controls), NOT the generic Labs list, so it is
    // `hiddenFromLabs` — LabsTab excludes it and the Security tab owns its
    // toggle. Mirrors the cloudConnectionEnabled precedent: no duplicate toggle
    // whose Labs state could desync from the Security surface.
    hiddenFromLabs: true,
  },
  {
    key: "cloudConnectionEnabled" as const,
    default: true,
    label: "Cloud Connection",
    description:
      "Enables the Socket.IO relay connection to the Closedloop cloud control plane.",
    category: "Cloud" as const,
    // Dedicated "Cloud Connection" switch in the Relay/Gateway tab owns this
    // operational control; keep it out of the generic Labs panel to avoid a
    // duplicate toggle whose local state desyncs from the relay tab.
    hiddenFromLabs: true,
  },
  {
    key: "cloudCommandsPaused" as const,
    default: false,
    label: "Pause Remote Commands",
    description:
      "Pauses execution of cloud-dispatched commands while keeping the relay connection alive.",
    category: "Cloud" as const,
    // Dedicated "Pause Incoming Commands" switch in the Relay/Gateway tab owns
    // this operational kill-switch; keep it out of the generic Labs panel.
    hiddenFromLabs: true,
  },
  {
    key: "updateAndRestartEnabled" as const,
    default: false,
    label: "Auto-Update & Restart",
    description:
      "Automatically download and install updates, then restart the app.",
    category: "Experimental" as const,
  },
  {
    key: "sessionCompletionNotifications" as const,
    default: false,
    label: "Session Completion Notifications",
    description:
      "Shows a desktop notification when an agent session finishes (completed or errored), with a click-through to the session detail.",
    category: "Experimental" as const,
  },
  {
    key: "loopCompletedNotificationsEnabled" as const,
    default: false,
    label: "Loop Completion Notifications",
    description:
      "Shows an OS notification with a 'View loop' action when a loop you launched finishes running.",
    category: "Experimental" as const,
  },
  {
    key: "verboseLogging" as const,
    default: false,
    label: "Verbose Logging",
    description: "Enable verbose gateway logging for debugging.",
    category: "Diagnostics" as const,
  },
  {
    // FEA-2715: raw transcript archive lane. Gates the main-process
    // TranscriptSyncService (fingerprint store, discovery, hybrid triggers,
    // streaming multipart delta upload via the FEA-2714 control plane, and
    // first-connect backfill). Off by default and restart-scoped pending
    // end-to-end validation against the live control plane + S3; when off the
    // service is never constructed, so it is a hard no-op. Entirely separate
    // from the 256 KiB structured-metadata lane (the always-on Agent Dashboard).
    key: DESKTOP_TRANSCRIPT_SYNC_FEATURE_FLAG_KEY,
    default: false,
    label: "Transcript Sync",
    description:
      "Archives full Claude Code / Codex session transcripts (main + subagent) to Closedloop cloud storage while you are signed in. Streams file deltas in the background; never blocks the structured-metadata sync lane.",
    category: "Cloud" as const,
    requiresRestart: true,
    // FEA-3907: superseded by the graduated "Data & Sync" level. Its runtime
    // value is now derived from that level (Full transcripts ⇒ on), so it no
    // longer renders as an independent Labs switch; the registry entry stays for
    // getFlag/setFlag soundness and the level-derived write path.
    hiddenFromLabs: true,
  },
  {
    // ISS-4556 / ISS-4559: shared web+desktop flag gating the Sessions
    // DISPLAYED-status SSOT. Read in the desktop MAIN process (the Local lane's
    // row status and Status facet live in `shared-agent-sessions-api.ts`, which
    // reads it through `displayed-status-parity-gate.ts`), and per-viewer through
    // PostHog on the cloud read path. Off by default (ISS-4779
    // closed-by-default). Aliases the shared `@repo/api`
    // `SESSIONS_DISPLAYED_STATUS_PARITY_FLAG_KEY` so this key and the cloud one
    // cannot drift — the KEY is shared, but the two switches are independent and
    // are not reconciled, so Local and Cloud can genuinely disagree during the
    // rollout. See the constant's own note above.
    key: DESKTOP_SESSIONS_DISPLAYED_STATUS_PARITY_FEATURE_FLAG_KEY,
    default: false,
    label: "Sessions Displayed Status Parity",
    description:
      'Makes the Sessions Status column, the Status sort, and the Status filter read from one derivation. A session waiting on your input reads "Waiting" instead of "Active" (matching the web app), and a session that ended while awaiting input is returned by the Active filter instead of being hidden from both Active and Waiting. Observable-only — it changes which status a row displays and which filter returns it, never the underlying data.',
    category: "Labs" as const,
  },
  {
    // PRD-566 / FEA-4348 (formerly FEA-3813 / PRD-553 M1): gates Routines (the
    // renamed "Scheduled Tasks" feature) — the local crewd scheduler host plus
    // the renderer nav entry/view. Off by default; restart-scoped because the
    // daemon is started once at boot and disposed at shutdown, so the toggle is
    // snapshotted at boot. The key is `"routines"`, equal to the PostHog flag so
    // the same key gates the feature on both surfaces.
    key: DESKTOP_ROUTINES_FEATURE_FLAG_KEY,
    default: false,
    label: "Routines",
    description:
      "Runs recurring routines in the background so they can fire on a cron schedule, with run history persisted to the local store, and shows the Routines management surface. Takes effect after an app restart.",
    category: "Labs" as const,
    requiresRestart: true,
  },
  {
    // FEA-3847 (PRD-556 M1): gates the in-app Audit Bot `audit:run` capability
    // (run a crewd review character against the open repo via the harness
    // cascade). Off by default; when off the IPC refuses the run before any
    // harness spawns. M1 ships no UI, so the generic Labs toggle is the only
    // opt-in — the findings surface lands in M2 (FEA-3848).
    key: DESKTOP_AUDIT_BOT_FEATURE_FLAG_KEY,
    default: false,
    label: "Audit Bot",
    description:
      "Runs a review character (Docs Darwin, Code Cassandra, Security Sentinel, or Perf Pathfinder) against the currently-open local repo on demand — scoped to docs, changed-since-main, or the whole repo — using the local harness cascade, and returns findings in-app to triage and file. Experimental. Nothing is filed until you explicitly capture it.",
    category: "Labs" as const,
  },
  {
    // FEA-3843 / PRD-555: desktop-only Labs flag gating the in-app Docs & Help
    // experience. M1 lands the bundle + local search index + `docs-help` IPC;
    // this flag stays dark until the Help view (M2), command-palette provider
    // (M3), and contextual "Help on this" anchors (M4) ship behind it. Off by
    // default so it dogfoods before graduating.
    key: DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY,
    default: false,
    label: "In-App Docs & Help",
    description:
      "Search and read the product docs inside the app — the Help view, command-palette docs answers, and contextual 'Help on this' links. Works offline from a bundled snapshot of the docs; use 'view latest online' for the freshest version.",
    category: "Labs" as const,
  },
  {
    // ISS-5808 (ISS-4779 closed-by-default): the Requests view re-reads events
    // and jobs while it is open, instead of showing its mount-time snapshot
    // forever, and names a failed read instead of rendering it as an empty
    // list. Off by default so an installed build keeps today's behavior until
    // someone opts in. Desktop-only surface — `apps/app` has no Gateway
    // Requests analogue, so there is no PostHog counterpart to keep in parity.
    key: DESKTOP_REQUESTS_LIVE_REFRESH_FEATURE_FLAG_KEY,
    default: false,
    label: "Live Requests View",
    description:
      "Keep the Requests view current while it is open: running and completed jobs refresh on their own instead of showing only what was there when you opened the page, and a job list that fails to load says so rather than reading as 'no running jobs'.",
    category: "Labs" as const,
  },
  {
    // ISS-5310 (ISS-4779 closed-by-default): the per-item gate over the Agents
    // destination, which moved back into the Labs section. Nested INSIDE the
    // `labsNav` container gate — this row only decides what shows once Labs
    // itself is on, which is also why the copy does not mention Labs: the row
    // is unreachable while Labs is off (ISS-5309 hides the whole tab), so a
    // "requires Labs" note could only ever be read by someone who had already
    // done it. Placed here, beside Routines / Audit Bot / In-App Docs & Help,
    // because those are the other flags that decide whether a whole DESTINATION
    // exists — appending it to the end of the registry buried it among
    // display-tweak flags.
    key: DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
    default: false,
    label: "Agents workspace",
    description:
      "Shows the Agents workspace, where you can browse the agents, sub-agents, skills, and tools your sessions used.",
    category: "Labs" as const,
  },
  {
    // FEA-4174 / PRD-545: gates Value Numerator 2.0 — the Pensero-powered
    // delivery-metrics numerator normalized onto session/branch/PR. This slice
    // lands only the server-side Pensero client (`@repo/pensero`); no renderer
    // consumer reads this key yet. Kept `hiddenFromLabs` so the Labs panel does
    // not render a switch that only persists a boolean while its copy claims to
    // power the numerator — the toggle is un-hidden by the slice that wires the
    // first gated consumer. Off by default (dark launch).
    key: DESKTOP_VALUE_NUMERATOR_V2_FEATURE_FLAG_KEY,
    default: false,
    label: "Value Numerator 2.0",
    description:
      "Powers the delivery-value numerator from Pensero's delivery metrics, normalized onto your sessions, branches, and PRs instead of per-person. Experimental — requires the Pensero integration to be configured server-side.",
    category: "Labs" as const,
    hiddenFromLabs: true,
  },
  {
    // ISS-6206 (ISS-4779 closed-by-default): gates the honest whole-app
    // cloud-readiness verdict — a lane that never ran no longer counts toward
    // "Up to date", and an outstanding backlog is reported per lane instead of
    // as one cross-lane total whose units do not add up. Off by default, so an
    // installed build keeps today's behavior until someone opts in.
    // Desktop-only surface, so the Labs toggle is the only opt-in.
    key: DESKTOP_STOPPED_LANE_READINESS_FEATURE_FLAG_KEY,
    default: false,
    label: "Honest cloud sync status",
    description:
      "Only say your history is up to date once every sync lane has actually run and delivered. A lane that is switched off or has not started yet reads as 'Checking…' instead of counting as synced, and a backlog is reported per kind — sessions, transcripts, comments — rather than as one combined number.",
    category: "Labs" as const,
  },
  {
    // ISS-4792 (ISS-4779 closed-by-default): gates the "DB ahead / update
    // required" banner (ISS-4714). Off by default — with it off the banner is
    // never rendered, matching the app's behavior before the in-flight UI
    // landed. When on, a runtime reporting the local DB is newer than this app
    // build surfaces the pinned update-required banner. Desktop-only, so the
    // generic Labs toggle is the only opt-in.
    key: DESKTOP_DB_AHEAD_BANNER_FEATURE_FLAG_KEY,
    default: false,
    label: "DB-ahead update banner",
    description:
      "Shows a prominent 'update required' banner when the local database was created by a newer version of Closedloop than the one you're running, so session parsing and cloud sync can't start until you update. Observable-only.",
    category: "Labs" as const,
  },
  {
    // ISS-4715: replaces the screen-owning first-import hero with a compact,
    // honest readiness sequence. The existing banner remains byte-for-byte
    // available behind the OFF path until this experience graduates.
    key: DESKTOP_STARTUP_READINESS_EXPERIENCE_FEATURE_FLAG_KEY,
    default: false,
    label: "Startup readiness experience",
    description:
      "Keeps saved sessions usable during startup while a compact readiness panel separately reports local history processing, view preparation, and cloud freshness. Observable-only.",
    category: "Labs" as const,
    requiresRestart: true,
    envOverride: "SYMPHONY_STARTUP_READINESS_EXPERIENCE",
  },
  {
    // GridTable v2 (ISS-4779 closed-by-default): shared web+desktop UI flag
    // gating the shared GridTable enhancement pass. Its web sibling is a
    // PostHog flag; registering the same kebab key here keeps desktop from
    // resolving it via the build-type dev default.
    key: DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY,
    default: false,
    label: "Grid table v2",
    description:
      "Adds a per-column options menu to every table header for sorting, filtering, grouping and moving that column, reveals the sort arrow when you hover a column instead of showing it all the time, lets you select and open a row from anywhere in it and walk the cells with the arrow keys, and adds a rows-per-page control so you can show 25, 50 or 100 rows at a time.",
    category: "Labs" as const,
  },
  {
    key: DESKTOP_SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
    default: false,
    label: "Sessions and Branches tab titles",
    // The window title, named plainly: on macOS the title bar is hidden, so this
    // shows up in the Window menu, Mission Control, and the Dock's window list
    // rather than on the window itself; Windows and Linux keep the native frame.
    description:
      "Names the window title after the Sessions or Branches page, or the session or branch, you have open, instead of the app name on every page.",
    category: "Labs" as const,
  },
  {
    // ISS-5534 (ISS-4779 closed-by-default): shared web+desktop UI flag gating
    // the Agents list Invocations summary card's plugin de-duplication. Off by
    // default — with it off the card sums invocations across every row exactly
    // as it does today. Its web sibling is a PostHog flag; registering the same
    // kebab key here keeps desktop from resolving it via the build-type dev
    // default.
    key: DESKTOP_AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY,
    default: false,
    label: "Agents invocations de-duplication",
    description:
      "Stops the Agents list's Invocations card counting a plugin's activity twice. A plugin is never run directly \u2014 its invocation count is the total of the skills and commands inside it \u2014 so on the All tab, where the plugin and those skills are both listed, today's total adds them up twice.",
    category: "Labs" as const,
  },
  {
    // ISS-4890 / ISS-4906 / ISS-4901 (ISS-4779 closed-by-default): shared
    // web+desktop UI flag gating the Sessions grid fold legibility pass. Off by
    // default — with it off no persisted column order is rewritten, the fold fit
    // tracks the live measured width, and the scroll region keeps the platform's
    // default (on macOS, at-rest-invisible) scrollbar. Its web sibling is a
    // PostHog flag; registering the same kebab key here keeps desktop from
    // resolving it via the build-type dev default.
    key: DESKTOP_SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY,
    default: false,
    label: "Sessions grid fold legibility",
    description:
      "Moves a saved column layout's Cost column back in front of the Sessions table's horizontal fold so its figure can't be cut mid-number, holds the columns still while you resize the window instead of stepping them sideways, and keeps the horizontal scrollbar visible so you can tell there are more columns to scroll to.",
    category: "Labs" as const,
  },
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
    // ISS-4773: shared web+desktop UI flag (kebab-case, PostHog key
    // "sessions-cost-billing-honesty"). The packaged desktop renderer has no
    // PostHog wiring, so unknown shared flags resolve to false in release builds
    // via `DesktopFeatureFlagProvider` — without this entry the desktop Sessions
    // card keeps presenting unconfirmed-billing usage as definite spend, leaving
    // the fix web-only. Off by default (ISS-4779 closed-by-default). ONE key
    // gates the label, the headline basis, the caption and the tooltip so the
    // card cannot show a confirmed-spend number under the old bucket label.
    key: DESKTOP_SESSIONS_COST_BILLING_HONESTY_FEATURE_FLAG_KEY,
    default: false,
    label: "Sessions Cost Billing Honesty",
    description:
      'The Sessions "Cost" card reports only spend actually billed to an API key, names the API-equivalent value your subscriptions delivered beneath it, and discloses any usage whose billing could not be determined instead of folding it into the headline as real cost. Display only — nothing about how a session\'s cost is computed changes.',
    category: "Labs" as const,
  },
  {
    // ISS-5842 (ISS-4779 closed-by-default): shared web+desktop UI flag gating
    // the unified delta-chip treatment on `MetricCard` and the Insights
    // `TrendBadge`. Those primitives render the Sessions strip, the Branches
    // strip and the first-launch dashboard here, and the packaged renderer has
    // no PostHog wiring, so without this entry the desktop could never opt in
    // and the change would land web-only — the exact one-surface leak the
    // closed-by-default policy exists to prevent. Off by default.
    key: DESKTOP_METRIC_DELTA_UNIFIED_PILL_FEATURE_FLAG_KEY,
    default: false,
    label: "Unified Metric Delta Pills",
    description:
      'Period-over-period change chips all render as the same pill — same shape and padding for a rise, a fall and a flat 0%, with only the colour differing — and drop the "better" / "worse" word beside the number. Display only: no metric, comparison or number changes.',
    category: "Labs" as const,
  },
  {
    // ISS-5005 (ISS-4779 closed-by-default): shared web+desktop UI flag gating
    // the Agents catalog's usage-bearing default sort. Off by default — with it
    // off the catalog opens on Component ascending and no stored view DIMENSION
    // is rewritten (only an inert `savedViewVersion: 0` marker is carried). Its
    // web sibling is a PostHog flag; registering the same kebab key here keeps
    // desktop from resolving it via the build-type dev default.
    // Observable-only: it changes which row is on top, never what was collected.
    key: DESKTOP_AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY,
    default: false,
    label: "Agents usage-first default sort",
    // See the sibling note on `agentsCountColumnAlignment`: the dependency is
    // enforced by `dependsOn`, so it no longer trails the description.
    description:
      "Opens the Agents catalog on the most-invoked components instead of alphabetically, where underscore-prefixed internal tools fill the first screen with zero-invocation rows. A saved view still on the untouched alphabetical default is moved once; any sort you picked yourself is left alone.",
    category: "Labs" as const,
    dependsOn: DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
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
    // ISS-6241 (ISS-4779 closed-by-default): gates the per-session count on the
    // import splash's live Compute step. Off by default — with it off the step
    // renders the bare activity dot it ships with today. Only the rebuild can
    // substantiate a population, so the flag makes counts VISIBLE where they
    // exist and changes nothing where they do not. Desktop-only: `apps/app` has
    // no import splash, so nothing can leak past a web flag.
    key: DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY,
    default: false,
    label: "Import splash compute count",
    description:
      "Shows how many sessions the post-import history rebuild has finished, out of how many it found, on the Compute step of the first-launch import panel. The rebuild can run for hours on a large history, and without a count a healthy long pass looks identical to a stuck one. The count appears only on the step that can actually measure itself; the artifact-link step keeps its activity dot.",
    category: "Labs" as const,
  },
  {
    // ISS-5112 (ISS-4779 closed-by-default): gates the guest-mode first run.
    // Off by default — with it off a signed-out device still meets the blocking
    // onboarding overlay on the Dashboard, unchanged. Desktop-only: there is no
    // pre-auth desktop first run on `apps/app`, so nothing can leak past a web
    // flag.
    key: DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY,
    default: false,
    label: "Guest-mode first run",
    description:
      "Lets a new user open the Dashboard and see their locally analyzed sessions before creating an account, instead of being asked to sign in first. Signing up is offered at the points where it actually unlocks something.",
    category: "Labs" as const,
  },
  {
    // ISS-5037 (ISS-4779 closed-by-default): the container gate over the whole
    // Labs nav section. `hiddenFromLabs` on purpose — its ONLY control is the
    // "Enable Labs" checkbox in the native application menu (`main/app-menu.ts`).
    // Rendering it as a generic Labs-panel row would defeat the easter egg and
    // be self-referential (a Labs toggle that hides Labs).
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
    // (kebab-case, PostHog key "agents-source-provenance-honesty"). The packaged
    // desktop renderer has no PostHog wiring, so an unregistered shared key falls
    // through to the build-type default — registering it here surfaces a Labs
    // toggle so desktop users opt in with the same key the web app reads. Both
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
    // packaged desktop renderer has no PostHog wiring, so an unregistered
    // shared key falls through to the build-type default — registering it here
    // surfaces a Labs toggle so desktop users opt in with the same key the web
    // app reads. Display-only: the server already ships the resolution state
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
    // flag (kebab-case, PostHog key "agents-detail-honesty"). The packaged
    // desktop renderer has no PostHog wiring, so an unregistered shared key
    // falls through to the build-type default — registering it here surfaces a
    // Labs toggle so desktop users opt in with the same key the web app reads.
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
    // (kebab-case, PostHog key "agents-type-tab-overflow"). The packaged desktop
    // renderer has no PostHog wiring, so an unregistered shared key falls
    // through to the build-type default — registering it here surfaces a Labs
    // toggle so desktop users opt in with the same key the web app reads.
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
    // prose makes the Labs panel nest the row under its parent and disable the
    // switch, instead of storing a choice that provably does nothing and can
    // then switch on by surprise when the parent is later enabled.
    dependsOn: DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
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
  {
    // ISS-5951 (ISS-4779 closed-by-default): shared web+desktop UI flag. The
    // Branch PR timeline's headline cost falls back to the rendered subtotal
    // when timing is incomplete OR when the branch has no authoritative total;
    // only the first was marked, so the second read as an authoritative figure.
    // Display only — the figure is identical either way.
    key: DESKTOP_BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY,
    default: false,
    label: "Branch Timeline Fallback Cost Marker",
    description:
      "On a Branch's PR timeline, marks the headline cost as incomplete whenever it is the rendered subtotal rather than the branch's own total — including when the branch has no total of its own — and reads the cost, LOC/$, and duration as Unavailable when the trace evidence behind them never arrived, instead of showing a figure nothing backs.",
    category: "Labs" as const,
  },
  {
    // ISS-5271 (ISS-4779 closed-by-default): shared web+desktop UI flag. The
    // Sessions and Total Tokens summary cards hold their frame and skeleton the
    // value slot when the usage summary has not loaded (and nothing errored),
    // instead of rendering a confident 0 for a number that was never computed
    // while the Cost card beside them honestly dashes. Display only — last-good
    // values held by the query cache are unaffected.
    key: DESKTOP_SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY,
    default: false,
    label: "Sessions Summary Honest Loading",
    description:
      "While the Sessions summary is still loading, the Sessions and Total Tokens cards show a loading placeholder instead of a zero that could be mistaken for a real count. Display only — the numbers themselves are unchanged.",
    category: "Labs" as const,
  },
  {
    // ISS-5125 (ISS-4779 closed-by-default): the member self-service install
    // affordance on the packs per-machine block. Gates an AFFORDANCE, not a
    // permission — every member already holds the install-to-own-machines
    // capability and the API already enforces node ownership.
    key: DESKTOP_MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY,
    default: false,
    label: "Install packs from the machines list",
    description:
      "Adds an Install button to each machine and harness row on a pack's page, so you can install the pack yourself instead of only seeing where it already stands. A row that is offline, unsupported, or already installing says why it has no button rather than leaving a blank space. Only your own machines are ever offered.",
    category: "Labs" as const,
  },
  {
    // ISS-5548 (ISS-4779 closed-by-default): the Session Timeline's
    // column-height hit target. The packaged desktop renderer has no PostHog
    // wiring, so an unregistered shared key resolves false in release builds and
    // the fix would never reach desktop. Only bars that HAVE somewhere to jump
    // grow a target, so this can never enlarge a dead one.
    key: DESKTOP_SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY,
    default: false,
    label: "Session Timeline column hit target",
    description:
      "Makes a Session Timeline bar as easy to click as a tall one. A quiet bucket draws a bar only a few pixels high, and today that sliver is the whole click target; this extends the target up the full column and outlines the column on hover so you can see what you are aiming at. The bar still shows its real size, and bars with nothing to jump to are left alone.",
    category: "Labs" as const,
  },
  {
    // ISS-5566: shared web+desktop UI flag (kebab-case, PostHog key
    // "session-timeline-synthesized-cost"). The packaged desktop renderer has
    // no PostHog wiring, so unknown shared flags resolve to false in release
    // builds via `DesktopFeatureFlagProvider` — without this entry desktop keeps
    // presenting synthesized cents as measured money and the disclosure would be
    // web-only. Off by default (ISS-4779 closed-by-default). ONE key withdraws
    // the fabricated figures AND adds the caption, so the strip cannot end up
    // silent about its provenance while still printing dollars, or captioned
    // while still contradicting itself.
    key: DESKTOP_SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY,
    default: false,
    label: "Session Timeline unmeasured-cost disclosure",
    description:
      "Stops the Session Timeline showing dollar amounts it never measured. When a session has no recorded per-bucket cost, the bars are reconstructed from the transcript — this hides the invented figures, keeps the bars as a picture of relative activity, and says so beneath the strip.",
    category: "Labs" as const,
  },
  {
    // ISS-5564 (ISS-4779 closed-by-default): the Activity breakdown's
    // confidence-basis footer sentence. The packaged desktop renderer has no
    // PostHog wiring, so an unregistered shared key resolves false in release
    // builds and the disclosure would never reach desktop. Additive copy only —
    // it changes no figure, and it renders only when a phase actually shows
    // `Conf. 0%` alongside a nonzero cost.
    key: DESKTOP_SESSION_PHASE_CONFIDENCE_DISCLOSURE_FEATURE_FLAG_KEY,
    default: false,
    label: "Activity breakdown confidence note",
    description:
      "Explains the confidence column in a session's Activity breakdown. When a phase is shown at 0% confidence but still carries real spend, a note says the dollars are measured and only the phase name is a guess — so a low confidence score is not read as doubt about the money.",
    category: "Labs" as const,
  },
  {
    // ISS-5841: one toggle for BOTH places activity phases show up on the
    // Session detail page -- the phases strip and the Timeline's "Activity
    // phase" Group-by cut. Rolled separately the page contradicts itself: a
    // menu offering to re-cut the chart by a phase model the page no longer
    // shows. Supersedes FEA-3906, which asked to delete the breakdown outright.
    key: DESKTOP_SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY,
    default: false,
    label: "Session activity phases",
    description:
      'Shows how a session\'s cost splits across activity phases: a phase strip under Properties, and an "Activity phase" option when grouping the cost chart. Off by default — phase cost analysis is being moved to the Branch screen.',
    category: "Labs" as const,
  },
] as const;

export type FlagKey = (typeof FEATURE_FLAGS_INTERNAL)[number]["key"];

export const FEATURE_FLAGS: readonly FlagDefinition[] = FEATURE_FLAGS_INTERNAL;

/**
 * ISS-4556: indexed once at module load rather than re-scanned per lookup.
 *
 * {@link getFlagDefinition} sits on the hot path of every
 * `SettingsStore.getFlag`, and the ISS-4556 displayed-status gate is read PER ROW
 * while folding a Sessions list — so a linear `find` over 39 definitions ran
 * thousands of times to answer a single page. The registry is a frozen `as const`
 * array built at module load, so an index derived from it cannot go stale.
 */
const FLAG_DEFINITIONS_BY_KEY: ReadonlyMap<string, FlagDefinition> = new Map(
  FEATURE_FLAGS.map((definition) => [definition.key, definition])
);

export function getFlagDefinition(key: FlagKey): FlagDefinition {
  const def = FLAG_DEFINITIONS_BY_KEY.get(key);
  if (!def) {
    throw new Error(`Unknown feature flag: ${key}`);
  }
  return def;
}

/** All flag keys as a Set for runtime membership checks. */
export const FLAG_KEYS: ReadonlySet<string> = new Set(
  FEATURE_FLAGS.map((f) => f.key)
);
