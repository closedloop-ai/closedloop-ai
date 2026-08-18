/**
 * @file migration-refusal.ts
 * @description The boot-safe migration-refusal contract: the refusal taxonomy,
 * the error the runner throws, and the sanitized user-facing message catalog.
 *
 * This lives OUTSIDE `src/main/database/` on purpose. The boot path
 * (`app.ts`) must surface a migration refusal as an Agent Monitor failure,
 * but the boundary guard (`scripts/dependency-cruiser.config.cjs`) forbids
 * boot files from statically importing the database runtime (`src/main/
 * database/**`, which transitively pulls in SQLite). Keeping the contract
 * here lets both the runner (producer) and the boot handler (consumer) share
 * it without dragging the DB runtime into the boot bundle. It is pure data and
 * branching — no database, filesystem, or Electron dependency.
 */

import {
  type AgentMonitorRuntimeStatus,
  AgentMonitorRuntimeStatusKind,
} from "../../shared/agent-monitor-status.js";

export const MigrationRefusalKind = {
  ChecksumDrift: "checksum_drift",
  Downgrade: "downgrade",
  BaselineMissing: "baseline_missing",
  HistoryGap: "history_gap",
} as const;

export type MigrationRefusalKind =
  (typeof MigrationRefusalKind)[keyof typeof MigrationRefusalKind];

/**
 * Thrown when the runner refuses to proceed. The boot path translates this
 * into a user-visible Agent Monitor failure (DB stays closed, no data touched).
 */
export class DesktopMigrationError extends Error {
  readonly kind: MigrationRefusalKind;
  constructor(kind: MigrationRefusalKind, message: string) {
    super(message);
    this.name = "DesktopMigrationError";
    this.kind = kind;
  }
}

/**
 * A stable, user-facing message for a migration refusal — safe to show in an OS
 * notification (no local paths, SQL, checksums, or migration names). The full
 * detail stays in the thrown error's `message` for logs/diagnostics.
 */
export function userFacingMigrationRefusal(kind: MigrationRefusalKind): string {
  switch (kind) {
    case MigrationRefusalKind.Downgrade:
      return "The local Agent Monitor database was created by a newer version of Closedloop. Please update to the latest version.";
    case MigrationRefusalKind.ChecksumDrift:
    case MigrationRefusalKind.HistoryGap:
      return "The local Agent Monitor database has an inconsistent migration history and can't be opened safely.";
    case MigrationRefusalKind.BaselineMissing:
      return "The Agent Monitor database couldn't be initialized due to an inconsistent app build.";
    default:
      return "The Agent Monitor database couldn't be opened.";
  }
}

/**
 * ISS-4714: true only for the DB-ahead-of-app failure — the forward-migration
 * guard found a migration this build does not include, meaning the local store
 * was created by a NEWER Desktop build (a downgrade, a stale auto-update, or dev
 * running behind). This is the one refusal a user resolves by updating the app,
 * so the renderer surfaces it as a prominent "update required" state. Every other
 * failure (checksum drift, history gap, a non-migration boot error) returns
 * false and stays a generic Agent-Monitor-unavailable state.
 */
export function isDbAheadOfAppError(error: unknown): boolean {
  return (
    error instanceof DesktopMigrationError &&
    error.kind === MigrationRefusalKind.Downgrade
  );
}

/**
 * ISS-4714: narrow an unknown value to a {@link MigrationRefusalKind}, or null
 * when it is not one of the closed set. Used at the DB-host process boundary
 * (`db-host-protocol` / `db-host-client`): the migration runs in the DB-host
 * `utilityProcess`, so a `DesktopMigrationError` it throws is flattened to a
 * plain serialized error (name/message/stack) crossing back to main and loses
 * its `kind`. The producer serializes the kind through this guard and the
 * consumer re-validates it here before rebuilding the typed error, so
 * `isDbAheadOfAppError` still classifies the DB-ahead case in production — not
 * only in the in-process test where the real class instance survives.
 */
export function toMigrationRefusalKind(
  value: unknown
): MigrationRefusalKind | null {
  for (const kind of Object.values(MigrationRefusalKind)) {
    if (kind === value) {
      return kind;
    }
  }
  return null;
}

/** The stable, low-cardinality telemetry message for a non-migration boot failure. */
const GENERIC_BOOT_FAILURE_TELEMETRY_MESSAGE =
  "Agent Monitor runtime failed to initialize";

/**
 * ISS-4714: build a STABLE, low-cardinality telemetry error for an Agent Monitor
 * boot failure, safe to emit through the app-exception path.
 *
 * The raw boot error is unsafe for telemetry: a `DesktopMigrationError`'s
 * `message` (and stack) carries the offending migration NAME and, for checksum
 * drift, checksum fragments — none of which the exception sanitizer redacts
 * (they are bare identifiers/hex, not paths/markers/secrets). Emitting the raw
 * error therefore leaks migration names into `exception.message` and makes the
 * event's cardinality data-dependent (one distinct message per store).
 *
 * This returns a fresh `Error` whose:
 *   - `name` is the stable exception TYPE tag (`"DesktopMigrationError"` for a
 *     refusal — a fixed low-cardinality value, NOT the migration name), and
 *   - `message` is a FIXED string per refusal kind (the already-sanitized
 *     user-facing copy, which carries no names/paths/checksums), with
 *   - no `stack` (so no file paths or SQL ride along).
 *
 * The full raw detail still reaches the logs at the call site; only the
 * telemetry projection is stabilized.
 */
export function buildMigrationFailureTelemetryError(error: unknown): Error {
  if (error instanceof DesktopMigrationError) {
    const stable = new Error(userFacingMigrationRefusal(error.kind));
    stable.name = error.name;
    stable.stack = undefined;
    return stable;
  }
  const stable = new Error(GENERIC_BOOT_FAILURE_TELEMETRY_MESSAGE);
  stable.stack = undefined;
  return stable;
}

/** The generic Agent Monitor boot-failure reason shown when the cause isn't a refusal. */
const GENERIC_AGENT_MONITOR_FAILURE_REASON =
  "The Agent Monitor could not start. See logs for details.";

/**
 * ISS-4714: map an Agent Monitor boot error to the first-class runtime status
 * the renderer branches on (`desktop:get-runtime-status`). Lives here in the
 * boot-safe lifecycle module (not inlined in `app.ts`) so the classification —
 * a migration refusal's `kind` → the `dbAhead` flag and the sanitized,
 * user-facing `reason` — has one owner shared by the boot handler and its tests.
 *
 * `dbAhead` is honored ONLY for the DB-ahead (Downgrade) refusal, so a checksum
 * drift, a history gap, or any non-migration boot error stays a generic
 * Agent-Monitor-unavailable failure. The `reason` is always a stable, sanitized
 * string safe to display (no paths, SQL, or migration names).
 */
export function buildAgentMonitorFailureStatus(
  error: unknown
): AgentMonitorRuntimeStatus {
  const reason =
    error instanceof DesktopMigrationError
      ? userFacingMigrationRefusal(error.kind)
      : GENERIC_AGENT_MONITOR_FAILURE_REASON;
  return {
    kind: AgentMonitorRuntimeStatusKind.Failed,
    dbAhead: isDbAheadOfAppError(error),
    reason,
  };
}
