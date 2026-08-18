import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-6403 Finding 2, second entry point (review: shafty023).
 *
 * The non-production host check first shipped on the `/preview-schemas/ensure`
 * ROUTE. `ensurePreviewSchemaBootstrap` imports `ensureSchemaAtHead` directly
 * and never touches that route, so a flag-on preview deployment accidentally
 * wired to the production host — the exact configuration failure the check
 * exists to contain — still minted a production URL and ran the
 * create/migrate/clone pipeline against it.
 *
 * These drive the REAL gate through the REAL service, with only the pipeline
 * and the URL minter stubbed. The sibling `preview-schema-bootstrap.test.ts`
 * mocks the whole ensure service, so it cannot see this gap; a test that drives
 * only the HTTP route would leave it green too. What is asserted is that the
 * pipeline is never REACHED and no URL is ever MINTED — the harm is the migrate
 * and the clone, not a rejected promise.
 */

const {
  mockRunMigrationPipeline,
  mockCreateSchemaUrlMinter,
  mockResolveMigrateRuntimeLayout,
  mockFlushMigrateTelemetry,
} = vi.hoisted(() => ({
  mockRunMigrationPipeline: vi.fn(),
  mockCreateSchemaUrlMinter: vi.fn(),
  mockResolveMigrateRuntimeLayout: vi.fn(),
  mockFlushMigrateTelemetry: vi.fn(() => Promise.resolve()),
}));

vi.mock("@repo/database/scripts/migration-pipeline", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/database/scripts/migration-pipeline")
  >("@repo/database/scripts/migration-pipeline");
  return { ...actual, runMigrationPipeline: mockRunMigrationPipeline };
});

vi.mock("@repo/database/scripts/iam-database-url", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/database/scripts/iam-database-url")
  >("@repo/database/scripts/iam-database-url");
  return { ...actual, createSchemaUrlMinter: mockCreateSchemaUrlMinter };
});

vi.mock("@repo/database/scripts/migrate-telemetry", () => ({
  flushMigrateTelemetry: mockFlushMigrateTelemetry,
}));

vi.mock("@/app/preview-schemas/ensure/prisma-runtime-layout", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/preview-schemas/ensure/prisma-runtime-layout")
  >("@/app/preview-schemas/ensure/prisma-runtime-layout");
  return {
    ...actual,
    resolveMigrateRuntimeLayout: mockResolveMigrateRuntimeLayout,
  };
});

const BRANCH = "feat/iss-6403-direct-bootstrap";
const EXPECTED_SCHEMA = normalizePreviewSchemaName(BRANCH);
const STAGE_HOST = "stage.rds.amazonaws.com";
const PROD_HOST = "prod.rds.amazonaws.com";

const PREVIEW_ENV = {
  NODE_ENV: "test",
  VERCEL_ENV: "preview",
  PREVIEW_SCHEMA_BOOTSTRAP: "1",
  VERCEL_GIT_COMMIT_REF: BRANCH,
} as const satisfies NodeJS.ProcessEnv;

async function loadGate() {
  vi.resetModules();
  return await import("@/lib/preview-schema-bootstrap");
}

describe("preview schema bootstrap — host invariant", () => {
  beforeEach(() => {
    // Everything downstream is wired to SUCCEED, so a missing invariant shows
    // up as a completed bootstrap rather than an incidental failure.
    mockResolveMigrateRuntimeLayout.mockReturnValue({
      ok: true,
      layout: {
        root: "/var/task",
        configDir: "/var/task/packages/database/prisma-runtime",
        cliEntry: "/var/task/node_modules/prisma/build/index.js",
        schemaEngineBinary: "/var/task/engines/schema-engine-linux",
        modulePaths: ["/var/task/node_modules"],
      },
    });
    mockCreateSchemaUrlMinter.mockReturnValue((schema: string | null) =>
      Promise.resolve(`postgresql://minted/${schema}`)
    );
    mockRunMigrationPipeline.mockResolvedValue({ invalidIndexes: [] });
    vi.stubEnv("PRISMA_CLI_ENTRY", undefined);
    vi.stubEnv("NODE_PATH", undefined);
    vi.stubEnv("PRISMA_SCHEMA_ENGINE_BINARY", undefined);
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::1:role/vercel");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("PGUSER", "vercel_iam");
    vi.stubEnv("PGDATABASE", "closedloop");
    vi.stubEnv("PGHOST", STAGE_HOST);
    vi.stubEnv("STAGE_PGHOST", STAGE_HOST);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("refuses before minting a URL when wired to a non-allowlisted host", async () => {
    vi.stubEnv("PGHOST", PROD_HOST);
    const { ensurePreviewSchemaBootstrap } = await loadGate();

    await expect(
      ensurePreviewSchemaBootstrap({ ...PREVIEW_ENV })
    ).rejects.toThrow(EXPECTED_SCHEMA);

    expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
    expect(mockCreateSchemaUrlMinter).not.toHaveBeenCalled();
  });

  it("refuses when STAGE_PGHOST is unset rather than assuming safety", async () => {
    // Fail CLOSED. Production is precisely the deployment where this variable
    // will not be set, so "unset" must never read as "proceed".
    vi.stubEnv("STAGE_PGHOST", undefined);
    const { ensurePreviewSchemaBootstrap } = await loadGate();

    await expect(
      ensurePreviewSchemaBootstrap({ ...PREVIEW_ENV })
    ).rejects.toThrow();

    expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
    expect(mockCreateSchemaUrlMinter).not.toHaveBeenCalled();
  });

  it("refuses before the layout probe, not after it", async () => {
    // Ordering matters for the same reason the route checked first: the probe
    // is the step that decides a spawn is possible, and nothing about this
    // deployment should be inspected once the host is known to be wrong.
    vi.stubEnv("PGHOST", PROD_HOST);
    const { ensurePreviewSchemaBootstrap } = await loadGate();

    await expect(
      ensurePreviewSchemaBootstrap({ ...PREVIEW_ENV })
    ).rejects.toThrow();

    expect(mockResolveMigrateRuntimeLayout).not.toHaveBeenCalled();
  });

  it("keeps the hostnames out of the message it throws", async () => {
    // Same sink concern as the route body (review: wongk): this rejection is
    // what a caller logs.
    vi.stubEnv("PGHOST", PROD_HOST);
    const { ensurePreviewSchemaBootstrap } = await loadGate();

    const failure = await ensurePreviewSchemaBootstrap({
      ...PREVIEW_ENV,
    }).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(PROD_HOST);
    expect((failure as Error).message).not.toContain(STAGE_HOST);
  });

  it("still bootstraps on the allowlisted host", async () => {
    // The other half of the gate: it must refuse the wrong host WITHOUT
    // refusing the right one, or the bootstrap it guards never runs at all.
    const { ensurePreviewSchemaBootstrap } = await loadGate();

    await ensurePreviewSchemaBootstrap({ ...PREVIEW_ENV });

    expect(mockRunMigrationPipeline).toHaveBeenCalledOnce();
    const [databaseUrl, schema] = mockRunMigrationPipeline.mock.calls[0];
    expect(schema).toBe(EXPECTED_SCHEMA);
    expect(databaseUrl).toBe(`postgresql://minted/${EXPECTED_SCHEMA}`);
  });
});
