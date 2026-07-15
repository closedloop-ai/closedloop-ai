/**
 * Feature flag registry — single source of truth for all boolean feature flags.
 *
 * Adding a new flag: append an entry to FEATURE_FLAGS. The key must match the
 * corresponding field on DesktopSettings in contracts.ts. The registry drives
 * the Feature Flags settings panel and the generic getFlag/setFlag accessors
 * in settings-store.ts.
 */

export type FlagDefinition = {
  key: string;
  default: boolean;
  label: string;
  description: string;
  category: "Cloud" | "Diagnostics" | "Experimental" | "Labs" | "Security";
  /** If true, flag requires an app restart to take full effect. */
  requiresRestart?: boolean;
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
export const DESKTOP_FIRST_PARTY_AUTH_FEATURE_FLAG_KEY =
  "desktopFirstPartyAuthEnabled";
export const DESKTOP_TRANSCRIPT_SYNC_FEATURE_FLAG_KEY = "transcriptSyncEnabled";
/**
 * Shared web+desktop UI flag (kebab-case, PostHog convention) that gates the
 * collapsible session-details comments rail (FEA-2479). The shared
 * `AgentSessionDetailView` resolves it via `useFeatureFlagEnabled`. Registering
 * it here — rather than relying on the dev-only unknown-flag fallback in
 * `DesktopFeatureFlagProvider` — is what turns the feature on in packaged
 * builds. Must stay byte-for-byte equal to
 * `SESSION_COMMENTS_RAIL_COLLAPSE_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`; the literal is redeclared here
 * (instead of imported) to keep this main-process module free of the
 * `@repo/app`/`@repo/api` transitive graph.
 */
export const DESKTOP_SESSION_COMMENTS_RAIL_COLLAPSE_FEATURE_FLAG_KEY =
  "session-comments-rail-collapse";
/**
 * Shared web+desktop UI flag (kebab-case, PostHog convention) that gates the
 * FEA-3120 read-source indicator badge on the Sessions and Branches toolbars.
 * The packaged desktop renderer has no PostHog wiring, so unknown shared flags
 * resolve to false in release builds via `DesktopFeatureFlagProvider` — hiding
 * the badge that shows fine on web. Registering it here surfaces a Labs toggle
 * so QA/support can opt in on desktop. Must stay byte-for-byte equal to
 * `READ_SOURCE_INDICATOR_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`; the literal is redeclared here
 * (instead of imported) to keep this main-process module free of the
 * `@repo/app`/`@repo/api` transitive graph.
 */
export const DESKTOP_READ_SOURCE_INDICATOR_FEATURE_FLAG_KEY =
  "read-source-indicator";
/**
 * Shared web+desktop UI flag (kebab-case, PostHog convention) that surfaces
 * Tools, MCPs, and Hooks as first-class kinds in the Agents listing (FEA-3152).
 * The packaged desktop renderer has no PostHog wiring, so unknown shared flags
 * resolve to false in release builds via `DesktopFeatureFlagProvider` — keeping
 * these kinds scoped-out (reachable only via the "All" tab). Registering it here
 * surfaces a Labs toggle so users can opt in on desktop. Off by default; the
 * shared `AgentsGroupedList` gates on
 * `useFeatureFlagEnabled("agents-show-tools-mcps-hooks")`. Observable-only — the
 * flag only affects listing visibility, never promote/catalog/distribution. Must
 * stay byte-for-byte equal to `AGENTS_SHOW_TOOLS_MCPS_HOOKS_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`; the literal is redeclared here
 * (instead of imported) to keep this main-process module free of the
 * `@repo/app`/`@repo/api` transitive graph.
 */
export const DESKTOP_AGENTS_SHOW_TOOLS_MCPS_HOOKS_FEATURE_FLAG_KEY =
  "agents-show-tools-mcps-hooks";

const FEATURE_FLAGS_INTERNAL = [
  {
    key: "agentMonitorEnabled" as const,
    default: true,
    label: "Agent Dashboard",
    description:
      "Runs the local SQLite-backed Agent Dashboard that powers the Dashboard and agent views in the sidebar.",
    category: "Diagnostics" as const,
    requiresRestart: true,
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
    key: "commandSigningEnforcementEnabled" as const,
    default: false,
    label: "Trusted Browser Enforcement",
    description:
      "Requires browser commands to carry an approved signing key before execution.",
    category: "Security" as const,
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
    // Coordination requirement (FEA-2686): this desktop-local flag only reveals
    // the sign-in surface — the browser page it opens is gated separately by the
    // web PostHog flag `desktop-loopback-auth`. Enable this only once that web
    // flag is at 100% for the target users, or sign-in dead-ends on the web
    // "Not available" page. Keep the two flags in lockstep.
    key: DESKTOP_FIRST_PARTY_AUTH_FEATURE_FLAG_KEY,
    default: false,
    label: "Account Sign-In",
    description:
      'Shows the Settings → Account panel for signing this device in to Closedloop with your browser (first-party desktop auth). Requires the web `desktop-loopback-auth` flag to be enabled for you first — otherwise browser sign-in reads "Not available".',
    category: "Security" as const,
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
    // from the 256 KiB structured-metadata lane (`agentMonitorEnabled`).
    key: DESKTOP_TRANSCRIPT_SYNC_FEATURE_FLAG_KEY,
    default: false,
    label: "Transcript Sync",
    description:
      "Archives full Claude Code / Codex session transcripts (main + subagent) to Closedloop cloud storage while you are signed in. Streams file deltas in the background; never blocks the structured-metadata sync lane.",
    category: "Cloud" as const,
    requiresRestart: true,
  },
  {
    // FEA-2479: shared web+desktop UI flag (kebab-case). Default ON so the
    // collapsible comments rail ships in packaged Desktop builds — without an
    // entry here `DesktopFeatureFlagProvider` resolves unknown flags to false
    // in packaged builds, leaving the collapse control permanently unreachable.
    // Not a persisted DesktopSettings field; it has no Labs toggle and always
    // resolves to this default via the registry.
    key: DESKTOP_SESSION_COMMENTS_RAIL_COLLAPSE_FEATURE_FLAG_KEY,
    default: true,
    label: "Collapsible Comments Rail",
    description:
      "Adds a collapse control and re-open handle to the session-details comments rail so readers can reclaim horizontal space.",
    category: "Experimental" as const,
    hiddenFromLabs: true,
  },
  {
    // FEA-2923: shared web+desktop UI flag (PostHog key "agents"). The packaged
    // desktop renderer has no PostHog wiring, so unknown shared flags resolve to
    // false in release builds — hiding the Agents nav entry that shows fine on
    // web. Registering it here surfaces a Labs toggle so users can opt in.
    // Off by default; `App.tsx` gates the Agents nav on
    // `useFeatureFlagEnabled("agents")`. Must stay byte-for-byte equal to
    // `AGENTS_FEATURE_FLAG_KEY` in `packages/api/src/types/agent-session.ts`.
    key: "agents" as const,
    default: false,
    label: "Agents Workspace",
    description:
      "Shows the Agents workspace in the sidebar — browse agent components, sessions, and usage across your repositories.",
    category: "Labs" as const,
  },
  {
    // FEA-3120: shared web+desktop UI flag (kebab-case, PostHog key
    // "read-source-indicator"). The packaged desktop renderer has no PostHog
    // wiring, so unknown shared flags resolve to false in release builds —
    // hiding the Local/Cloud/Fallback badge on the Sessions and Branches
    // toolbars that shows fine on web. Registering it here surfaces a Labs
    // toggle so QA/support can opt in. Off by default; the toolbars gate on
    // `useFeatureFlagEnabled("read-source-indicator")`. Must stay byte-for-byte
    // equal to `READ_SOURCE_INDICATOR_FEATURE_FLAG_KEY` in
    // `packages/app/shared/lib/feature-flags.ts`.
    key: DESKTOP_READ_SOURCE_INDICATOR_FEATURE_FLAG_KEY,
    default: false,
    label: "Read-Source Indicator",
    description:
      "Shows a small Local/Cloud/Fallback badge on the Sessions and Branches toolbars indicating which store the surface read from, so QA/support can tell a data bug from a sync gap.",
    category: "Diagnostics" as const,
  },
  {
    // FEA-3152: shared web+desktop UI flag (kebab-case, PostHog key
    // "agents-show-tools-mcps-hooks"). The packaged desktop renderer has no
    // PostHog wiring, so unknown shared flags resolve to false in release builds
    // — keeping Tools/MCPs/Hooks scoped-out of the Agents type-tab bar.
    // Registering it here surfaces a Labs toggle so users can opt in. Off by
    // default; the shared `AgentsGroupedList` gates on
    // `useFeatureFlagEnabled("agents-show-tools-mcps-hooks")`. Observable-only —
    // never adds these kinds to promote/catalog/distribution. Must stay
    // byte-for-byte equal to `AGENTS_SHOW_TOOLS_MCPS_HOOKS_FEATURE_FLAG_KEY` in
    // `packages/app/shared/lib/feature-flags.ts`.
    key: DESKTOP_AGENTS_SHOW_TOOLS_MCPS_HOOKS_FEATURE_FLAG_KEY,
    default: false,
    label: "Tools, MCPs & Hooks in Agents",
    description:
      "Surfaces Tools, MCPs, and Hooks as first-class rows in the Agents listing (alongside Agents, Commands, Skills, and Plugins). Observable-only — these are shown for visibility, not promoted or distributed. Requires the Agents Workspace.",
    category: "Labs" as const,
  },
] as const;

export type FlagKey = (typeof FEATURE_FLAGS_INTERNAL)[number]["key"];

export const FEATURE_FLAGS: readonly FlagDefinition[] = FEATURE_FLAGS_INTERNAL;

export function getFlagDefinition(key: FlagKey): FlagDefinition {
  const def = FEATURE_FLAGS.find((f) => f.key === key);
  if (!def) {
    throw new Error(`Unknown feature flag: ${key}`);
  }
  return def;
}

/** All flag keys as a Set for runtime membership checks. */
export const FLAG_KEYS: ReadonlySet<string> = new Set(
  FEATURE_FLAGS.map((f) => f.key)
);
