/**
 * @file agent-monitor-status.ts
 * @description The Agent Monitor runtime-status contract shared by the main
 * process (producer) and the renderer (consumer) across the
 * `desktop:get-runtime-status` IPC boundary.
 *
 * ISS-4714: when the local SQLite store carries a migration this app build does
 * not know about — a DB created by a NEWER Desktop build (a downgrade, a stale
 * auto-update, or dev running behind) — the migration runner refuses to open
 * the DB and the ENTIRE local runtime (parsing, and therefore transcript /
 * component cloud sync) is dead. Previously this failed silently with only a log
 * line. This contract surfaces that condition as a first-class runtime-status
 * field so the renderer can show a prominent, actionable "update required" state
 * instead of pretending sync is healthy.
 *
 * Pure data — no Electron, database, or filesystem dependency — so it is safe to
 * import from both the main process and the renderer bundle.
 */

/** Coarse health of the Agent Monitor local runtime. */
export const AgentMonitorRuntimeStatusKind = {
  /** The local DB runtime came up; parsing / sync can proceed. */
  Ready: "ready",
  /** Still initializing (no verdict yet). */
  Starting: "starting",
  /** Initialization permanently failed this process (DB stays closed). */
  Failed: "failed",
} as const;

export type AgentMonitorRuntimeStatusKind =
  (typeof AgentMonitorRuntimeStatusKind)[keyof typeof AgentMonitorRuntimeStatusKind];

/**
 * The Agent Monitor runtime-status projection carried in the runtime-status IPC
 * payload. Additive and optional at the boundary (an older renderer that never
 * reads it degrades to the pre-existing behavior; an older main process that
 * never sends it degrades to `undefined`, which the renderer treats as "no
 * failure to surface").
 */
export type AgentMonitorRuntimeStatus = {
  readonly kind: AgentMonitorRuntimeStatusKind;
  /**
   * True ONLY for the DB-ahead-of-app failure (the migration runner found a
   * migration this build does not include). Drives the prominent
   * "update required — your data is newer than this app" renderer state. Never
   * true unless `kind` is `Failed`.
   */
  readonly dbAhead: boolean;
  /**
   * A stable, user-facing failure reason (safe to display — no paths, SQL, or
   * migration names), or null when the runtime is not in a failed state.
   */
  readonly reason: string | null;
};

/** The pre-failure default: the runtime is still coming up, nothing to surface. */
export const STARTING_AGENT_MONITOR_RUNTIME_STATUS: AgentMonitorRuntimeStatus =
  {
    kind: AgentMonitorRuntimeStatusKind.Starting,
    dbAhead: false,
    reason: null,
  } as const;

/** The healthy runtime status once the local DB runtime is up. */
export const READY_AGENT_MONITOR_RUNTIME_STATUS: AgentMonitorRuntimeStatus = {
  kind: AgentMonitorRuntimeStatusKind.Ready,
  dbAhead: false,
  reason: null,
} as const;
