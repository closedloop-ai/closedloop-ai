import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { deriveBranchSchemaName } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import {
  VibeEnvironmentMode,
  VibeEnvironmentState,
} from "@repo/database/scripts/vibe-environment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRunMigrationPipeline,
  mockResolveMigrateRuntimeLayout,
  mockApplyMigrateRuntimeLayout,
  mockCreateSchemaUrlMinter,
  mockValidateGitHubOidcToken,
} = vi.hoisted(() => ({
  mockRunMigrationPipeline: vi.fn(),
  mockResolveMigrateRuntimeLayout: vi.fn(),
  mockApplyMigrateRuntimeLayout: vi.fn(),
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

vi.mock("@/app/preview-schemas/ensure/prisma-runtime-layout", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/preview-schemas/ensure/prisma-runtime-layout")
  >("@/app/preview-schemas/ensure/prisma-runtime-layout");
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

import { ensureRequest } from "@/__tests__/support/preview-schemas/request-bodies";
import { EnsureTarget } from "@/app/preview-schemas/ensure/constants";
import { POST } from "@/app/preview-schemas/ensure/route";
import { resetInFlightPipelinesForTests } from "@/app/preview-schemas/ensure/service";

const BRANCH = "vibe/bulk-tags";
const SCHEMA = deriveBranchSchemaName(BRANCH, normalizePreviewSchemaName);
const SEEDED_PENDING = {
  mode: VibeEnvironmentMode.Seeded,
  state: VibeEnvironmentState.Pending,
};

/*
 * ISS-12056. `vibe-environment.yml` builds a vibe environment's schema through
 * the ensure route with `vibeEnvironment`. The pipeline is mocked; what it does
 * with the request is driven for real by
 * `packages/database/__tests__/preview-clone-first.test.ts`.
 */
describe("ensure route: vibe environment requests", () => {
  beforeEach(() => {
    mockValidateGitHubOidcToken.mockResolvedValue(null);
    mockResolveMigrateRuntimeLayout.mockReturnValue({
      ok: true,
      layout: {
        root: "/var/task",
        configDir: "/var/task/packages/database/prisma-runtime",
        cliEntry: "/var/task/prisma/build/index.js",
        schemaEngineBinary: "/var/task/engines/schema-engine-linux",
        modulePaths: [],
      },
    });
    mockRunMigrationPipeline.mockResolvedValue({
      invalidIndexes: [],
      vibeEnvironment: SEEDED_PENDING,
      rebuilt: true,
    });
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::1:role/vercel");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("PGHOST", "stage.rds.amazonaws.com");
    vi.stubEnv("PGUSER", "vercel_iam");
    vi.stubEnv("PGDATABASE", "closedloop");
    vi.stubEnv("STAGE_PGHOST", "stage.rds.amazonaws.com");
    mockCreateSchemaUrlMinter.mockReturnValue((schema: string | null) =>
      Promise.resolve(`postgresql://minted/${schema}`)
    );
  });

  afterEach(() => {
    resetInFlightPipelinesForTests();
    vi.unstubAllEnvs();
  });

  it("asks the pipeline for the vibe environment and reports its marker", async () => {
    const response = await POST(
      ensureRequest({
        branch: BRANCH,
        vibeEnvironment: VibeEnvironmentMode.Seeded,
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        branch: BRANCH,
        schema: SCHEMA,
        vibeEnvironment: SEEDED_PENDING,
        rebuilt: true,
      },
    });
    expect(mockRunMigrationPipeline).toHaveBeenCalledWith(
      `postgresql://minted/${SCHEMA}`,
      SCHEMA,
      BRANCH,
      expect.any(Object),
      { vibeEnvironment: VibeEnvironmentMode.Seeded }
    );
  });

  it("sends no vibe request when the field is omitted", async () => {
    mockRunMigrationPipeline.mockResolvedValue({
      invalidIndexes: [],
      vibeEnvironment: null,
      rebuilt: false,
    });

    const response = await POST(ensureRequest({ branch: BRANCH }));

    expect(response.status).toBe(200);
    expect(mockRunMigrationPipeline).toHaveBeenCalledWith(
      `postgresql://minted/${SCHEMA}`,
      SCHEMA,
      BRANCH,
      expect.any(Object),
      {}
    );
  });

  it("refuses a vibe environment aimed at public before running anything", async () => {
    const response = await POST(
      ensureRequest({
        branch: BRANCH,
        target: EnsureTarget.Public,
        vibeEnvironment: VibeEnvironmentMode.Blank,
      })
    );

    expect(response.status).toBe(400);
    expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
  });

  it("refuses an unknown mode", async () => {
    const response = await POST(
      ensureRequest({ branch: BRANCH, vibeEnvironment: "cloned" })
    );

    expect(response.status).toBe(400);
    expect(mockRunMigrationPipeline).not.toHaveBeenCalled();
  });

  it("fails when the schema does not come back marked with the requested mode", async () => {
    mockRunMigrationPipeline.mockResolvedValue({
      invalidIndexes: [],
      vibeEnvironment: {
        mode: VibeEnvironmentMode.Blank,
        state: VibeEnvironmentState.Ready,
      },
      rebuilt: false,
    });

    const response = await POST(
      ensureRequest({
        branch: BRANCH,
        vibeEnvironment: VibeEnvironmentMode.Seeded,
      })
    );

    expect(response.status).toBe(500);
  });

  it("does not join a plain ensure already in flight for the same schema", async () => {
    let releasePlain: () => void = () => undefined;
    mockRunMigrationPipeline.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePlain = () =>
            resolve({
              invalidIndexes: [],
              vibeEnvironment: null,
              rebuilt: false,
            });
        })
    );

    const plain = POST(ensureRequest({ branch: BRANCH }));
    const vibe = await POST(
      ensureRequest({
        branch: BRANCH,
        vibeEnvironment: VibeEnvironmentMode.Seeded,
      })
    );
    releasePlain();
    await plain;

    expect(vibe.status).toBe(200);
    expect(mockRunMigrationPipeline).toHaveBeenCalledTimes(2);
  });
});
