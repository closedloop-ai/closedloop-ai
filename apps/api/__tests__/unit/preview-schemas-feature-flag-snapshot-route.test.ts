import { FEATURE_FLAG_SNAPSHOT_OIDC_AUDIENCE } from "@repo/api/src/types/feature-flag-snapshot";
import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { deriveBranchSchemaName } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockValidateGitHubOidcToken, mockQuery, mockWithMigratorClient } =
  vi.hoisted(() => ({
    mockValidateGitHubOidcToken: vi.fn(),
    mockQuery: vi.fn(),
    mockWithMigratorClient: vi.fn(),
  }));

vi.mock("@/lib/auth/github-oidc-auth", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/github-oidc-auth")
  >("@/lib/auth/github-oidc-auth");
  return { ...actual, validateGitHubOidcToken: mockValidateGitHubOidcToken };
});

vi.mock("@/app/preview-schemas/service/migrator-connection", () => ({
  withMigratorClient: mockWithMigratorClient,
}));

import { POST } from "@/app/preview-schemas/feature-flag-snapshot/route";
import { GitHubOidcCaller } from "@/lib/auth/github-oidc-auth";

const BRANCH = "feat/iss-12048-vibe";
const SCHEMA = deriveBranchSchemaName(BRANCH, normalizePreviewSchemaName);
const SNAPSHOT = {
  takenAt: "2026-10-06T15:00:00.000Z",
  distinctId: "user_2abc",
  orgId: "org_2xyz",
  flags: { "session-trace-tab": true, "pensero-integration": false },
};
const IAM_PASSWORD = "v1.iam.tok3n.NOTAREALSECRET";

function snapshotRequest(
  body: unknown,
  headers: Record<string, string> = { authorization: "Bearer test" }
) {
  return new Request(
    "https://api-stage-abc.preview.stage.example/preview-schemas/feature-flag-snapshot",
    { method: "POST", body: JSON.stringify(body), headers }
  ) as Parameters<typeof POST>[0];
}

/**
 * ISS-12048. The snapshot route is the seed route's sibling: GitHub OIDC with
 * its own caller, the same fail-closed host invariant, preview schemas only.
 * The write itself is a single upsert on the migrator connection, captured here.
 */
describe("preview schema feature flag snapshot route", () => {
  beforeEach(() => {
    mockValidateGitHubOidcToken.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ rowCount: 1 });
    mockWithMigratorClient.mockImplementation(
      (fn: (client: { query: typeof mockQuery }) => Promise<unknown>) =>
        fn({ query: mockQuery })
    );
    vi.stubEnv("PGHOST", "stage.rds.amazonaws.com");
    vi.stubEnv("STAGE_PGHOST", "stage.rds.amazonaws.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("authenticates against its own caller and audience", async () => {
    await POST(snapshotRequest({ branch: BRANCH, snapshot: SNAPSHOT }));

    expect(mockValidateGitHubOidcToken).toHaveBeenCalledWith(
      expect.anything(),
      { caller: GitHubOidcCaller.PreviewSchemaFeatureFlagSnapshot }
    );
    expect(GitHubOidcCaller.PreviewSchemaFeatureFlagSnapshot.audience).toBe(
      FEATURE_FLAG_SNAPSHOT_OIDC_AUDIENCE
    );
    expect(FEATURE_FLAG_SNAPSHOT_OIDC_AUDIENCE).not.toBe(
      GitHubOidcCaller.PreviewSchemaSeed.audience
    );
  });

  it("short-circuits on a rejected token without writing", async () => {
    mockValidateGitHubOidcToken.mockResolvedValue(
      new Response("Unauthorized", { status: 401 })
    );

    const response = await POST(
      snapshotRequest({ branch: BRANCH, snapshot: SNAPSHOT }, {})
    );

    expect(response.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("upserts the snapshot into the branch's preview schema", async () => {
    const response = await POST(
      snapshotRequest({ branch: BRANCH, snapshot: SNAPSHOT })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        branch: BRANCH,
        schema: SCHEMA,
        takenAt: SNAPSHOT.takenAt,
        flagCount: 2,
      },
    });
    const [sql, values] = mockQuery.mock.calls[0] ?? [];
    expect(sql).toContain(`"${SCHEMA}"."feature_flag_snapshots"`);
    expect(sql).toContain('ON CONFLICT ("id") DO UPDATE');
    expect(values).toEqual([
      "current",
      SNAPSHOT.distinctId,
      SNAPSHOT.orgId,
      new Date(SNAPSHOT.takenAt),
      JSON.stringify(SNAPSHOT.flags),
    ]);
  });

  it("rejects a malformed snapshot", async () => {
    const response = await POST(
      snapshotRequest({
        branch: BRANCH,
        snapshot: { ...SNAPSHOT, flags: { "a-flag": 3 } },
      })
    );

    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("refuses a database host that is not the allowlisted stage host", async () => {
    vi.stubEnv("PGHOST", "prod.rds.amazonaws.com");

    const response = await POST(
      snapshotRequest({ branch: BRANCH, snapshot: SNAPSHOT })
    );

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("answers a failed write without the credential the error quoted", async () => {
    mockQuery.mockRejectedValue(
      new Error(
        `connect to postgresql://vercel_iam:${IAM_PASSWORD}@stage.rds.amazonaws.com failed`
      )
    );

    const response = await POST(
      snapshotRequest({ branch: BRANCH, snapshot: SNAPSHOT })
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(IAM_PASSWORD);
  });
});
