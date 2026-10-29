import { BRANCH_NAME_MAX_LENGTH } from "@repo/api/src/types/artifact";
import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { deriveBranchSchemaName } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { SeedAdmissionRefusal } from "@repo/database/scripts/preview-seed-lock";
import {
  VibeEnvironmentMode,
  VibeEnvironmentState,
} from "@repo/database/scripts/vibe-environment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RouteUtils from "@/lib/route-utils";

const {
  mockScheduleLogFlush,
  mockRunPreviewSeedInProcess,
  mockCreateSchemaUrlMinter,
  mockValidateGitHubOidcToken,
  mockWithPreviewSeedAdmission,
  mockReadVibeEnvironmentMarker,
  mockLogInfo,
  mockLogWarn,
  mockLogError,
} = vi.hoisted(() => ({
  mockScheduleLogFlush: vi.fn(),
  mockRunPreviewSeedInProcess: vi.fn(),
  mockCreateSchemaUrlMinter: vi.fn(),
  mockValidateGitHubOidcToken: vi.fn(),
  mockWithPreviewSeedAdmission: vi.fn(),
  mockReadVibeEnvironmentMarker: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("@repo/observability/log", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/observability/log")
  >("@repo/observability/log");
  return {
    ...actual,
    log: {
      ...actual.log,
      info: mockLogInfo,
      warn: mockLogWarn,
      error: mockLogError,
    },
  };
});

vi.mock("@/lib/auth/github-oidc-auth", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/github-oidc-auth")
  >("@/lib/auth/github-oidc-auth");
  return { ...actual, validateGitHubOidcToken: mockValidateGitHubOidcToken };
});

vi.mock("@/lib/route-utils", async () => {
  const actual = await vi.importActual<typeof RouteUtils>("@/lib/route-utils");
  return { ...actual, scheduleLogFlush: mockScheduleLogFlush };
});

vi.mock("@repo/database/scripts/preview-seed", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/database/scripts/preview-seed")
  >("@repo/database/scripts/preview-seed");
  return { ...actual, runPreviewSeedInProcess: mockRunPreviewSeedInProcess };
});

vi.mock("@repo/database/scripts/iam-database-url", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/database/scripts/iam-database-url")
  >("@repo/database/scripts/iam-database-url");
  return { ...actual, createSchemaUrlMinter: mockCreateSchemaUrlMinter };
});

// The gate itself needs a real database to acquire an advisory lock, so it is
// stubbed here and driven for real by
// `packages/database/__tests__/preview-seed-lock.test.ts`. It admits by default
// so the seed path stays under test; the refusal branches are asserted below.
vi.mock("@repo/database/scripts/preview-seed-lock", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/database/scripts/preview-seed-lock")
  >("@repo/database/scripts/preview-seed-lock");
  return { ...actual, withPreviewSeedAdmission: mockWithPreviewSeedAdmission };
});

// ISS-12056: the marker read opens a connection; driven for real by
// `packages/database/scripts/__tests__/vibe-environment.test.ts`.
vi.mock("@repo/database/scripts/vibe-environment", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/database/scripts/vibe-environment")
  >("@repo/database/scripts/vibe-environment");
  return {
    ...actual,
    readVibeEnvironmentMarker: mockReadVibeEnvironmentMarker,
  };
});

import { bodyOfBytes } from "@/__tests__/support/preview-schemas/request-bodies";
import { PREVIEW_SCHEMA_REQUEST_MAX_BYTES } from "@/app/preview-schemas/constants";
import { POST } from "@/app/preview-schemas/seed/route";
import {
  SEED_SKIPPED_VIBE_ENVIRONMENT,
  seedPreviewSchema,
} from "@/app/preview-schemas/seed/service";
import { IAM_NOT_CONFIGURED_MESSAGE } from "@/app/preview-schemas/service/iam-schema-url";
import { GitHubOidcCaller } from "@/lib/auth/github-oidc-auth";

const BRANCH = "feat/iss-6804-probe";
const SCHEMA = deriveBranchSchemaName(BRANCH, normalizePreviewSchemaName);
const OIDC_HEADER = "Bearer test-oidc-token";
const SUMMARY = {
  organizationId: "org-1",
  userId: "user-1",
  elapsedMs: 4321,
};
// Credential-shaped fixtures: the IAM password and signature that a signer or
// pg failure can quote, and which must reach neither the response nor a log.
const IAM_PASSWORD = "v1.iam.tok3n.NOTAREALSECRET";
const IAM_SIGNATURE = "deadbeefcafe1234";
const CREDENTIAL_URL = `postgresql://vercel_iam:${IAM_PASSWORD}@stage.rds.amazonaws.com:5432/closedloop`;

function seedRequest(
  body: unknown,
  headers: Record<string, string> = { authorization: OIDC_HEADER }
) {
  const request = new Request(
    "https://api-stage-abc.preview.stage.example/preview-schemas/seed",
    { method: "POST", body: JSON.stringify(body), headers }
  );
  return request as Parameters<typeof POST>[0];
}

/*
 * ISS-6804. The seed route is the ensure route's sibling: same auth mechanism
 * (its OWN caller), same fail-closed host invariant, same IAM-only URL. What it
 * runs is `runPreviewSeedInProcess`, mocked here — the seed program itself is
 * driven for real by `packages/database/__tests__/seed-program.test.ts`.
 */
describe("preview schema seed route", () => {
  beforeEach(() => {
    mockValidateGitHubOidcToken.mockResolvedValue(null);
    mockReadVibeEnvironmentMarker.mockResolvedValue(null);
    mockWithPreviewSeedAdmission.mockImplementation(
      async (_deps: unknown, fn: () => Promise<unknown>) => ({
        admitted: true,
        result: await fn(),
      })
    );
    mockRunPreviewSeedInProcess.mockResolvedValue({
      ran: true,
      ok: true,
      summary: SUMMARY,
    });
    vi.stubEnv("DATABASE_URL", undefined);
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
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("short-circuits on a rejected GitHub OIDC token", async () => {
    mockValidateGitHubOidcToken.mockResolvedValue(
      new Response("Unauthorized", { status: 401 })
    );

    const response = await POST(seedRequest({ branch: BRANCH }, {}));

    expect(response.status).toBe(401);
    expect(mockRunPreviewSeedInProcess).not.toHaveBeenCalled();
    expect(mockScheduleLogFlush).not.toHaveBeenCalled();
  });

  it("authenticates against the seed caller, not the ensure caller", async () => {
    await POST(seedRequest({ branch: BRANCH }));

    expect(mockValidateGitHubOidcToken).toHaveBeenCalledWith(
      expect.anything(),
      { caller: GitHubOidcCaller.PreviewSchemaSeed }
    );
    expect(GitHubOidcCaller.PreviewSchemaSeed.audience).not.toBe(
      GitHubOidcCaller.PreviewSchemaEnsure.audience
    );
  });

  it("rejects a body without a branch", async () => {
    const response = await POST(seedRequest({}));

    expect(response.status).toBe(400);
    expect(mockRunPreviewSeedInProcess).not.toHaveBeenCalled();
  });

  it("seeds the branch's preview schema over an IAM-minted, schema-scoped URL", async () => {
    const response = await POST(seedRequest({ branch: BRANCH }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { branch: BRANCH, schema: SCHEMA, ...SUMMARY },
    });
    expect(mockRunPreviewSeedInProcess).toHaveBeenCalledWith(
      `postgresql://minted/${SCHEMA}`,
      SCHEMA,
      process.env,
      expect.objectContaining({
        log: expect.any(Function),
        warn: expect.any(Function),
        error: expect.any(Function),
      })
    );
  });

  it("never seeds a vibe environment, answering that it skipped it (ISS-12056)", async () => {
    mockReadVibeEnvironmentMarker.mockResolvedValue({
      mode: VibeEnvironmentMode.Blank,
      state: VibeEnvironmentState.Ready,
    });

    const response = await POST(seedRequest({ branch: BRANCH }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        branch: BRANCH,
        schema: SCHEMA,
        skipped: SEED_SKIPPED_VIBE_ENVIRONMENT,
      },
    });
    expect(mockReadVibeEnvironmentMarker).toHaveBeenCalledWith(
      `postgresql://minted/${SCHEMA}`,
      SCHEMA
    );
    expect(mockRunPreviewSeedInProcess).not.toHaveBeenCalled();
    expect(mockWithPreviewSeedAdmission).not.toHaveBeenCalled();
  });

  it("rejects a branch outside the shared character class", async () => {
    const response = await POST(seedRequest({ branch: "@@@" }));

    expect(response.status).toBe(400);
    expect(mockRunPreviewSeedInProcess).not.toHaveBeenCalled();
  });

  it("accepts a branch at the shared name bound and rejects one past it", async () => {
    const atBound = "a".repeat(BRANCH_NAME_MAX_LENGTH);
    const pastBound = "a".repeat(BRANCH_NAME_MAX_LENGTH + 1);

    expect((await POST(seedRequest({ branch: atBound }))).status).toBe(200);

    mockRunPreviewSeedInProcess.mockClear();
    const rejected = await POST(seedRequest({ branch: pastBound }));

    expect(rejected.status).toBe(400);
    expect(mockRunPreviewSeedInProcess).not.toHaveBeenCalled();
  });

  it("accepts a body at the request cap and refuses one past it", async () => {
    // A valid or replayed token must not be able to make the function read and
    // normalize an arbitrarily large payload (review: davetho). ISS-6985 made
    // the cap shared with the two sibling routes, so the at-cap arm is what
    // keeps a future change to that one value from silently narrowing THIS
    // route while the other two suites stay green.
    const atCap = bodyOfBytes(
      { branch: BRANCH },
      PREVIEW_SCHEMA_REQUEST_MAX_BYTES
    );
    expect(JSON.stringify(atCap).length).toBe(PREVIEW_SCHEMA_REQUEST_MAX_BYTES);

    expect((await POST(seedRequest(atCap))).status).toBe(200);

    mockRunPreviewSeedInProcess.mockClear();
    const refused = await POST(
      seedRequest(
        bodyOfBytes({ branch: BRANCH }, PREVIEW_SCHEMA_REQUEST_MAX_BYTES + 1)
      )
    );

    expect(refused.status).toBe(413);
    expect(mockRunPreviewSeedInProcess).not.toHaveBeenCalled();
  });

  it("admits the seed under this schema's own admission lock", async () => {
    await POST(seedRequest({ branch: BRANCH }));

    expect(mockWithPreviewSeedAdmission).toHaveBeenCalledWith(
      { databaseUrl: `postgresql://minted/${SCHEMA}`, schema: SCHEMA },
      expect.any(Function)
    );
  });

  it("answers a duplicate delivery with 409 instead of seeding twice", async () => {
    // The second of two dispatches for the same schema: a peer holds the lock,
    // so the identical work is already in flight. Not a seed failure.
    mockWithPreviewSeedAdmission.mockResolvedValue({
      admitted: false,
      refusal: SeedAdmissionRefusal.Contended,
      detail: "canceled on lock_timeout",
    });

    const response = await POST(seedRequest({ branch: BRANCH }));

    expect(response.status).toBe(409);
    expect(await response.text()).toContain(SCHEMA);
    // Fails CLOSED: the concurrent seed does not run.
    expect(mockRunPreviewSeedInProcess).not.toHaveBeenCalled();
  });

  it("answers an unestablished gate with 500, not the duplicate's 409", async () => {
    // A gate that could not be established is a real failure — kept distinct so
    // a broken database cannot be read as a benign duplicate dispatch.
    mockWithPreviewSeedAdmission.mockResolvedValue({
      admitted: false,
      refusal: SeedAdmissionRefusal.Unavailable,
      detail: `connection to ${CREDENTIAL_URL} refused`,
    });

    const response = await POST(seedRequest({ branch: BRANCH }));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(mockRunPreviewSeedInProcess).not.toHaveBeenCalled();
    expect(body).not.toContain(IAM_PASSWORD);
  });

  it("refuses when PGHOST is not the allowlisted non-production host", async () => {
    // Fails CLOSED: an unset STAGE_PGHOST is production's shape.
    vi.stubEnv("STAGE_PGHOST", undefined);

    const response = await POST(seedRequest({ branch: BRANCH }));

    expect(response.status).toBe(403);
    expect(mockCreateSchemaUrlMinter).not.toHaveBeenCalled();
    expect(mockRunPreviewSeedInProcess).not.toHaveBeenCalled();
    // Nothing about which hosts are involved reaches the body.
    expect(await response.text()).not.toContain("stage.rds.amazonaws.com");
  });

  it("refuses a schema that is not a preview schema, before minting a URL", async () => {
    const result = await seedPreviewSchema(BRANCH, "public");

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("not_a_preview_schema");
    expect(mockCreateSchemaUrlMinter).not.toHaveBeenCalled();
    expect(mockRunPreviewSeedInProcess).not.toHaveBeenCalled();
  });

  it("reports database credentials that are not configured", async () => {
    vi.stubEnv("PGDATABASE", undefined);

    const response = await POST(seedRequest({ branch: BRANCH }));

    expect(response.status).toBe(500);
    expect(await response.text()).toContain(IAM_NOT_CONFIGURED_MESSAGE);
    expect(mockRunPreviewSeedInProcess).not.toHaveBeenCalled();
  });

  it("surfaces a seed failure as a 500 naming the schema, with the connection redacted", async () => {
    mockRunPreviewSeedInProcess.mockResolvedValue({
      ran: true,
      ok: false,
      error:
        "Refusing to seed: connection postgresql://vercel_iam:v1.token@stage.rds.amazonaws.com:5432/closedloop rejected",
    });

    const response = await POST(seedRequest({ branch: BRANCH }));

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain(SCHEMA);
    expect(body).toContain("Refusing to seed");
    expect(body).not.toContain("v1.token");
  });

  it("answers in its JSON envelope when a precondition throws", async () => {
    mockCreateSchemaUrlMinter.mockImplementation(() => {
      throw new Error("bad IAM config");
    });

    const response = await POST(seedRequest({ branch: BRANCH }));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      success: false,
      error: expect.stringContaining("Failed to seed a schema"),
    });
    expect(mockScheduleLogFlush).not.toHaveBeenCalled();
  });

  it("reflects no part of a credential-shaped throw in the response body", async () => {
    // An IAM signer / module-load throw is not the seed's own sanitized
    // failure: it can quote the minted URL, and the workflow step prints this
    // body. The catch answers a FIXED message (review: davetho).
    mockCreateSchemaUrlMinter.mockImplementation(() => {
      throw new Error(
        `signer misconfigured for ${CREDENTIAL_URL} (X-Amz-Signature=${IAM_SIGNATURE})`
      );
    });

    const response = await POST(seedRequest({ branch: BRANCH }));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(IAM_PASSWORD);
    expect(body).not.toContain(IAM_SIGNATURE);
    expect(body).not.toContain("X-Amz-Signature");
    expect(body).not.toContain("stage.rds.amazonaws.com");
    // Not merely redacted — the exception text is not reflected at all.
    expect(body).not.toContain("signer misconfigured");
  });

  it("sanitizes the seed program's own logging so no credential reaches any log sink", async () => {
    // The seed program writes through the logger the service injects. Drive it
    // the way `runSeedProgram` does — including `logger.error(error)` with an
    // Error instance — and assert the SINK, not just the returned copy.
    mockRunPreviewSeedInProcess.mockImplementation(
      (
        _url: string,
        _schema: string,
        _env: NodeJS.ProcessEnv,
        logger: Pick<Console, "log" | "warn" | "error">
      ) => {
        logger.log(`[seed] connecting to ${CREDENTIAL_URL}`);
        logger.warn(`[seed] WARN: retrying against ${CREDENTIAL_URL}`);
        logger.error(
          new Error(
            `pg: password authentication failed for ${CREDENTIAL_URL} X-Amz-Signature=${IAM_SIGNATURE}`
          )
        );
        return Promise.resolve({
          ran: true,
          ok: false,
          error: `seed failed against ${CREDENTIAL_URL}`,
        });
      }
    );

    const response = await POST(seedRequest({ branch: BRANCH }));

    const sink = [
      ...mockLogInfo.mock.calls,
      ...mockLogWarn.mock.calls,
      ...mockLogError.mock.calls,
    ]
      .map((call) => JSON.stringify(call))
      .join("\n");

    expect(sink).not.toContain(IAM_PASSWORD);
    expect(sink).not.toContain(IAM_SIGNATURE);
    expect(sink).not.toContain("stage.rds.amazonaws.com");
    // CLI diagnostics survive the sanitizer — the operator keeps the message,
    // so this is redaction rather than suppression.
    expect(sink).toContain("[seed] connecting to");
    expect(sink).toContain("password authentication failed");
    // And the response stays redacted on the same failure.
    expect(await response.text()).not.toContain(IAM_PASSWORD);
  });
});
