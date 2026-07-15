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
