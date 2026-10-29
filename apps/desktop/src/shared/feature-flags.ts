/**
 * Feature flag registry — single source of truth for all boolean feature flags.
 *
 * A web+desktop UI gate is NOT a registry flag: it is one PostHog key, read
 * through the feature-flag port, with no entry here (root `AGENTS.md`; the
 * entries in `feature-flags-shared-ui.ts` are legacy).
 *
 * Adding a new flag: put its key AND its registry entry in the sibling module
 * that owns the concern — `feature-flags-collection.ts` for a local-collection
 * gate, `feature-flags-labs-surfaces.ts` for an app-shell or list/table gate,
 * `feature-flags-labs-detail.ts` for a metric or detail-disclosure gate — so the
 * addition stays one file. Only a flag none of them covers is appended here.
 * The registry drives the generic getFlag/setFlag accessors in
 * settings-store.ts and the few dedicated Settings surfaces that still read a
 * category subset.
 *
 * THAT ENTRY IS ONE OF SIX EDITS, NOT ONE. The other five — the
 * `DesktopSettings` member, its `DEFAULT_DESKTOP_SETTINGS` default,
 * `LABS_SETTING_KEY_LEDGER`, `LEDGER_HISTORICAL_KEYS`, and
 * `REGISTRY_MEMBERSHIP_WITNESS` — are enumerated with the guard that reddens for each
 * in `apps/desktop/test/labs-setting-key-ledger.test.ts` (ISS-8071). Read that
 * manifest before you start; "five" was the working number until PR #5989 was
 * failed by the sixth.
 *
 * The extracted modules are still spread in their historical positions so the
 * hand-maintained witness remains easy to reconcile after retirements. This is
 * no longer a rendered ordering contract: ISS-8753 deleted Settings -> Labs, so
 * no UI builds its row order from this composed array.
 *
 * TWO CLASSES OF KEY LIVE HERE, and they have different obligations (#4739
 * review, whitlockk — this note used to state only the first, which read as a
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

import { AGENTS_CARD_ATTRIBUTE_LABELS_FLAG_KEY } from "@repo/api/src/types/agents-card-attribute-labels-flag";
import { AGENTS_NAV_FLAG_KEY } from "@repo/api/src/types/agents-nav-flag";
import { BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY } from "@repo/api/src/types/branch-timeline-cost-fallback-marker-flag";
import { BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY } from "@repo/api/src/types/branches-cohort-transparency-flag";
import { BRANCHES_SUMMARY_HONEST_LOADING_FLAG_KEY } from "@repo/api/src/types/branches-summary-honest-loading-flag";
import { MEMBER_SELF_SERVICE_INSTALL_FLAG_KEY } from "@repo/api/src/types/member-self-service-install-flag";
import { SESSION_CLAUDE_REPORTED_COST_FLAG_KEY } from "@repo/api/src/types/session-claude-reported-cost-flag";
import { SESSION_LAUNCH_ATTRIBUTION_FLAG_KEY } from "@repo/api/src/types/session-launch-attribution-flag";
import { SESSION_METRIC_POPULATION_DISCLOSURE_FLAG_KEY } from "@repo/api/src/types/session-metric-population-disclosure-flag";
import { SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY } from "@repo/api/src/types/session-timeline-coverage-disclosure-flag";
import { SESSION_TOKENS_RECORDED_HONESTY_FLAG_KEY } from "@repo/api/src/types/session-tokens-recorded-honesty-flag";
import { SESSION_TOUCHED_BRANCHES_FLAG_KEY } from "@repo/api/src/types/session-touched-branches-flag";
import { SESSION_TRACE_EVIDENCE_DISCLOSURE_FLAG_KEY } from "@repo/api/src/types/session-trace-evidence-disclosure-flag";
import { SESSION_TRACE_IDLE_ROWS_FLAG_KEY } from "@repo/api/src/types/session-trace-idle-rows-flag";
import { SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY } from "@repo/api/src/types/session-transcript-never-expected-flag";
import { SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY } from "@repo/api/src/types/sessions-summary-honest-loading-flag";
import { DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY } from "./desktop-docs-help-flag.js";
import { DESKTOP_REQUESTS_LIVE_REFRESH_FEATURE_FLAG_KEY } from "./desktop-requests-live-refresh-flag.js";
import { COLLECTION_FEATURE_FLAGS } from "./feature-flags-collection.js";
import { LABS_DETAIL_FEATURE_FLAGS } from "./feature-flags-labs-detail.js";
import { LABS_SURFACE_FEATURE_FLAGS } from "./feature-flags-labs-surfaces.js";
import { SHARED_UI_FEATURE_FLAGS } from "./feature-flags-shared-ui.js";

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
   * enforces — a future generic flag surface would read this to nest the row
   * under its parent and DISABLE its switch while the parent is off, so a user
   * cannot flip a toggle
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
   * exposed through a generic settings toggle. Use for flags that are not
   * user-set (shared kebab-case UI flags resolved via `useFeatureFlagEnabled`)
   * or that already have a dedicated, purpose-built control elsewhere (e.g. the
   * Relay/Gateway tab), so a future generic flag surface does not duplicate
   * them and desync the two controls.
   */
  hiddenFromLabs?: boolean;
};

export const DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY = "agentCoachingTips";
export const DESKTOP_AGENT_COACHING_PACKS_FEATURE_FLAG_KEY =
  "agentCoachingPacks";
export const DESKTOP_TRANSCRIPT_SYNC_FEATURE_FLAG_KEY = "transcriptSyncEnabled";
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
 * ISS-5271 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the Sessions summary cards' honest never-loaded state — an absent
 * usage summary (no error) skeletons the Sessions/Total Tokens value slots
 * instead of rendering a confident `0` beside a Cost card that dashes. The
 * renderer reads the signed-in PostHog assignment, so this shared key stays paired with its web counterpart. Aliases the shared `@repo/api` constant rather than redeclaring the
 * literal, so a rename touches one definition.
 */
export const DESKTOP_SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY =
  SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY;

/** Shared key for the closed-by-default Branch timeline cost-evidence gate. */
export const DESKTOP_BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY =
  BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY;
/** Shared default-off key for the finite-window Branch cohort explanation. */
export const DESKTOP_BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY =
  BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY;
/** Shared default-off key for the Branches summary never-loaded state. */
export const DESKTOP_BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY =
  BRANCHES_SUMMARY_HONEST_LOADING_FLAG_KEY;
/** Shared default-off key for the session-detail Claude-reported cost row. */
export const DESKTOP_SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY =
  SESSION_CLAUDE_REPORTED_COST_FLAG_KEY;
/** Shared default-off key for the session-detail launch-attribution rows. */
export const DESKTOP_SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY =
  SESSION_LAUNCH_ATTRIBUTION_FLAG_KEY;
/**
 * ISS-5637 (ISS-4779 closed-by-default): shared web+desktop UI flag gating the
 * session-detail Tokens row telling an unrecorded token count apart from a
 * measured zero. The renderer reads the signed-in PostHog assignment, so this shared key stays paired with its web counterpart. The desktop is a
 * PRODUCER of the defect as well as a surface for it — `sumTokenUsage` folds out
 * of `zeroTotals()`, so a local session with no token-usage rows is exactly the
 * four zeros the row used to assert as measurements. Aliases the shared
 * `@repo/api` constant rather than redeclaring the literal.
 */
export const DESKTOP_SESSION_TOKENS_RECORDED_HONESTY_FEATURE_FLAG_KEY =
  SESSION_TOKENS_RECORDED_HONESTY_FLAG_KEY;
/**
 * ISS-7737 (ISS-4779 closed-by-default): shared web+desktop UI flag gating the
 * session-detail Properties rows that name the population each figure counts.
 * The renderer reads the signed-in PostHog assignment, so this shared key stays paired with its web counterpart. Desktop is a PRODUCER of the mismatch
 * as well as a surface for it — its own parser writes `agent_turns` from the
 * parent transcript while folding token usage over every delegated subagent
 * file. Aliases the shared `@repo/api` constant rather than redeclaring the
 * literal.
 */
export const DESKTOP_SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY =
  SESSION_METRIC_POPULATION_DISCLOSURE_FLAG_KEY;
/**
 * ISS-7427 (ISS-4779 closed-by-default policy): the Session Trace header's
 * evidence disclosure, on the shared `AgentSessionDetailView` the desktop
 * renderer mounts. Desktop is a PRODUCER of this state as well as a surface for
 * it: `syncTierAllowsTranscripts` permits the transcript lane only on the `full`
 * sync tier, so a `metadata`-tier device serves metrics with no main transcript
 * permanently and by the user's own recorded choice (ISS-7516). Aliases the
 * shared `@repo/api` constant rather than redeclaring the literal.
 */
export const DESKTOP_SESSION_TRACE_EVIDENCE_DISCLOSURE_FEATURE_FLAG_KEY =
  SESSION_TRACE_EVIDENCE_DISCLOSURE_FLAG_KEY;
/**
 * ISS-8652 (ISS-4779 closed-by-default policy): the Session Trace's idle rows,
 * on the shared `SessionTrace` the desktop renderer mounts from both the Session
 * detail transcript panel and the branch merged trace. The renderer resolves
 * this shared key from the signed-in account's PostHog assignment — the same key
 * space the web app reads — so the pause cannot stay invisible on desktop after
 * web opened it; this entry carries only the key's default-off main-process
 * settings metadata. Aliases the
 * shared `@repo/api` constant rather than redeclaring the literal.
 */
export const DESKTOP_SESSION_TRACE_IDLE_ROWS_FEATURE_FLAG_KEY =
  SESSION_TRACE_IDLE_ROWS_FLAG_KEY;
/**
 * ISS-7427 AC5 (ISS-4779 closed-by-default policy): the Session Timeline's
 * coverage disclosure, on the shared `AgentSessionDetailView` the desktop
 * renderer mounts. The renderer resolves this shared key from the signed-in
 * account's PostHog assignment — the same key space the web app reads — so the
 * caption cannot leak on desktop while hidden on web, or stay dark on desktop
 * after web opens it. Aliases the shared `@repo/api`
 * constant rather than redeclaring the literal.
 */
export const DESKTOP_SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY =
  SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY;
/**
 * ISS-8427 (ISS-4779 closed-by-default): the session-detail "Branches" row, on
 * the shared `SessionPropertiesPanel` the desktop renderer mounts through
 * `AgentSessionDetailView`. The renderer resolves this shared key from the
 * signed-in account's PostHog assignment — the same key space the web app reads
 * — so the plural row cannot leak on desktop while hidden on web. Aliases
 * the shared `@repo/api` constant rather than redeclaring the literal.
 */
export const DESKTOP_SESSION_TOUCHED_BRANCHES_FEATURE_FLAG_KEY =
  SESSION_TOUCHED_BRANCHES_FLAG_KEY;
/**
 * ISS-7516 (ISS-4779 closed-by-default): shared web+desktop UI flag gating the
 * session-detail transcript panel's NEVER-EXPECTED absence state — the settled
 * "this machine's data sync level keeps transcripts local, so this one is never
 * coming", as distinct from the not-yet-arrived "It'll show up here once the
 * source machine uploads it".
 *
 * Aliased from the canonical `@repo/api` leaf rather than redeclared as a
 * literal, so the desktop registry key and the PostHog key both surfaces read
 * cannot drift.
 */
export const DESKTOP_SESSION_TRANSCRIPT_NEVER_EXPECTED_FEATURE_FLAG_KEY =
  SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY;
/**
 * ISS-5532 (ISS-4779 closed-by-default): shared web+desktop UI flag gating the
 * Agents catalog card NAMING the attributes it promotes into its header, so a
 * promoted value is not left anonymous beside the component name.
 *
 * `AgentsTable` is the desktop Agents view as well as the web one, and the
 * desktop window resizes below the width that swaps the grid for cards. The
 * renderer reads the signed-in PostHog assignment, so this shared key stays paired with its web counterpart. Aliases the shared `@repo/api`
 * {@link AGENTS_CARD_ATTRIBUTE_LABELS_FLAG_KEY} constant rather than
 * redeclaring the literal, so a rename touches one definition.
 */
export const DESKTOP_AGENTS_CARD_ATTRIBUTE_LABELS_FEATURE_FLAG_KEY =
  AGENTS_CARD_ATTRIBUTE_LABELS_FLAG_KEY;
/**
 * ISS-5125 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the MEMBER self-service install affordance on the packs per-machine
 * block. Off, the block is the FEA-4077 read-only status list; on, an
 * actionable (machine × harness) cell carries an Install/Retry control.
 *
 * The desktop renderer mounts the same block (via `PluginsPanel` →
 * `PacksWorkspace` → `PackDetail`) and resolves this shared key from the
 * signed-in account's PostHog assignment — the same key space the web app
 * reads — so the affordance cannot leak on desktop while hidden on web. Aliases the shared `@repo/api` constant rather than redeclaring the
 * literal, so a rename touches one definition.
 */
export const DESKTOP_MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY =
  MEMBER_SELF_SERVICE_INSTALL_FLAG_KEY;
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
 * there is no second web surface to keep in parity. The renderer still resolves
 * this key from the signed-in account's PostHog assignment, like every other UI
 * gate. Registered here so getFlag/setFlag type casts remain sound.
 */
export const DESKTOP_SESSION_DETAIL_READ_SOURCE_FEATURE_FLAG_KEY =
  "session-detail-read-source";
/**
 * ISS-5310 (ISS-4779 closed-by-default): desktop-owned per-item Labs flag over
 * the Agents destination — the sidebar entry AND `#/agents`.
 *
 * Agents moved out of Artifacts and back into the Labs section, so this flag
 * sits INSIDE {@link DESKTOP_LABS_NAV_FEATURE_FLAG_KEY} rather than beside it:
 * the container gate wins, and this one only decides what shows once Labs is
 * already on.
 *
 * ISS-5041/ISS-7835 made this key CROSS-SURFACE. It was desktop-only when
 * ISS-5310 landed, because the web sidebar carried Agents always-on; the web app
 * now gates its own Agents nav destination and `/agents` routes on the
 * byte-for-byte identical key via PostHog (`AGENTS_NAV_FEATURE_FLAG_KEY`,
 * `packages/app/shared/lib/feature-flags.ts`), so the two halves must stay in
 * parity — see the parity row in `test/feature-flags-cross-surface.test.ts`.
 *
 * Aliases the `@repo/api` {@link AGENTS_NAV_FLAG_KEY} rather than holding the
 * literal, the same way every other shared key here does. That module is
 * dependency-free, so `feature-flags-shared-ui.ts` and
 * `feature-flags-labs-detail.ts` — which both name this key in `dependsOn` and
 * must not import this module back — reach it directly without making the split
 * cyclic. ISS-5041 retired the desktop-local leaf that used to serve that
 * purpose; the string exists in exactly one place, and now it is the place BOTH
 * surfaces read.
 */
export const DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY = AGENTS_NAV_FLAG_KEY;
const FEATURE_FLAGS_INTERNAL = [
  ...COLLECTION_FEATURE_FLAGS,
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
    key: "cloudConnectionEnabled" as const,
    default: true,
    label: "Cloud Connection",
    description:
      "Enables the Socket.IO relay connection to the Closedloop cloud control plane.",
    category: "Cloud" as const,
    // Dedicated "Cloud Connection" switch in the Relay/Gateway tab owns this
    // operational control; keep it out of the generic flag surface to avoid a
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
    // this operational kill-switch; keep it out of the generic flag surface.
    hiddenFromLabs: true,
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
    key: "terminalInstallFailureNotifications" as const,
    default: false,
    label: "Uninstallable Plugin Notifications",
    description:
      "Shows a desktop notification the first time a required plugin turns out to be one this build cannot install, naming the remedy.",
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
    // while it is open, instead of showing its mount-time snapshot
    // forever, and names a failed read instead of rendering it as an empty
    // list. Off by default so an installed build keeps today's behavior until
    // someone opts in. Desktop-only surface — `apps/app` has no Gateway
    // Requests analogue, so there is no PostHog counterpart to keep in parity.
    key: DESKTOP_REQUESTS_LIVE_REFRESH_FEATURE_FLAG_KEY,
    default: false,
    label: "Live Requests View",
    description:
      "Keep the Requests view current while it is open instead of showing only what was there when you opened the page.",
    category: "Labs" as const,
  },
  {
    // ISS-5310 (ISS-4779 closed-by-default): the per-item gate over the Agents
    // destination, which moved back into the Labs section. Nested INSIDE the
    // `labsNav` container gate — this row only decides what shows once Labs
    // itself is on, which is also why the copy does not mention Labs: the row
    // is unreachable while Labs is off (ISS-5309 hides the whole tab), so a
    // "requires Labs" note could only ever be read by someone who had already
    // done it. Placed here, beside In-App Docs & Help, because that is the
    // other flag that decides whether a whole DESTINATION exists — appending it
    // to the end of the registry buried it among display-tweak flags.
    key: DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
    default: false,
    label: "Agents workspace",
    description:
      "Shows the Agents workspace, where you can browse the agents, sub-agents, skills, and tools your sessions used.",
    category: "Labs" as const,
  },
  ...LABS_SURFACE_FEATURE_FLAGS,
  ...LABS_DETAIL_FEATURE_FLAGS,
  // LAST, exactly where the extracted block sat before ISS-5637 split it out.
  // Kept there for review stability and witness readability only. Settings ->
  // Labs and its grouping test are gone, so moving this block is no longer a UI
  // behavior change.
  ...SHARED_UI_FEATURE_FLAGS,
] as const;

export type FlagKey = (typeof FEATURE_FLAGS_INTERNAL)[number]["key"];

export const FEATURE_FLAGS: readonly FlagDefinition[] = FEATURE_FLAGS_INTERNAL;

/**
 * ISS-4556: indexed once at module load rather than re-scanned per lookup.
 *
 * {@link getFlagDefinition} sits on the hot path of every
 * `SettingsStore.getFlag`, which a Sessions-list fold can reach once per row — so
 * a linear `find` over 39 definitions ran thousands of times to answer a single
 * page. The registry is a frozen `as const` array built at module load, so an
 * index derived from it cannot go stale.
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
