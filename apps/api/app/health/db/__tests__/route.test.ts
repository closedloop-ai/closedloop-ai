import {
  DbHealthAuthMode,
  DbHealthCheckStatus,
  DbHealthHostType,
  DbHealthSource,
  DbHealthSslMode,
  DbHealthTransportError,
} from "@repo/api/src/types/db-health";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

vi.mock("@repo/database", () => ({
  getDatabaseTransportPosture: vi.fn(() => ({
    status: DbHealthCheckStatus.Ok,
    hostType: DbHealthHostType.Rds,
    sslMode: DbHealthSslMode.Verified,
    authMode: DbHealthAuthMode.Iam,
    source: DbHealthSource.PgHostIam,
    verifiedRdsTls: true,
  })),
  withDb: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), flush: vi.fn(async () => undefined), info: vi.fn() },
}));

import { getDatabaseTransportPosture, withDb } from "@repo/database";
import { GET } from "../route";

const mockWithDb = withDb as unknown as Mock;
const mockTransportPosture = getDatabaseTransportPosture as unknown as Mock;

/** Every non-transport check green, so the verdict turns on transport alone. */
function mockAllDbChecksHealthy() {
  mockWithDb.mockResolvedValueOnce(undefined);
  mockWithDb.mockResolvedValueOnce([{ total: 5n, pending: 0n }]);
  mockWithDb.mockResolvedValueOnce([{ count: 42n }]);
}

const TEST_TOKEN = "test-db-health-token";
const HAD_DB_HEALTH_TOKEN = Object.hasOwn(process.env, "DB_HEALTH_TOKEN");
const ORIGINAL_DB_HEALTH_TOKEN = process.env.DB_HEALTH_TOKEN;
const DEPLOYMENT_ENV_KEYS = [
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_GIT_COMMIT_REF",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_URL",
] as const;
const ORIGINAL_DEPLOYMENT_ENV = Object.fromEntries(
  DEPLOYMENT_ENV_KEYS.map((key) => [key, process.env[key]])
);

function makeRequest({
  token = TEST_TOKEN,
  useLegacyTokenHeader = false,
}: {
  token?: string | null;
  useLegacyTokenHeader?: boolean;
} = {}) {
  const headers = new Headers();
  if (token !== null && !useLegacyTokenHeader) {
    headers.set("authorization", `Bearer ${token}`);
  }
  if (token !== null && useLegacyTokenHeader) {
    headers.set("x-db-health-token", token);
  }
  return new Request("https://api.closedloop.ai/health/db", { headers });
}

describe("GET /health/db", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.DB_HEALTH_TOKEN = TEST_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (HAD_DB_HEALTH_TOKEN) {
      process.env.DB_HEALTH_TOKEN = ORIGINAL_DB_HEALTH_TOKEN;
    } else {
      Reflect.deleteProperty(process.env, "DB_HEALTH_TOKEN");
    }
    for (const key of DEPLOYMENT_ENV_KEYS) {
      const value = ORIGINAL_DEPLOYMENT_ENV[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns 401 when token is missing", async () => {
    const response = await GET(makeRequest({ token: null }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({ ok: false, error: "unauthorized" });
    expect(JSON.stringify(body)).not.toContain("transport");
    expect(JSON.stringify(body)).not.toContain("deployment");
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("returns 401 when only x-db-health-token is sent", async () => {
    const response = await GET(makeRequest({ useLegacyTokenHeader: true }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({ ok: false, error: "unauthorized" });
    expect(JSON.stringify(body)).not.toContain("transport");
    expect(JSON.stringify(body)).not.toContain("deployment");
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("returns ok=true when connectivity, migrations, and table checks pass", async () => {
    mockWithDb.mockResolvedValueOnce(undefined);
    mockWithDb.mockResolvedValueOnce([{ total: 5n, pending: 0n }]);
    mockWithDb.mockResolvedValueOnce([{ count: 42n }]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.connectivity.status).toBe(DbHealthCheckStatus.Ok);
    expect(body.checks.migrations).toMatchObject({
      status: DbHealthCheckStatus.Ok,
      total: 5,
      pending: 0,
    });
    expect(body.checks.tables).toMatchObject({
      status: DbHealthCheckStatus.Ok,
      count: 42,
    });
    expect(body.checks.transport).toMatchObject({
      status: DbHealthCheckStatus.Ok,
      hostType: DbHealthHostType.Rds,
      sslMode: DbHealthSslMode.Verified,
      authMode: DbHealthAuthMode.Iam,
      source: DbHealthSource.PgHostIam,
      verifiedRdsTls: true,
    });
  });

  it("returns authenticated sanitized deployment identity when available", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abc123";
    process.env.VERCEL_GIT_COMMIT_REF = "main";
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_123";
    process.env.VERCEL_URL = "api-stage.example.vercel.app";
    mockWithDb.mockResolvedValueOnce(undefined);
    mockWithDb.mockResolvedValueOnce([{ total: 5n, pending: 0n }]);
    mockWithDb.mockResolvedValueOnce([{ count: 42n }]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deployment).toEqual({
      gitSha: "abc123",
      gitCommitRef: "main",
      vercelDeploymentId: "dpl_123",
      vercelUrl: "api-stage.example.vercel.app",
    });
  });

  it("marks overall health as failed when table count check fails", async () => {
    mockWithDb.mockResolvedValueOnce(undefined);
    mockWithDb.mockResolvedValueOnce([{ total: 5n, pending: 0n }]);
    mockWithDb.mockRejectedValueOnce(
      new Error("permission denied for relation")
    );

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.connectivity.status).toBe(DbHealthCheckStatus.Ok);
    expect(body.checks.migrations.status).toBe(DbHealthCheckStatus.Ok);
    expect(body.checks.tables).toMatchObject({
      status: DbHealthCheckStatus.Error,
      error: "db_table_count_check_failed",
    });
  });

  it("uses generic migration error when pending migrations exist", async () => {
    mockWithDb.mockResolvedValueOnce(undefined);
    mockWithDb.mockResolvedValueOnce([{ total: 5n, pending: 2n }]);
    mockWithDb.mockResolvedValueOnce([{ count: 42n }]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.migrations).toMatchObject({
      status: DbHealthCheckStatus.Error,
      total: 5,
      pending: 2,
      error: "db_migration_check_failed",
    });
    expect(JSON.stringify(body)).not.toContain("pending migration(s)");
  });

  it("sanitizes migration check errors", async () => {
    mockWithDb.mockResolvedValueOnce(undefined);
    mockWithDb.mockRejectedValueOnce(
      new Error('syntax error near "secret_sql_fragment"')
    );
    mockWithDb.mockResolvedValueOnce([{ count: 3n }]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.migrations).toMatchObject({
      status: DbHealthCheckStatus.Error,
      error: "db_migration_check_failed",
    });
    expect(JSON.stringify(body)).not.toContain("secret_sql_fragment");
  });

  it("treats missing migration table as first deploy", async () => {
    mockWithDb.mockResolvedValueOnce(undefined);
    mockWithDb.mockRejectedValueOnce(
      new Error('relation "_prisma_migrations" does not exist')
    );
    mockWithDb.mockResolvedValueOnce([{ count: 3n }]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.migrations).toMatchObject({
      status: DbHealthCheckStatus.Ok,
      note: "No migrations table (first deploy)",
    });
  });

  it("does not treat unrelated does-not-exist errors as first deploy", async () => {
    mockWithDb.mockResolvedValueOnce(undefined);
    mockWithDb.mockRejectedValueOnce(
      new Error('column "finished_at" does not exist')
    );
    mockWithDb.mockResolvedValueOnce([{ count: 3n }]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.migrations).toMatchObject({
      status: DbHealthCheckStatus.Error,
      error: "db_migration_check_failed",
    });
  });

  it("returns full checks shape when connectivity fails before other checks run", async () => {
    mockWithDb.mockRejectedValueOnce(new Error("connect timeout"));

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.connectivity).toMatchObject({
      status: DbHealthCheckStatus.Error,
      error: "db_connectivity_check_failed",
    });
    expect(body.checks.migrations).toMatchObject({
      status: DbHealthCheckStatus.Error,
      error: "not_run",
    });
    expect(body.checks.tables).toMatchObject({
      status: DbHealthCheckStatus.Error,
      error: "not_run",
    });
  });

  // ISS-8410. This is the branch the issue exists to close: before it, this
  // exact payload answered `ok: true` beside `sslMode: "insecure"`, so
  // `ALLOW_INSECURE_SSL=1` degraded every production connection to unverified
  // TLS, failed nothing, and alerted no one.
  it("fails the overall verdict when transport TLS is insecure", async () => {
    mockTransportPosture.mockReturnValueOnce({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Rds,
      sslMode: DbHealthSslMode.Insecure,
      authMode: DbHealthAuthMode.Iam,
      source: DbHealthSource.PgHostIam,
      verifiedRdsTls: false,
      error: DbHealthTransportError.TlsInsecure,
    });
    mockAllDbChecksHealthy();

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    // Every other check is green — transport alone moved the verdict.
    expect(body.checks.connectivity.status).toBe(DbHealthCheckStatus.Ok);
    expect(body.checks.migrations.status).toBe(DbHealthCheckStatus.Ok);
    expect(body.checks.tables.status).toBe(DbHealthCheckStatus.Ok);
    expect(body.checks.transport).toMatchObject({
      sslMode: DbHealthSslMode.Insecure,
      error: DbHealthTransportError.TlsInsecure,
    });
  });

  // Unknown means the posture could not be READ, not that it is fine. An
  // exclusion-based term (`!== insecure`) let this through — and the IAM pool
  // reaches it on a configuration it happily connects on, so this is the same
  // hole wearing a different sslMode.
  it("fails the overall verdict when the transport posture is unreadable", async () => {
    mockTransportPosture.mockReturnValueOnce({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Unknown,
      sslMode: DbHealthSslMode.Unknown,
      authMode: DbHealthAuthMode.Unknown,
      source: DbHealthSource.Unknown,
      verifiedRdsTls: false,
      error: DbHealthTransportError.UnknownPosture,
    });
    mockAllDbChecksHealthy();

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.tables.status).toBe(DbHealthCheckStatus.Ok);
  });

  // `Disabled` on a REMOTE host is `sslmode=disable` — plaintext credentials on
  // the wire. It must not be graded healthier than the encrypted-but-unverified
  // case above just because localhost shares its sslMode.
  it("fails the overall verdict when a remote host has TLS disabled entirely", async () => {
    mockTransportPosture.mockReturnValueOnce({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Other,
      sslMode: DbHealthSslMode.Disabled,
      authMode: DbHealthAuthMode.Password,
      source: DbHealthSource.DatabaseUrl,
      verifiedRdsTls: false,
      error: DbHealthTransportError.TlsDisabled,
    });
    mockAllDbChecksHealthy();

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.tables.status).toBe(DbHealthCheckStatus.Ok);
  });

  // A publicly-trusted non-RDS host (a Neon preview) verifies against the same
  // bundle. Keying the term on `verifiedRdsTls` instead of `Verified` would
  // degrade it, so this pins the difference.
  it("keeps the overall verdict ok for a verified non-RDS transport", async () => {
    mockTransportPosture.mockReturnValueOnce({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Other,
      sslMode: DbHealthSslMode.Verified,
      authMode: DbHealthAuthMode.Password,
      source: DbHealthSource.DatabaseUrl,
      verifiedRdsTls: false,
      error: DbHealthTransportError.NotRds,
    });
    mockAllDbChecksHealthy();

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  // The counterweight: `transport.status` is an error for EVERY posture that is
  // not verified RDS TLS, localhost included. Folding the status in instead of
  // naming the safe set would answer not-ok in local development.
  it("keeps the overall verdict ok for a localhost transport with TLS off", async () => {
    mockTransportPosture.mockReturnValueOnce({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Localhost,
      sslMode: DbHealthSslMode.Disabled,
      authMode: DbHealthAuthMode.Password,
      source: DbHealthSource.DatabaseUrl,
      verifiedRdsTls: false,
      error: DbHealthTransportError.TlsDisabled,
    });
    mockAllDbChecksHealthy();

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.transport).toMatchObject({
      status: DbHealthCheckStatus.Error,
      sslMode: DbHealthSslMode.Disabled,
    });
  });
});
