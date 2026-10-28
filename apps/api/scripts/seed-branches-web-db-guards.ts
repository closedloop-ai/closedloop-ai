import { isLocalhostUrl } from "@repo/database/scripts/db-utils";

const LEADING_SLASH = /^\//;
const SAFE_DATABASE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const SYSTEM_DATABASE_NAMES = new Set(["postgres", "template0", "template1"]);

export const BranchesWebSeedRefusalCode = {
  TargetMissing: "target_missing",
  TargetAmbiguous: "target_ambiguous",
  BaseDatabaseUrlMissing: "base_database_url_missing",
  DatabaseUrlUnparseable: "database_url_unparseable",
  DatabaseUrlHostOverride: "database_url_host_override",
  DatabaseUrlNotLocal: "database_url_not_local",
  DatabaseNameInvalid: "database_name_invalid",
  DatabaseNameSystem: "database_name_system",
} as const;
export type BranchesWebSeedRefusalCode =
  (typeof BranchesWebSeedRefusalCode)[keyof typeof BranchesWebSeedRefusalCode];

export type BranchesWebSeedRefusal = {
  code: BranchesWebSeedRefusalCode;
  message: string;
};

export type BranchesWebSeedTarget = {
  databaseUrl: string;
  databaseName: string;
  label: string;
};

export type BranchesWebSeedTargetResult =
  | { ok: true; target: BranchesWebSeedTarget }
  | { ok: false; error: BranchesWebSeedRefusal };

export function resolveBranchesWebSeedDatabaseTarget({
  explicitDatabaseName,
  explicitDatabaseUrl,
  baseDatabaseUrl,
}: {
  explicitDatabaseName: string | undefined;
  explicitDatabaseUrl: string | undefined;
  baseDatabaseUrl: string | undefined;
}): BranchesWebSeedTargetResult {
  const databaseName = explicitDatabaseName?.trim();
  const databaseUrl = explicitDatabaseUrl?.trim();
  if (databaseName && databaseUrl) {
    return refused(
      BranchesWebSeedRefusalCode.TargetAmbiguous,
      "Pass either --database-name or --database-url, not both."
    );
  }
  if (!(databaseName || databaseUrl)) {
    return refused(
      BranchesWebSeedRefusalCode.TargetMissing,
      "Pass --database-name <name> or --database-url <url>; ambient DATABASE_URL alone is not enough for concurrent local worktrees."
    );
  }
  if (databaseUrl) {
    return databaseTargetFromUrl(databaseUrl);
  }
  const databaseNameGuard = checkBranchesWebSeedDatabaseName(databaseName);
  if (!databaseNameGuard.ok) {
    return databaseNameGuard;
  }
  if (!baseDatabaseUrl?.trim()) {
    return refused(
      BranchesWebSeedRefusalCode.BaseDatabaseUrlMissing,
      "DATABASE_URL is required as the base connection string when --database-name is used."
    );
  }
  const baseTarget = databaseTargetFromUrl(baseDatabaseUrl);
  if (!baseTarget.ok) {
    return baseTarget;
  }
  const url = new URL(baseTarget.target.databaseUrl);
  url.pathname = `/${databaseNameGuard.databaseName}`;
  return databaseTargetFromUrl(url.toString());
}

export function checkBranchesWebSeedDatabaseName(
  databaseName: string | undefined
):
  | { ok: true; databaseName: string }
  | { ok: false; error: BranchesWebSeedRefusal } {
  if (!(databaseName && SAFE_DATABASE_NAME_PATTERN.test(databaseName))) {
    return refused(
      BranchesWebSeedRefusalCode.DatabaseNameInvalid,
      "Database name must contain only letters, numbers, underscores, or hyphens."
    );
  }
  if (SYSTEM_DATABASE_NAMES.has(databaseName.toLowerCase())) {
    return refused(
      BranchesWebSeedRefusalCode.DatabaseNameSystem,
      `Refusing to seed system database '${databaseName}'.`
    );
  }
  return { ok: true, databaseName };
}

function databaseTargetFromUrl(
  databaseUrl: string
): BranchesWebSeedTargetResult {
  const parsed = URL.parse(databaseUrl);
  if (parsed === null) {
    return refused(
      BranchesWebSeedRefusalCode.DatabaseUrlUnparseable,
      "Database URL is not parseable; refusing to connect."
    );
  }
  if (parsed.searchParams.has("host")) {
    return refused(
      BranchesWebSeedRefusalCode.DatabaseUrlHostOverride,
      "Database URL includes a host connection option; refusing because it can override the URL hostname."
    );
  }
  if (!isLocalhostUrl(parsed)) {
    return refused(
      BranchesWebSeedRefusalCode.DatabaseUrlNotLocal,
      `Database URL host is '${parsed.hostname}', expected localhost, 127.0.0.1, or ::1.`
    );
  }
  const databaseName = parsed.pathname.replace(LEADING_SLASH, "");
  const databaseNameGuard = checkBranchesWebSeedDatabaseName(databaseName);
  if (!databaseNameGuard.ok) {
    return databaseNameGuard;
  }
  return {
    ok: true,
    target: {
      databaseUrl: parsed.toString(),
      databaseName: databaseNameGuard.databaseName,
      label: `${parsed.hostname}:${parsed.port || "5432"}/${databaseNameGuard.databaseName}`,
    },
  };
}

function refused(
  code: BranchesWebSeedRefusalCode,
  message: string
): { ok: false; error: BranchesWebSeedRefusal } {
  return { ok: false, error: { code, message } };
}
