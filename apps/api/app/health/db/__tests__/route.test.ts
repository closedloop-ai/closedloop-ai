import { type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import { withDb } from "@repo/database";
import { GET } from "../route";

const mockWithDb = withDb as unknown as Mock;

const TEST_TOKEN = "test-db-health-token";

function makeRequest({
  token = TEST_TOKEN,
  forwardedFor = "203.0.113.10",
  useLegacyTokenHeader = false,
}: {
  token?: string | null;
  forwardedFor?: string;
  useLegacyTokenHeader?: boolean;
} = {}) {
  const headers = new Headers();
  if (token !== null && !useLegacyTokenHeader) {
    headers.set("authorization", `Bearer ${token}`);
  }
  if (token !== null && useLegacyTokenHeader) {
    headers.set("x-db-health-token", token);
  }
  headers.set("x-forwarded-for", forwardedFor);
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
    process.env.DB_HEALTH_TOKEN = undefined;
  });

  it("returns 401 when token is missing", async () => {
    const response = await GET(makeRequest({ token: null }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({ ok: false, error: "unauthorized" });
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("returns 401 when only x-db-health-token is sent", async () => {
    const response = await GET(makeRequest({ useLegacyTokenHeader: true }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({ ok: false, error: "unauthorized" });
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("returns ok=true when connectivity, migrations, and table checks pass", async () => {
    mockWithDb.mockResolvedValueOnce(undefined);
    mockWithDb.mockResolvedValueOnce([{ total: 5n, pending: 0n }]);
    mockWithDb.mockResolvedValueOnce([{ count: 42n }]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.checks.connectivity.status).toBe("ok");
    expect(body.checks.migrations).toMatchObject({
      status: "ok",
      total: 5,
      pending: 0,
    });
    expect(body.checks.tables).toMatchObject({ status: "ok", count: 42 });
  });

  it("marks overall health as failed when table count check fails", async () => {
    mockWithDb.mockResolvedValueOnce(undefined);
    mockWithDb.mockResolvedValueOnce([{ total: 5n, pending: 0n }]);
    mockWithDb.mockRejectedValueOnce(
      new Error("permission denied for relation")
    );

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.ok).toBe(false);
    expect(body.checks.connectivity.status).toBe("ok");
    expect(body.checks.migrations.status).toBe("ok");
    expect(body.checks.tables).toMatchObject({
      status: "error",
      error: "db_table_count_check_failed",
    });
  });

  it("uses generic migration error when pending migrations exist", async () => {
    mockWithDb.mockResolvedValueOnce(undefined);
    mockWithDb.mockResolvedValueOnce([{ total: 5n, pending: 2n }]);
    mockWithDb.mockResolvedValueOnce([{ count: 42n }]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.ok).toBe(false);
    expect(body.checks.migrations).toMatchObject({
      status: "error",
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

    expect(body.ok).toBe(false);
    expect(body.checks.migrations).toMatchObject({
      status: "error",
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

    expect(body.ok).toBe(true);
    expect(body.checks.migrations).toMatchObject({
      status: "ok",
      note: "No migrations table (first deploy)",
    });
  });
});
