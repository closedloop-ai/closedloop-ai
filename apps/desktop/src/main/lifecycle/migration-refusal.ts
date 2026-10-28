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

import { AppBootFailureKind } from "@closedloop-ai/telemetry-contract/app-boot-failure-kind";
import {
  type AgentMonitorRuntimeStatus,
  AgentMonitorRuntimeStatusKind,
} from "../../shared/agent-monitor-status.js";
import { isStoreOpenTimeoutError } from "../../shared/transient-db-host-error.js";

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
    const stable = new Error(migrationRefusalTelemetryMessage(error.kind));
    stable.name = error.name;
    stable.stack = undefined;
    return stable;
  }
  const stable = new Error(
    NON_REFUSAL_BOOT_FAILURE_TELEMETRY_MESSAGE[
      classifyNonRefusalBootFailureKind(error)
    ]
  );
  stable.stack = undefined;
  return stable;
}

/**
 * ISS-6339: the TELEMETRY message per refusal kind — one fixed, low-cardinality
 * string each, distinct for every member of {@link MigrationRefusalKind}.
 *
 * Deliberately NOT {@link userFacingMigrationRefusal}. That catalog answers
 * checksum drift and a history gap with the SAME sentence, correctly: a user's
 * remedy is identical either way, and there is nothing to gain from making them
 * read the difference. But the two failures have opposite causes — drift means
 * the bytes of an applied migration changed (corruption, or an edited merged
 * migration), a gap means this build's manifest is missing a migration the store
 * already applied (version skew) — and routing both through the same telemetry
 * message left the field unable to tell them apart, which is the gap ISS-6339
 * names. Splitting here fixes the diagnosis without touching a word the user
 * sees.
 *
 * Fixed strings, never the raw refusal message: the thrown message carries the
 * migration name and, for drift, checksum fragments (see
 * {@link buildMigrationFailureTelemetryError}).
 */
const MIGRATION_REFUSAL_TELEMETRY_MESSAGE: Record<
  MigrationRefusalKind,
  string
> = {
  [MigrationRefusalKind.ChecksumDrift]:
    "Agent Monitor migration refused: applied migration checksum drift",
  [MigrationRefusalKind.HistoryGap]:
    "Agent Monitor migration refused: applied migration missing from this build",
  [MigrationRefusalKind.Downgrade]:
    "Agent Monitor migration refused: store created by a newer build",
  [MigrationRefusalKind.BaselineMissing]:
    "Agent Monitor migration refused: baseline missing from this build",
};

/**
 * The stable, low-cardinality telemetry message for a refusal kind. Exhaustive
 * over {@link MigrationRefusalKind} by construction — a new kind fails typecheck
 * here until it is given its own message, rather than silently collapsing into
 * an existing one.
 */
export function migrationRefusalTelemetryMessage(
  kind: MigrationRefusalKind
): string {
  return MIGRATION_REFUSAL_TELEMETRY_MESSAGE[kind];
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

/**
 * ISS-8907: the Node error codes that mean "this build cannot resolve its own
 * modules" — the ISS-8906 shape, where a packaging break dark-fires every
 * install on a release at once.
 *
 * The CODE and never the message: `code` is a fixed Node identifier, while the
 * message carries the specifier and the resolution paths that ISS-4714 removed
 * from this record. Both spellings are listed because the desktop main bundle
 * mixes ESM (`ERR_MODULE_NOT_FOUND`) and CJS (`MODULE_NOT_FOUND`) resolution,
 * and which one a given build throws is a bundling detail, not a signal.
 */
const MODULE_RESOLUTION_ERROR_CODES: ReadonlySet<string> = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
]);

const NON_REFUSAL_BOOT_FAILURE_TELEMETRY_MESSAGE: Record<
  NonRefusalBootFailureKind,
  string
> = {
  [AppBootFailureKind.ModuleResolution]:
    "Agent Monitor runtime failed to initialize: module resolution failed",
  // ISS-9197: the message half matters more for THIS kind than for the others.
  // ISS-9253 vendors `app.boot_failure.kind`, so once the collector is rolled
  // (ISS-9677) the attribute tells these apart for every install on ISS-8907 or
  // later. This string is what tells them apart on the installs older than
  // that, which is the only half of the fleet it now speaks for — not the whole
  // of it.
  [AppBootFailureKind.StoreOpenTimeout]:
    "Agent Monitor runtime failed to initialize: store open exceeded its deadline",
  [AppBootFailureKind.Unknown]: GENERIC_BOOT_FAILURE_TELEMETRY_MESSAGE,
};

/** A boot failure that is not a migration refusal, so has no per-refusal kind. */
type NonRefusalBootFailureKind = Exclude<
  AppBootFailureKind,
  typeof AppBootFailureKind.MigrationRefusal
>;

/**
 * Classify a boot failure the refusal branch has already been ruled out of.
 *
 * Separate from {@link classifyBootFailureKind} so the narrowed return type is
 * what indexes {@link NON_REFUSAL_BOOT_FAILURE_TELEMETRY_MESSAGE} — the message
 * map is deliberately not defined over the refusal kind, because a refusal is
 * answered by {@link migrationRefusalTelemetryMessage} and an entry here would
 * be one no call site can reach.
 */
function classifyNonRefusalBootFailureKind(
  error: unknown
): NonRefusalBootFailureKind {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    MODULE_RESOLUTION_ERROR_CODES.has(error.code)
  ) {
    return AppBootFailureKind.ModuleResolution;
  }
  // ISS-9197: the one member here read off the message rather than a Node
  // `code`, because the deadline is our own timer and has no code to carry. The
  // predicate answers a BOOLEAN over a fixed token owned by the producer
  // (`transient-db-host-error.ts`), and the value emitted is the closed literal
  // below — the message never enters the record, so ISS-4714's no-paths,
  // no-specifiers, no-checksums contract holds unchanged.
  if (isStoreOpenTimeoutError(error)) {
    return AppBootFailureKind.StoreOpenTimeout;
  }
  return AppBootFailureKind.Unknown;
}

/**
 * ISS-8907: classify an Agent Monitor boot failure into the low-cardinality kind
 * emitted as `app.boot_failure.kind`.
 *
 * Reads the RAW error, so it must be called with the boot error rather than the
 * stabilized telemetry projection {@link buildMigrationFailureTelemetryError}
 * returns — that projection is a fresh `Error` by construction and has neither a
 * `code` nor the `DesktopMigrationError` type.
 */
export function classifyBootFailureKind(error: unknown): AppBootFailureKind {
  if (error instanceof DesktopMigrationError) {
    return AppBootFailureKind.MigrationRefusal;
  }
  return classifyNonRefusalBootFailureKind(error);
}
