import { recoverMigrateDeployFailure } from "@repo/database/scripts/migrate-deploy-recovery";
import {
  MIGRATION_SERIALIZE_LOCK_BUDGET_MS,
  type MigrationLockClient,
  STATEMENT_TIMEOUT_SQLSTATE,
  withMigrationSerializeLock,
} from "@repo/database/scripts/migration-lock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRunMigrationPipeline,
  mockResolveMigrateRuntimeLayout,
  mockCreateSchemaUrlMinter,
  mockValidateGitHubOidcToken,
} = vi.hoisted(() => ({
  mockRunMigrationPipeline: vi.fn(),
  mockResolveMigrateRuntimeLayout: vi.fn(),
  mockCreateSchemaUrlMinter: vi.fn(),
  mockValidateGitHubOidcToken: vi.fn(),
}));

vi.mock("@/lib/auth/github-oidc-auth", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/github-oidc-auth")
  >("@/lib/auth/github-oidc-auth");
  return { ...actual, validateGitHubOidcToken: mockValidateGitHubOidcToken };
});

vi.mock("@repo/database/scripts/migrate-telemetry", () => ({
  flushMigrateTelemetry: vi.fn(() => Promise.resolve()),
  cutMigrateRunsAtDeadline: vi.fn(() => 0),
}));

vi.mock("@repo/database/scripts/migration-pipeline", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/database/scripts/migration-pipeline")
  >("@repo/database/scripts/migration-pipeline");
  return { ...actual, runMigrationPipeline: mockRunMigrationPipeline };
});

vi.mock("@/app/preview-schemas/ensure/prisma-runtime-layout", () => ({
  resolveMigrateRuntimeLayout: mockResolveMigrateRuntimeLayout,
  applyMigrateRuntimeLayout: vi.fn(),
}));

vi.mock("@repo/database/scripts/iam-database-url", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/database/scripts/iam-database-url")
  >("@repo/database/scripts/iam-database-url");
  return { ...actual, createSchemaUrlMinter: mockCreateSchemaUrlMinter };
});

import {
  ensureRequest,
  PROBE_BRANCH,
} from "@/__tests__/support/preview-schemas/request-bodies";
import {
  ENSURE_DEADLINE_RESERVE_MS,
  ENSURE_PUBLIC_MIGRATE_ALLOWANCE_MS,
  ENSURE_ROUTE_CEILING_MS,
  EnsureTarget,
} from "@/app/preview-schemas/ensure/constants";
import { POST } from "@/app/preview-schemas/ensure/route";
import { resetInFlightPipelinesForTests } from "@/app/preview-schemas/ensure/service";

/**
 * ISS-11781. Stage `migrate-public` failed on a busy migration lock: the route
 * waited in the FEA-3065 serialize gate past its own deadline (504) and left
 * the waiter queued, or Prisma timed out on its advisory lock (P1002, a 500
 * indistinguishable from a migration failure). `public` now gets a gate that
 * fails CLOSED inside its budget, and both shapes answer 503 — nothing ran, a
 * retry is safe — which is what `migrate-public` retries and a 500 is not.
 *
 * The gate here is the REAL one, driven through the pipeline's own seam with a
 * scripted pg client, so "fails closed" is observed (the migrate never runs),
 * not inferred from the options it was handed.
 */

const LAYOUT = {
  ok: true as const,
  layout: {
    root: "/var/task",
    configDir: "/var/task/packages/database/prisma-runtime",
    cliEntry: "/var/task/node_modules/prisma/build/index.js",
    schemaEngineBinary: "/var/task/engines/schema-engine-linux",
    modulePaths: ["/var/task/node_modules"],
  },
};

/** Prisma's own wording when its migration advisory lock stays held. */
const P1002_STDERR = [
  "Error: P1002",
  "The database server was reached but timed out.",
  "Context: Timed out trying to acquire a postgres advisory lock (SELECT pg_advisory_lock(72707369)). Timeout: 10000ms.",
].join("\n");

/** A migration that failed partway on `public`, which recovery resolves as rolled back. */
const ROLLED_BACK_MIGRATION = "20260930120000_add_widget_index";

/** Prisma's report of that failure. */
const P3018_STDERR = [
  "Error: P3018",
  "A migration failed to apply. New migrations cannot be applied before the error is recovered from.",
  `Migration name: ${ROLLED_BACK_MIGRATION}`,
  "Database error code: 23505",
].join("\n");

/** How `runMigrateDeploy` rejects: the CLI's output rides on the error. */
function deployError(stderr: string): Error {
  return Object.assign(
    new Error("prisma migrate deploy failed with exit code 1"),
    { stderr, stdout: "" }
  );
}

type GateClient = { client: MigrationLockClient; gateBudgets: unknown[] };

/** A pg client whose advisory-lock wait is cancelled by its statement_timeout. */
function busyGateClient(): GateClient {
  const gateBudgets: unknown[] = [];
  const client: MigrationLockClient = {
    connect: () => Promise.resolve(),
    end: () => Promise.resolve(),
    query: (text: string, values?: unknown[]) => {
      if (text.includes("set_config")) {
        gateBudgets.push(values?.[0]);
      }
      if (text.includes("pg_advisory_lock(")) {
        return Promise.reject(
          Object.assign(
            new Error("canceling statement due to statement timeout"),
            { code: STATEMENT_TIMEOUT_SQLSTATE }
          )
        );
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { client, gateBudgets };
}

/** A pg client that cannot connect at all: a broken gate, not a busy one. */
function unreachableGateClient(): GateClient {
  const gate = busyGateClient();
  return {
    gateBudgets: gate.gateBudgets,
    client: {
      ...gate.client,
      connect: () =>
        Promise.reject(
          Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
          })
        ),
    },
  };
}

/** A pg client whose advisory-lock wait is granted at once. */
function freeGateClient(): GateClient {
  const gate = busyGateClient();
  return {
    gateBudgets: gate.gateBudgets,
    client: {
      ...gate.client,
      query: (text: string, values?: unknown[]) =>
        text.includes("pg_advisory_lock(")
          ? Promise.resolve({ rows: [] })
          : gate.client.query(text, values),
    },
  };
}

/**
 * Stands in for `runMigrationPipeline` up to its gate: takes the gate the
 * route handed it, or the pipeline's default when it handed none, exactly as
 * `applyMigrationsToSchema` does, and records whether the migrate ran.
 */
function pipelineThroughGate(gate: GateClient, ran: { migrated: boolean }) {
  return async (
    _databaseUrl: string,
    _schema: string | null,
    _branch: string,
    overrides: {
      withMigrationSerializeLock?: typeof withMigrationSerializeLock;
    }
  ) => {
    const serialize =
      overrides.withMigrationSerializeLock ?? withMigrationSerializeLock;
    await serialize(
      {
        databaseUrl: "postgresql://stage/app",
        createClient: () => gate.client,
        logger: { log: () => undefined },
      },
      () => {
        ran.migrated = true;
        return Promise.resolve(false);
      }
    );
    return { invalidIndexes: [] };
  };
}

describe("ensure route under migration-lock contention", () => {
  beforeEach(() => {
    // Pins `Date.now`, so the route's preamble costs 0ms and the gate budget it
    // derives is exact.
    vi.useFakeTimers();
    mockValidateGitHubOidcToken.mockResolvedValue(null);
    mockResolveMigrateRuntimeLayout.mockReturnValue(LAYOUT);
    mockCreateSchemaUrlMinter.mockReturnValue((schema: string | null) =>
      Promise.resolve(`postgresql://minted/${schema}`)
    );
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::1:role/vercel");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("PGHOST", "stage.rds.amazonaws.com");
    vi.stubEnv("STAGE_PGHOST", "stage.rds.amazonaws.com");
    vi.stubEnv("PGUSER", "vercel_iam");
    vi.stubEnv("PGDATABASE", "closedloop");
  });

  afterEach(() => {
    vi.useRealTimers();
    resetInFlightPipelinesForTests();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("answers 503 for a busy gate on `public` and never runs the migrate", async () => {
    const gate = busyGateClient();
    const ran = { migrated: false };
    mockRunMigrationPipeline.mockImplementation(pipelineThroughGate(gate, ran));

    const response = await POST(
      ensureRequest({ branch: "green", target: EnsureTarget.Public })
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(ran.migrated).toBe(false);
    expect(body.error).toContain("nothing was applied");
    // The gate waited only for what the migrate allowance leaves of the budget.
    expect(gate.gateBudgets).toEqual([
      String(
        ENSURE_ROUTE_CEILING_MS -
          ENSURE_DEADLINE_RESERVE_MS -
          ENSURE_PUBLIC_MIGRATE_ALLOWANCE_MS
      ),
    ]);
  });

  /**
   * Review: marisolashgrove. Only a wait that ran out refuses; a gate that broke
   * for another reason fails open as it did before ISS-11781, so a blip on its
   * own connection cannot turn a would-succeed migrate into a red job.
   */
  it("fails open, not closed, when the gate cannot connect: broken is not busy", async () => {
    const gate = unreachableGateClient();
    const ran = { migrated: false };
    mockRunMigrationPipeline.mockImplementation(pipelineThroughGate(gate, ran));

    const response = await POST(
      ensureRequest({ branch: "green", target: EnsureTarget.Public })
    );

    expect(response.status).toBe(200);
    expect(ran.migrated).toBe(true);
  });

  it("still migrates `public` when its gate is free", async () => {
    const gate = freeGateClient();
    const ran = { migrated: false };
    mockRunMigrationPipeline.mockImplementation(pipelineThroughGate(gate, ran));

    const response = await POST(
      ensureRequest({ branch: "green", target: EnsureTarget.Public })
    );

    expect(response.status).toBe(200);
    expect(ran.migrated).toBe(true);
  });

  it("leaves a preview's gate as it was: default budget, fail-open", async () => {
    const gate = busyGateClient();
    const ran = { migrated: false };
    mockRunMigrationPipeline.mockImplementation(pipelineThroughGate(gate, ran));

    const response = await POST(ensureRequest({ branch: PROBE_BRANCH }));

    expect(response.status).toBe(200);
    expect(ran.migrated).toBe(true);
    expect(gate.gateBudgets).toEqual([
      String(MIGRATION_SERIALIZE_LOCK_BUDGET_MS),
    ]);
  });

  it("answers 503, not a migration failure, when Prisma's advisory lock times out (P1002)", async () => {
    mockRunMigrationPipeline.mockRejectedValue(
      Object.assign(
        new Error("prisma migrate deploy failed with exit code 1"),
        { stderr: P1002_STDERR, stdout: "" }
      )
    );

    const response = await POST(
      ensureRequest({ branch: "green", target: EnsureTarget.Public })
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toContain("nothing was applied");
    expect(body.error).toContain("P1002");
  });

  /**
   * Review: whitlockk. On `public` a P3018 is resolved as rolled back and the
   * deploy retried; a P1002 from THAT retry follows a deploy that failed
   * mid-migration, so it is not "nothing was applied". Driven through the REAL
   * recovery, so the retry's error carries exactly what production's would.
   */
  it("answers 500 with the rolled-back migration when the recovery's retry hits P1002", async () => {
    mockRunMigrationPipeline.mockImplementation(() =>
      recoverMigrateDeployFailure(
        {
          databaseUrl: "postgresql://stage/app",
          schema: null,
          branch: "green",
          error: deployError(P3018_STDERR),
        },
        {
          runMigrateDeploy: () => Promise.reject(deployError(P1002_STDERR)),
          resolveFailedMigration: () => Promise.resolve(),
          resetSchema: () => Promise.resolve(),
          upsertSchemaRegistry: () => Promise.resolve(),
        }
      )
    );

    const response = await POST(
      ensureRequest({ branch: "green", target: EnsureTarget.Public })
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).not.toContain("nothing was applied");
    expect(body.error).toContain(ROLLED_BACK_MIGRATION);
    expect(body.error).toContain("P3018");
    expect(body.error).toContain("P1002");
  });

  /**
   * Review: tamsinb. `migrate-public` retries a 504, so the body it prints
   * must not tell the reader not to; a preview's gate still fails open, so
   * its caller is still told to wait.
   */
  it("tells a cut `public` run that its gate fails closed, and a cut preview not to retry", async () => {
    mockRunMigrationPipeline.mockImplementation(
      () =>
        new Promise(() => {
          // Never settles: the migrate is still running at the deadline.
        })
    );

    const publicPending = POST(
      ensureRequest({ branch: "green", target: EnsureTarget.Public })
    );
    const previewPending = POST(ensureRequest({ branch: PROBE_BRANCH }));
    await vi.advanceTimersByTimeAsync(ENSURE_ROUTE_CEILING_MS);
    const publicResponse = await publicPending;
    const previewResponse = await previewPending;
    const publicBody = await publicResponse.json();
    const previewBody = await previewResponse.json();

    expect(publicResponse.status).toBe(504);
    expect(publicBody.error).toContain("fails closed");
    expect(publicBody.error).not.toContain("do not retry");
    expect(previewResponse.status).toBe(504);
    expect(previewBody.error).toContain("do not retry");
    expect(previewBody.error).not.toContain("fails closed");
  });
});
