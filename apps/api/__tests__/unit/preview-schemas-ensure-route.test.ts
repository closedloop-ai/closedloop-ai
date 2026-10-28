import path from "node:path";
import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { CloneFailedError } from "@repo/database/scripts/clone-schema";
import { PRISMA_CLI_ENTRY_ENV } from "@repo/database/scripts/prisma-cli";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PrismaRuntimeLayout from "@/app/preview-schemas/ensure/prisma-runtime-layout";
import type * as RouteUtils from "@/lib/route-utils";

const {
  mockScheduleLogFlush,
  mockRunMigrationPipeline,
  mockResolveMigrateRuntimeLayout,
  mockApplyMigrateRuntimeLayout,
  mockCreateSchemaUrlMinter,
  mockFlushMigrateTelemetry,
  mockCutMigrateRunsAtDeadline,
  mockValidateGitHubOidcToken,
  realApplyMigrateRuntimeLayout,
} = vi.hoisted(() => ({
  mockScheduleLogFlush: vi.fn(),
  mockRunMigrationPipeline: vi.fn(),
  mockResolveMigrateRuntimeLayout: vi.fn(),
  mockApplyMigrateRuntimeLayout: vi.fn(),
  mockCreateSchemaUrlMinter: vi.fn(),
  mockFlushMigrateTelemetry: vi.fn(() => Promise.resolve()),
  mockCutMigrateRunsAtDeadline: vi.fn(() => 1),
  mockValidateGitHubOidcToken: vi.fn(),
  realApplyMigrateRuntimeLayout: {
    current: undefined as
      | typeof PrismaRuntimeLayout.applyMigrateRuntimeLayout
      | undefined,
  },
}));

vi.mock("@/lib/auth/github-oidc-auth", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/github-oidc-auth")
  >("@/lib/auth/github-oidc-auth");
  return { ...actual, validateGitHubOidcToken: mockValidateGitHubOidcToken };
});

vi.mock("@repo/database/scripts/migrate-telemetry", () => ({
  flushMigrateTelemetry: mockFlushMigrateTelemetry,
  cutMigrateRunsAtDeadline: mockCutMigrateRunsAtDeadline,
}));

vi.mock("@/lib/route-utils", async () => {
  const actual = await vi.importActual<typeof RouteUtils>("@/lib/route-utils");
  return { ...actual, scheduleLogFlush: mockScheduleLogFlush };
});

vi.mock("@repo/database/scripts/migration-pipeline", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/database/scripts/migration-pipeline")
  >("@repo/database/scripts/migration-pipeline");
  return { ...actual, runMigrationPipeline: mockRunMigrationPipeline };
});

// `applyMigrateRuntimeLayout` is the REAL one, spied rather than replaced.
// ISS-6403: a stub records that the route called something; only the real
// implementation proves the route hands it a layout the CLI can actually be
// spawned from, which is what the `cliEntry` + `NODE_PATH` contract is for.
vi.mock("@/app/preview-schemas/ensure/prisma-runtime-layout", async () => {
  const actual = await vi.importActual<typeof PrismaRuntimeLayout>(
    "@/app/preview-schemas/ensure/prisma-runtime-layout"
  );
  realApplyMigrateRuntimeLayout.current = actual.applyMigrateRuntimeLayout;
  return {
    ...actual,
    resolveMigrateRuntimeLayout: mockResolveMigrateRuntimeLayout,
    applyMigrateRuntimeLayout: mockApplyMigrateRuntimeLayout,
  };
});

vi.mock("@repo/database/scripts/iam-database-url", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/database/scripts/iam-database-url")
  >("@repo/database/scripts/iam-database-url");
  return { ...actual, createSchemaUrlMinter: mockCreateSchemaUrlMinter };
});

import { BRANCH_NAME_MAX_LENGTH } from "@repo/api/src/types/artifact";
import {
  bodyOfBytes,
  ensureRequest,
  PROBE_BRANCH,
} from "@/__tests__/support/preview-schemas/request-bodies";
import { PREVIEW_SCHEMA_REQUEST_MAX_BYTES } from "@/app/preview-schemas/constants";
import {
  ENSURE_DEADLINE_RESERVE_MS,
  ENSURE_ROUTE_CEILING_MS,
  EnsureTarget,
} from "@/app/preview-schemas/ensure/constants";
import { POST } from "@/app/preview-schemas/ensure/route";
import { resetInFlightPipelinesForTests } from "@/app/preview-schemas/ensure/service";
import { GitHubOidcCaller } from "@/lib/auth/github-oidc-auth";

const BRANCH = PROBE_BRANCH;
const CLI_ENTRY =
  "/var/task/node_modules/.pnpm/prisma@7.8.0/node_modules/prisma/build/index.js";
/** Stands in for the RDS IAM auth token the spawn env carries. */
const IAM_PASSWORD = "v1.local.eyJhbGciOiJIUzI1NiJ9-not-a-real-token";
const MODULE_PATHS = [
  "/var/task/node_modules/.pnpm/prisma@7.8.0/node_modules",
  "/var/task/node_modules/.pnpm/@prisma+config@7.8.0/node_modules",
  "/var/task/node_modules",
];
const RESOLVED_LAYOUT = {
  ok: true as const,
  layout: {
    root: "/var/task",
    // ISS-6403 Finding 5: this is now exported for the CHILD to spawn into and
    // never entered by this process, so it no longer has to name the suite's
    // own cwd to stay harmless.
    configDir: "/var/task/packages/database/prisma-runtime",
    cliEntry: CLI_ENTRY,
    schemaEngineBinary: "/var/task/engines/schema-engine-linux",
    modulePaths: MODULE_PATHS,
  },
};

describe("preview schema ensure route", () => {
  /** The env the pipeline's CLI spawn would inherit, captured as it runs. */
  let spawnEnv: Partial<NodeJS.ProcessEnv> = {};

  beforeEach(() => {
    mockApplyMigrateRuntimeLayout.mockImplementation(
      realApplyMigrateRuntimeLayout.current!
    );
    mockValidateGitHubOidcToken.mockResolvedValue(null);
    mockResolveMigrateRuntimeLayout.mockReturnValue(RESOLVED_LAYOUT);
    spawnEnv = {};
    mockRunMigrationPipeline.mockImplementation(() => {
      spawnEnv = { ...process.env };
      return Promise.resolve({ invalidIndexes: [] });
    });
    // Every variable the real `applyMigrateRuntimeLayout` writes is stubbed, so
    // `unstubAllEnvs` has something to restore and a later suite cannot inherit
    // this fixture's layout (review: whitlockk). Two of them also never overwrite an
    // existing value, so an inherited one would make the assertions below pass
    // without the route having done anything.
    vi.stubEnv(PRISMA_CLI_ENTRY_ENV, undefined);
    vi.stubEnv("NODE_PATH", undefined);
    vi.stubEnv("PRISMA_SCHEMA_ENGINE_BINARY", undefined);
    // The IAM branch is the deployed one; an inherited DATABASE_URL would
    // silently take the password branch and make the re-mint assertion vacuous.
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::1:role/vercel");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("PGHOST", "stage.rds.amazonaws.com");
    vi.stubEnv("PGUSER", "vercel_iam");
    vi.stubEnv("PGDATABASE", "closedloop");
    // ISS-6403 Finding 2: the route refuses unless PGHOST is the explicitly
    // allowlisted non-prod host, so every case below that expects to reach the
    // pipeline has to be on it.
    vi.stubEnv("STAGE_PGHOST", "stage.rds.amazonaws.com");
    mockCreateSchemaUrlMinter.mockReturnValue((schema: string | null) =>
      Promise.resolve(`postgresql://minted/${schema}`)
    );
  });

  afterEach(() => {
    // A case that leaves its pipeline unsettled would otherwise have every
    // later case JOIN it (the ISS-6403 in-flight coalescing is process-global
    // on purpose) and hang.
    resetInFlightPipelinesForTests();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("short-circuits on a rejected GitHub OIDC token", async () => {
    mockValidateGitHubOidcToken.mockResolvedValue(
      new Response("Unauthorized", { status: 401 })
    );

    const response = await POST(ensureRequest({ branch: BRANCH }, {}));

    expect(response.status).toBe(401);
    expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
    expect(mockScheduleLogFlush).not.toHaveBeenCalled();
  });

  it("authenticates against the ensure caller, not the cleanup caller", async () => {
    // ISS-5984: the two preview-schema routes share the OIDC mechanism but NOT
    // the claim set. Passing the wrong caller here would let a token minted for
    // the cleanup sweep drive a migrate, which is the whole point of pinning
    // audience + workflow ref per caller.
    await POST(ensureRequest({ branch: BRANCH }));

    expect(mockValidateGitHubOidcToken).toHaveBeenCalledWith(
      expect.anything(),
      { caller: GitHubOidcCaller.PreviewSchemaEnsure }
    );
  });

  /*
   * ISS-6403 Finding 2. Auth proves WHO is calling, never WHICH DATABASE this
   * deployment is wired to. `apps/api` also runs in production with the same
   * PGHOST/PGUSER/PGDATABASE/AWS_ROLE_ARN set, so before this gate an
   * authorized call to the production endpoint would have created a `preview_*`
   * schema on the production RDS and cloned every table into it -- a full copy
   * of production data in a schema no reaper touches.
   *
   * Each case asserts the pipeline was never REACHED, not merely that the
   * response was non-200: the harm is the migrate and the clone, not the status
   * code. The mocks are left fully wired -- the layout resolves, the minter
   * works, the pipeline would succeed -- so a missing gate produces a 200 here
   * rather than an incidental failure.
   */
  describe("non-production host enforcement", () => {
    it("refuses before the pipeline when PGHOST is not the allowlisted host", async () => {
      vi.stubEnv("PGHOST", "prod.rds.amazonaws.com");

      const response = await POST(ensureRequest({ branch: BRANCH }));

      expect(response.status).toBe(403);
      expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
      // Nothing was minted either: refusing after signing an IAM token for the
      // production host would already have opened the connection it forbids.
      expect(mockCreateSchemaUrlMinter).not.toHaveBeenCalled();
    });

    it("keeps both database hostnames out of the refusal body", async () => {
      // review: whitlockk. `validateHost` names PGHOST *and* STAGE_PGHOST in its
      // message, and the staging workflow prints this body straight into a
      // GitHub Actions log -- so echoing it leaked both hostnames into a far
      // more widely readable place than a Vercel log. This PR's sibling change
      // exists to keep credential-shaped material out of that same sink.
      //
      // The expectation changed because the BEHAVIOR changed: the body is now
      // deliberately generic and the detail goes to `log.error` server-side.
      vi.stubEnv("PGHOST", "prod.rds.amazonaws.com");

      const response = await POST(ensureRequest({ branch: BRANCH }));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).not.toContain("prod.rds.amazonaws.com");
      expect(body.error).not.toContain("stage.rds.amazonaws.com");
      // Generic, but still an actionable statement of WHAT was refused.
      expect(body.error).toContain("Refusing to ensure a schema");
    });

    it("refuses when STAGE_PGHOST is unset rather than assuming safety", async () => {
      // Fail CLOSED. Production is precisely the deployment where this variable
      // will not be set, so "unset" must never read as "proceed".
      vi.stubEnv("STAGE_PGHOST", undefined);

      const response = await POST(ensureRequest({ branch: BRANCH }));

      expect(response.status).toBe(403);
      expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
      expect(mockCreateSchemaUrlMinter).not.toHaveBeenCalled();
    });

    it("refuses when PGHOST is unset", async () => {
      vi.stubEnv("PGHOST", undefined);

      const response = await POST(ensureRequest({ branch: BRANCH }));

      expect(response.status).toBe(403);
      expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
    });

    it("refuses the `public` target on a non-allowlisted host too", async () => {
      // The worst case of the three: `public` on the production host is the
      // production schema itself.
      vi.stubEnv("PGHOST", "prod.rds.amazonaws.com");

      const response = await POST(
        ensureRequest({ branch: "main", target: EnsureTarget.Public })
      );

      expect(response.status).toBe(403);
      expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
    });

    it("still admits the allowlisted host, case-insensitively", async () => {
      // The other half of the gate: it must refuse the wrong host WITHOUT
      // refusing the right one, or stage's own migrate is what it breaks.
      vi.stubEnv("PGHOST", "STAGE.rds.amazonaws.com");

      const response = await POST(ensureRequest({ branch: BRANCH }));

      expect(response.status).toBe(200);
      expect(mockRunMigrationPipeline).toHaveBeenCalledOnce();
    });
  });

  it("rejects a body without a branch", async () => {
    const response = await POST(ensureRequest({}));

    expect(response.status).toBe(400);
    expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
  });

  it("rejects a branch outside the shared character class", async () => {
    const response = await POST(ensureRequest({ branch: "@@@" }));

    expect(response.status).toBe(400);
    expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
  });

  // `staging-integration-tests.yml` posts `client_payload.git.ref` straight at
  // this route after skipping only empty, `main`, and merge-queue refs, so a
  // ref the character class refuses is a RED deploy job, not a quiet skip —
  // and `+` is legal in a git ref (review: whitlockk). This is a real branch on
  // `origin`, the only one of 336 outside the pre-widening class.
  it("accepts a real branch name carrying a plus", async () => {
    const response = await POST(
      ensureRequest({ branch: "worktree-kerensa+quoted-text-comments-poc" })
    );

    expect(response.status).toBe(200);
    expect(mockRunMigrationPipeline).toHaveBeenCalledOnce();
  });

  it("rejects an empty branch", async () => {
    const response = await POST(ensureRequest({ branch: "" }));

    expect(response.status).toBe(400);
    expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
  });

  it("migrates the branch's preview schema through the shared pipeline", async () => {
    const response = await POST(ensureRequest({ branch: BRANCH }));

    expect(response.status).toBe(200);
    // ISS-6837: a run that completed inside its budget is never cut.
    expect(mockCutMigrateRunsAtDeadline).not.toHaveBeenCalled();
    const expectedSchema = normalizePreviewSchemaName(BRANCH);
    expect(mockRunMigrationPipeline).toHaveBeenCalledOnce();
    const [databaseUrl, schema, branch, overrides] =
      mockRunMigrationPipeline.mock.calls[0];
    expect(schema).toBe(expectedSchema);
    expect(schema.startsWith("preview_")).toBe(true);
    expect(branch).toBe(BRANCH);
    expect(databaseUrl).toBe(`postgresql://minted/${expectedSchema}`);

    // ISS-5285: the pipeline re-mints after the clone. Assert the closure is
    // wired AND that it signs the same schema, not just that a function exists.
    expect(await overrides.refreshDatabaseUrl()).toBe(
      `postgresql://minted/${expectedSchema}`
    );

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { branch: BRANCH, schema: expectedSchema, invalidIndexes: [] },
    });
  });

  it("migrates the `public` schema when the post-deploy hook asks for it", async () => {
    // ISS-5984 / PLN-1629 F1: `null` IS `public` to the pipeline — the same
    // value `resolveSchemaName` hands the build on the production target — and
    // every preview-only step inside self-guards on it. Passing the derived
    // `preview_*` name here instead would migrate a schema nobody deploys to
    // and leave stage `public` behind once the build migrate is off.
    const response = await POST(
      ensureRequest({ branch: "main", target: EnsureTarget.Public })
    );

    expect(response.status).toBe(200);
    const [databaseUrl, schema, branch] =
      mockRunMigrationPipeline.mock.calls[0];
    expect(schema).toBeNull();
    expect(branch).toBe("main");
    expect(databaseUrl).toBe("postgresql://minted/null");
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { branch: "main", schema: null },
    });
  });

  it("still targets the branch preview schema when target is omitted", async () => {
    // The ISS-5983 contract: an existing caller that never learned about
    // `target` keeps its exact behavior.
    await POST(ensureRequest({ branch: BRANCH }));

    const [, schema] = mockRunMigrationPipeline.mock.calls[0];
    expect(schema).toBe(normalizePreviewSchemaName(BRANCH));
  });

  /**
   * ISS-6403 Finding 1. Every budget inside the pipeline meets or exceeds this
   * route's 300s ceiling, and its dominant step — the `prisma migrate deploy`
   * spawn — has no timeout at all, so a long run was killed by the PLATFORM:
   * the route's `catch` never ran and the caller got a
   * `FUNCTION_INVOCATION_TIMEOUT` rather than this envelope.
   *
   * Driven with a pipeline that NEVER settles, which is the only shape that
   * distinguishes "bounded" from "handed a number": without the bound this test
   * hangs until the runner kills it.
   */
  it("answers 504 with its own envelope when the migrate outlives the deadline", async () => {
    vi.useFakeTimers();
    try {
      mockRunMigrationPipeline.mockImplementation(
        () =>
          new Promise(() => {
            // Never settles: the migrate is still running at the deadline.
          })
      );

      const pending = POST(ensureRequest({ branch: BRANCH }));
      await vi.advanceTimersByTimeAsync(ENSURE_ROUTE_CEILING_MS);
      const response = await pending;
      const body = await response.json();

      // 504, NOT 500: the migrate is still running and still holds the
      // serialize lock, so this must not read as "the migration failed".
      expect(response.status).toBe(504);
      expect(body.error).toContain("STILL RUNNING");
      expect(mockScheduleLogFlush).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ISS-6837. The flush drains a buffer the pipeline only fills from a `finally`
   * this run never reaches, so the cut has to happen — and has to happen BEFORE
   * the flush, or the partial event sits in the buffer with nothing to drain it.
   */
  it("cuts the abandoned run's telemetry, for this schema, before flushing", async () => {
    vi.useFakeTimers();
    try {
      mockRunMigrationPipeline.mockImplementation(
        () =>
          new Promise(() => {
            // Never settles: the migrate is still running at the deadline.
          })
      );

      const pending = POST(ensureRequest({ branch: BRANCH }));
      await vi.advanceTimersByTimeAsync(ENSURE_ROUTE_CEILING_MS);
      expect((await pending).status).toBe(504);

      expect(mockCutMigrateRunsAtDeadline).toHaveBeenCalledWith(
        normalizePreviewSchemaName(BRANCH)
      );
      // Pairs with the not-called assertion on the 200 path: the cut is scoped to
      // the deadline branch, not the unconditional `catch` or the `finally`.
      expect(
        mockCutMigrateRunsAtDeadline.mock.invocationCallOrder[0]
      ).toBeLessThan(mockFlushMigrateTelemetry.mock.invocationCallOrder[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the migrate every millisecond up to the reserve, and no more", async () => {
    vi.useFakeTimers();
    try {
      mockRunMigrationPipeline.mockImplementation(
        () =>
          new Promise(() => {
            // Never settles.
          })
      );

      const pending = POST(ensureRequest({ branch: BRANCH }));
      let settled = false;
      pending.then(() => {
        settled = true;
      });

      // One tick before the budget is spent the migrate must still be running:
      // a reserve that crept upward would start failing runs that finish in
      // this window and succeed today.
      await vi.advanceTimersByTimeAsync(
        ENSURE_ROUTE_CEILING_MS - ENSURE_DEADLINE_RESERVE_MS - 1
      );
      expect(settled).toBe(false);

      // And one tick after, it must have given up, leaving the whole reserve
      // for the envelope rather than losing the race to the platform kill.
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("charges the pre-pipeline preamble to the budget, not to the reserve", async () => {
    // ISS-6403 Finding 1 (review). The PLATFORM's 300s clock starts at request
    // entry, but the deadline is armed only once the pipeline begins — after a
    // cold-instance JWKS fetch and an STS-signed IAM token. If those seconds are
    // not subtracted, the 504 lands AFTER the platform kill and the caller gets
    // the opaque `FUNCTION_INVOCATION_TIMEOUT` this exists to replace.
    const preambleMs = 20_000;
    vi.useFakeTimers();
    try {
      // `setSystemTime` moves the wall clock the route reads WITHOUT advancing
      // the timer clock, which is exactly what a blocking network call does.
      mockValidateGitHubOidcToken.mockImplementation(() => {
        vi.setSystemTime(Date.now() + preambleMs);
        return Promise.resolve(null);
      });
      mockRunMigrationPipeline.mockImplementation(
        () =>
          new Promise(() => {
            // Never settles.
          })
      );

      const pending = POST(ensureRequest({ branch: BRANCH }));
      let settled = false;
      pending.then(() => {
        settled = true;
      });

      // The budget must already be short by the preamble, so the deadline fires
      // this much earlier than a run with no preamble would.
      await vi.advanceTimersByTimeAsync(
        ENSURE_ROUTE_CEILING_MS - ENSURE_DEADLINE_RESERVE_MS - preambleMs
      );

      expect(settled).toBe(true);
      expect((await pending).status).toBe(504);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms a deadline timer and clears it once the run finishes", async () => {
    // A warm instance serves many requests; a ~5-minute timer left armed per
    // request would pin the event loop and the closure behind it. Asserting
    // only that none REMAINS would stay green if the budget wiring were deleted
    // and no timer was ever armed, so the armed state is asserted first.
    vi.useFakeTimers();
    try {
      let release: (() => void) | undefined;
      mockRunMigrationPipeline.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ invalidIndexes: [] });
          })
      );

      const pending = POST(ensureRequest({ branch: BRANCH }));
      await vi.waitFor(() => {
        expect(mockRunMigrationPipeline).toHaveBeenCalledTimes(1);
      });
      // Read from the test body once the run is under way: the deadline is
      // armed AROUND the pipeline promise, so it does not exist yet at the
      // instant the pipeline function itself is entered.
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      release?.();
      const response = await pending;

      expect(response.status).toBe(200);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins an in-flight migrate for the same schema instead of starting a second", async () => {
    // ISS-6403 Finding 1 (review). Answering 504 rather than being killed
    // leaves the instance warm with the abandoned `prisma migrate deploy` still
    // running, so a re-run landing here must NOT spawn another one.
    const logInfo = vi.spyOn(log, "info").mockImplementation(() => {
      // Silence, and give the join a synchronization point below.
    });
    let release: ((value: { invalidIndexes: [] }) => void) | undefined;
    mockRunMigrationPipeline.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );

    const first = POST(ensureRequest({ branch: BRANCH }));
    await vi.waitFor(() => {
      expect(mockRunMigrationPipeline).toHaveBeenCalledTimes(1);
    });

    const second = POST(ensureRequest({ branch: BRANCH }));
    // Wait for the second request to actually REACH the join before releasing;
    // resolving earlier would let the first settle, clear the slot, and have
    // the second legitimately start its own run.
    await vi.waitFor(() => {
      expect(logInfo).toHaveBeenCalledWith(
        "[preview-schema-ensure] Joining an in-flight migrate",
        expect.anything()
      );
    });
    release?.({ invalidIndexes: [] });

    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    // One migrate, two callers.
    expect(mockRunMigrationPipeline).toHaveBeenCalledTimes(1);
    logInfo.mockRestore();
  });

  /**
   * ISS-8139. The case above releases the slot the way the source intends —
   * when the PIPELINE settles. This one is the other half: the first caller's
   * DEADLINE fires while the migrate runs on, and the slot must survive it.
   * `runPipelineWithinBudget` races the pipeline without cancelling it, so a
   * 504 abandons the run rather than ending it; clearing the entry there is
   * precisely what would let this second request start a second migrate under
   * the first.
   *
   * It is also the premise the residue in
   * `packages/database/__tests__/preview-schema-timeout-residue.test.ts` rests
   * on. That suite pins the pipeline's own ordering against a hang; this pins
   * that the deadline neither cancels the hang nor compensates what it already
   * wrote — without which the residue could stop being reachable while the
   * ordering it asserts stayed true.
   */
  it("leaves the abandoned migrate joinable after answering 504", async () => {
    vi.useFakeTimers();
    const logInfo = vi.spyOn(log, "info").mockImplementation(() => {
      // Silence, and give the join below its observation point.
    });
    try {
      mockRunMigrationPipeline.mockImplementation(
        () =>
          new Promise(() => {
            // Never settles: the migrate outlives every caller's deadline.
          })
      );

      const first = POST(ensureRequest({ branch: BRANCH }));
      await vi.advanceTimersByTimeAsync(ENSURE_ROUTE_CEILING_MS);
      expect((await first).status).toBe(504);

      const second = POST(ensureRequest({ branch: BRANCH }));
      await vi.advanceTimersByTimeAsync(ENSURE_ROUTE_CEILING_MS);
      expect((await second).status).toBe(504);

      // Joined, not restarted — read off the join itself and not only off the
      // call count, so a second request that fell over before reaching the map
      // could not satisfy this by doing nothing.
      expect(logInfo).toHaveBeenCalledWith(
        "[preview-schema-ensure] Joining an in-flight migrate",
        expect.anything()
      );
      expect(mockRunMigrationPipeline).toHaveBeenCalledTimes(1);
    } finally {
      logInfo.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects an unknown target instead of silently previewing", async () => {
    const response = await POST(
      ensureRequest({ branch: BRANCH, target: "staging" })
    );

    expect(response.status).toBe(400);
    expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
  });

  it("prepares the spawn environment before the pipeline runs", async () => {
    const response = await POST(ensureRequest({ branch: BRANCH }));

    expect(response.status).toBe(200);
    expect(mockApplyMigrateRuntimeLayout).toHaveBeenCalledWith(
      RESOLVED_LAYOUT.layout
    );
    // Ordering is the contract: the CLI is spawned INSIDE the pipeline, so a
    // layout applied afterwards would be applied to nothing.
    expect(
      mockApplyMigrateRuntimeLayout.mock.invocationCallOrder[0]
    ).toBeLessThan(mockRunMigrationPipeline.mock.invocationCallOrder[0]);
  });

  it("exports the CLI entrypoint and its module paths the pipeline spawns with", async () => {
    // ISS-6403. Read off `process.env` AS THE PIPELINE RUNS, because that is
    // what `runMigrationPipeline` spreads into the CLI spawn. Asserting the
    // route called a stub proves the wiring exists; asserting these two proves
    // the spawned CLI can find its own entrypoint and then require out of it.
    const response = await POST(ensureRequest({ branch: BRANCH }));

    expect(response.status).toBe(200);
    expect(spawnEnv[PRISMA_CLI_ENTRY_ENV]).toBe(CLI_ENTRY);
    expect(spawnEnv.NODE_PATH).toBe(MODULE_PATHS.join(path.delimiter));
  });

  it("hands the child its config directory without moving its own", async () => {
    // ISS-6403 Finding 5. Prisma 7 discovers `prisma.config.mjs` from cwd, and
    // the CLI still has to find it -- so the directory has to reach the CHILD.
    // Two things must NOT happen: this process following it (`process.chdir`
    // would move the cwd of every other request on the warm instance), and the
    // value being published process-globally at all. It travels as a
    // per-invocation pipeline option (review: davetho), so it is read off the
    // pipeline CALL, not off the env the pipeline was running under.
    const before = process.cwd();

    const response = await POST(ensureRequest({ branch: BRANCH }));

    expect(response.status).toBe(200);
    const [, , , overrides] = mockRunMigrationPipeline.mock.calls[0];
    expect(overrides.prismaCli).toEqual({
      cwd: RESOLVED_LAYOUT.layout.configDir,
    });
    expect(process.cwd()).toBe(before);
    // The env the child would inherit must not carry it: an instance-wide value
    // is what a per-invocation option exists to avoid.
    expect(spawnEnv.PRISMA_CLI_CWD).toBeUndefined();
  });

  it("never lets an app-pool DATABASE_URL redirect the migrate", async () => {
    // DATABASE_URL is `@repo/database`'s own runtime pool variable. Honoring it
    // here would migrate over the application's connection — the wrong role —
    // and a URL that already carries `?schema=` would silently target the wrong
    // schema while the response still names the branch's preview schema.
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://app:pw@localhost:5432/closedloop?schema=public"
    );

    const response = await POST(ensureRequest({ branch: BRANCH }));

    expect(response.status).toBe(200);
    const expectedSchema = normalizePreviewSchemaName(BRANCH);
    const [databaseUrl] = mockRunMigrationPipeline.mock.calls[0];
    expect(databaseUrl).toBe(`postgresql://minted/${expectedSchema}`);
    expect(mockCreateSchemaUrlMinter).toHaveBeenCalledOnce();
  });

  it("flushes the ISS-4392 migrate telemetry buffer on every run", async () => {
    await POST(ensureRequest({ branch: BRANCH }));

    expect(mockFlushMigrateTelemetry).toHaveBeenCalledOnce();
  });

  it("flushes the telemetry buffer even when the pipeline fails", async () => {
    mockRunMigrationPipeline.mockRejectedValue(new Error("P1002 lock timeout"));

    await POST(ensureRequest({ branch: BRANCH }));

    expect(mockFlushMigrateTelemetry).toHaveBeenCalledOnce();
  });

  it("refuses to spawn the CLI when the bundle layout is unresolved", async () => {
    mockResolveMigrateRuntimeLayout.mockReturnValue({
      ok: false,
      reason: "Could not locate the bundled Prisma CLI",
      rootsTried: ["/var/task"],
    });

    const response = await POST(ensureRequest({ branch: BRANCH }));

    expect(response.status).toBe(500);
    expect(mockApplyMigrateRuntimeLayout).not.toHaveBeenCalled();
    expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
  });

  it("reports database credentials that are not configured", async () => {
    vi.stubEnv("PGDATABASE", undefined);

    const response = await POST(ensureRequest({ branch: BRANCH }));

    expect(response.status).toBe(500);
    expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
  });

  it("redacts a credential-bearing precondition throw from its envelope", async () => {
    mockCreateSchemaUrlMinter.mockImplementation(() => {
      throw new Error(
        "signer init failed: postgres://vercel_iam:pw-that-must-not-escape@db.internal.example.com:5432/symphony"
      );
    });

    const response = await POST(ensureRequest({ branch: BRANCH }));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("pw-that-must-not-escape");
    expect(body).not.toContain("db.internal.example.com");
    expect(body).toContain("[redacted sensitive value]");
  });

  it("answers in its JSON envelope when a precondition throws", async () => {
    // The AWS signer is constructed from env before the pipeline's own
    // try/catch; malformed IAM config throws there, and the route owns a JSON
    // error envelope (apps/api/AGENTS.md), not an unhandled 500.
    mockCreateSchemaUrlMinter.mockImplementation(() => {
      throw new Error("Invalid RDS signer configuration");
    });

    const response = await POST(ensureRequest({ branch: BRANCH }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("Invalid RDS signer configuration"),
    });
    expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
    expect(mockScheduleLogFlush).not.toHaveBeenCalled();
  });

  it("surfaces a pipeline failure as a 500 naming the schema", async () => {
    mockRunMigrationPipeline.mockRejectedValue(new Error("P1002 lock timeout"));

    const response = await POST(ensureRequest({ branch: BRANCH }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining(normalizePreviewSchemaName(BRANCH)),
    });
  });

  it("strips credential material out of a pipeline failure body", async () => {
    // ISS-6403: a failed `prisma migrate resolve` embeds the CLI's RAW stderr in
    // what it throws, and this spawn's env carries an IAM-signed DATABASE_URL.
    // The staging workflow echoes this body into an Actions log, so anything
    // credential-shaped that reaches it is a leak into a widely readable place.
    mockRunMigrationPipeline.mockRejectedValue(
      new Error(
        "prisma migrate resolve --rolled-back 20260101_add failed: " +
          `Error: P1000\nDATABASE_URL=postgresql://vercel_iam:${IAM_PASSWORD}@stage.rds.amazonaws.com:5432/closedloop\n` +
          `PGPASSWORD=${IAM_PASSWORD}`
      )
    );

    const response = await POST(ensureRequest({ branch: BRANCH }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).not.toContain(IAM_PASSWORD);
    expect(body.error).not.toContain("stage.rds.amazonaws.com");
    // Redaction, not erasure — the operator still gets something actionable.
    expect(body.error).toContain("20260101_add");
    expect(body.error).toContain(normalizePreviewSchemaName(BRANCH));
  });

  it("leaves a failure body with nothing sensitive in it untouched", async () => {
    // The other half of the sanitizer contract: a redaction marker is only
    // emitted when non-empty sensitive content actually matched.
    const plainFailure =
      "P3009 migrate found failed migrations in the target database";
    mockRunMigrationPipeline.mockRejectedValue(new Error(plainFailure));

    const response = await POST(ensureRequest({ branch: BRANCH }));
    const body = await response.json();

    expect(body.error).toContain(plainFailure);
    expect(body.error).not.toContain("redacted");
  });

  /*
   * ISS-6558. `runMigrateDeploy` attaches the CLI's stdout/stderr to the error
   * it throws as PROPERTIES, and `parseError` reads only `.message` — so the
   * entire diagnostic yield of a failed stage migrate was `failed with exit
   * code 1`, and a P3009 was indistinguishable from an unreachable database
   * while stage sat behind `main` for two days.
   */
  const PIPELINE_FAILED_LOG =
    "[preview-schema-ensure] Migration pipeline failed";
  const STAGE_ENDPOINT_HOST =
    "stage-db.cluster-c9v1.us-east-1.rds.amazonaws.com";

  function migrateDeployFailure(stderr: string): Error {
    const error = new Error(
      "prisma migrate deploy failed with exit code 1"
    ) as Error & { stderr: string; stdout: string };
    error.stderr = stderr;
    error.stdout = "";
    return error;
  }

  it("surfaces the CLI's stderr, not just the exit code", async () => {
    mockRunMigrationPipeline.mockRejectedValue(
      migrateDeployFailure(
        "Error: P3009\n\nmigrate found failed migrations in the target database.\nMigration name: 20260101000000_add_widget\n"
      )
    );
    const logError = vi.spyOn(log, "error").mockImplementation(() => {
      // Intentionally silent: the payload is read from the spy, not stdout.
    });

    const response = await POST(ensureRequest({ branch: BRANCH }));
    const body = await response.json();

    expect(response.status).toBe(500);
    // The two facts ISS-6558 asked for by name: the code and the migration.
    expect(body.error).toContain("P3009");
    expect(body.error).toContain("20260101000000_add_widget");
    expect(logError).toHaveBeenCalledWith(
      PIPELINE_FAILED_LOG,
      expect.objectContaining({
        cliOutput: expect.stringContaining("20260101000000_add_widget"),
      })
    );
  });

  it("logs a failed clone's cause and its error code (ISS-11867)", async () => {
    const cause = Object.assign(
      new Error("function iss11212_github_thread_anchor(text) does not exist"),
      { code: "42883" }
    );
    mockRunMigrationPipeline.mockRejectedValue(
      new CloneFailedError(normalizePreviewSchemaName(BRANCH), cause)
    );
    const logError = vi.spyOn(log, "error").mockImplementation(() => {
      // Intentionally silent: the payload is read from the spy, not stdout.
    });

    const response = await POST(ensureRequest({ branch: BRANCH }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toContain(cause.message);
    expect(logError).toHaveBeenCalledWith(
      PIPELINE_FAILED_LOG,
      expect.objectContaining({
        cloneErrorCode: "42883",
        error: expect.stringContaining(cause.message),
      })
    );
  });

  it("logs no clone error code for a failure that is not a clone's", async () => {
    mockRunMigrationPipeline.mockRejectedValue(
      Object.assign(new Error("relation does not exist"), { code: "42P01" })
    );
    const logError = vi.spyOn(log, "error").mockImplementation(() => {
      // Intentionally silent: the payload is read from the spy, not stdout.
    });

    await POST(ensureRequest({ branch: BRANCH }));

    const loggedPayload = logError.mock.calls.find(
      ([message]) => message === PIPELINE_FAILED_LOG
    )?.[1];
    expect(loggedPayload).toBeDefined();
    expect(loggedPayload).not.toHaveProperty("cloneErrorCode");
  });

  it("redacts credential material carried on the CLI's stderr", async () => {
    // The security condition on the whole of ISS-6558: this text is Prisma's,
    // not ours, and the staging workflow echoes the body into an Actions log.
    // Widening what crosses is only safe because it crosses the sanitizer.
    mockRunMigrationPipeline.mockRejectedValue(
      migrateDeployFailure(
        "Error: P1000 Authentication failed\n" +
          `datasource: postgresql://vercel_iam:${IAM_PASSWORD}@stage.rds.amazonaws.com:5432/closedloop\n` +
          `PGPASSWORD=${IAM_PASSWORD}\n` +
          "Migration name: 20260101000000_add_widget\n"
      )
    );
    const logError = vi.spyOn(log, "error").mockImplementation(() => {
      // Intentionally silent: the payload is read from the spy, not stdout.
    });

    const response = await POST(ensureRequest({ branch: BRANCH }));
    const body = await response.json();

    expect(body.error).not.toContain(IAM_PASSWORD);
    expect(body.error).not.toContain("stage.rds.amazonaws.com");
    // Redaction, not erasure — the diagnosis still reaches the operator.
    expect(body.error).toContain("P1000");
    expect(body.error).toContain("20260101000000_add_widget");

    // Selected by message, not position: the route logs its own failure line
    // after the service's, so `.at(-1)` is a different call.
    const loggedPayload = logError.mock.calls.find(
      ([message]) => message === PIPELINE_FAILED_LOG
    )?.[1] as { cliOutput?: string };
    expect(loggedPayload.cliOutput).toBeDefined();
    expect(loggedPayload.cliOutput).not.toContain(IAM_PASSWORD);
    expect(loggedPayload.cliOutput).toContain("P1000");
  });

  it("keeps the bare P1001 endpoint out of the 500 body", async () => {
    // The regression this branch shipped and review: whitlockk caught. P1001 names
    // the endpoint as PROSE, not as a `user:pass@host` URL, so the sanitizer's
    // original patterns passed it straight into the body the staging workflow
    // echoes into an Actions log. Asserted at the SINK, not just on the helper:
    // the response body is what leaves the process.
    mockRunMigrationPipeline.mockRejectedValue(
      migrateDeployFailure(
        `Error: P1001: Can't reach database server at ${STAGE_ENDPOINT_HOST}:5432`
      )
    );

    const response = await POST(ensureRequest({ branch: BRANCH }));
    const body = await response.json();

    expect(body.error).not.toContain(STAGE_ENDPOINT_HOST);
    expect(body.error).toContain("P1001");
  });

  it("accepts a branch at the shared name bound and rejects one past it", async () => {
    const atBound = "a".repeat(BRANCH_NAME_MAX_LENGTH);

    expect((await POST(ensureRequest({ branch: atBound }))).status).toBe(200);

    mockRunMigrationPipeline.mockClear();
    const rejected = await POST(
      ensureRequest({ branch: "a".repeat(BRANCH_NAME_MAX_LENGTH + 1) })
    );

    expect(rejected.status).toBe(400);
    expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
  });

  it("accepts a body at the request cap and refuses one past it", async () => {
    const atCap = bodyOfBytes(
      { branch: BRANCH },
      PREVIEW_SCHEMA_REQUEST_MAX_BYTES
    );
    expect(JSON.stringify(atCap).length).toBe(PREVIEW_SCHEMA_REQUEST_MAX_BYTES);

    expect((await POST(ensureRequest(atCap))).status).toBe(200);

    mockRunMigrationPipeline.mockClear();
    const refused = await POST(
      ensureRequest(
        bodyOfBytes({ branch: BRANCH }, PREVIEW_SCHEMA_REQUEST_MAX_BYTES + 1)
      )
    );

    expect(refused.status).toBe(413);
    expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
  });
});
