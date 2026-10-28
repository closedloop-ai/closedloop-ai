import { isLocalhostUrl } from "@repo/database/scripts/db-utils";

const FIXTURE_DATABASE_NAMES = new Set(["closedloop_ai", "closedloop_perf"]);
const LEADING_SLASH = /^\//;

export const BRANCH_ANALYTICS_PERF_FIXTURE_SLUG =
  "branch-analytics-perf-fixture";
export const BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_CLERK_ID = `org_${BRANCH_ANALYTICS_PERF_FIXTURE_SLUG}`;
export const BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_NAME =
  "Branch Analytics Perf Fixture";

export const BranchAnalyticsPerfFixtureRefusalCode = {
  DatabaseUrlMissing: "database_url_missing",
  DatabaseUrlUnparseable: "database_url_unparseable",
  DatabaseUrlHostOverride: "database_url_host_override",
  DatabaseUrlNotLocal: "database_url_not_local",
  DatabaseUrlNotFixtureDatabase: "database_url_not_fixture_database",
  OrganizationSentinelMismatch: "organization_sentinel_mismatch",
} as const;
export type BranchAnalyticsPerfFixtureRefusalCode =
  (typeof BranchAnalyticsPerfFixtureRefusalCode)[keyof typeof BranchAnalyticsPerfFixtureRefusalCode];

export type BranchAnalyticsPerfFixtureRefusal = {
  code: BranchAnalyticsPerfFixtureRefusalCode;
  message: string;
};

export type BranchAnalyticsPerfFixtureGuardResult =
  | { ok: true }
  | { ok: false; error: BranchAnalyticsPerfFixtureRefusal };

/** Refuse before any write unless DATABASE_URL points at a local fixture DB. */
export function checkBranchAnalyticsPerfDatabaseUrl(
  databaseUrl: string | undefined
): BranchAnalyticsPerfFixtureGuardResult {
  if (!databaseUrl?.trim()) {
    return refused(
      BranchAnalyticsPerfFixtureRefusalCode.DatabaseUrlMissing,
      "DATABASE_URL is not set; point it at a local Branch analytics fixture database."
    );
  }
  const parsed = URL.parse(databaseUrl.trim());
  if (parsed === null) {
    return refused(
      BranchAnalyticsPerfFixtureRefusalCode.DatabaseUrlUnparseable,
      "DATABASE_URL is not parseable; refusing to connect."
    );
  }
  if (parsed.searchParams.has("host")) {
    return refused(
      BranchAnalyticsPerfFixtureRefusalCode.DatabaseUrlHostOverride,
      "DATABASE_URL includes a host connection option; refusing because it can override the URL hostname."
    );
  }
  if (!isLocalhostUrl(parsed)) {
    return refused(
      BranchAnalyticsPerfFixtureRefusalCode.DatabaseUrlNotLocal,
      `DATABASE_URL host is '${parsed.hostname}', expected localhost, 127.0.0.1, or ::1; refusing to write to a remote database.`
    );
  }
  const databaseName = parsed.pathname.replace(LEADING_SLASH, "");
  if (!FIXTURE_DATABASE_NAMES.has(databaseName)) {
    return refused(
      BranchAnalyticsPerfFixtureRefusalCode.DatabaseUrlNotFixtureDatabase,
      `DATABASE_URL database is '${databaseName}', expected one of ${[...FIXTURE_DATABASE_NAMES].join(", ")}; refusing to write to a non-fixture database.`
    );
  }
  return { ok: true };
}

/** Refuse destructive cleanup unless the slug resolves to the owned fixture. */
export function checkBranchAnalyticsPerfFixtureOrganization(organization: {
  clerkId: string | null;
  name: string;
}): BranchAnalyticsPerfFixtureGuardResult {
  if (
    organization.clerkId ===
      BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_CLERK_ID &&
    organization.name === BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_NAME
  ) {
    return { ok: true };
  }
  return refused(
    BranchAnalyticsPerfFixtureRefusalCode.OrganizationSentinelMismatch,
    `Refusing to clean up organization slug '${BRANCH_ANALYTICS_PERF_FIXTURE_SLUG}' because it does not carry the Branch analytics fixture sentinel.`
  );
}

function refused(
  code: BranchAnalyticsPerfFixtureRefusalCode,
  message: string
): BranchAnalyticsPerfFixtureGuardResult {
  return { ok: false, error: { code, message } };
}
