import {
  BRANCH_NAME_MAX_LENGTH,
  BranchBaseBranchSource,
} from "@repo/api/src/types/artifact";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  branchUpsert: vi.fn(),
  db: {
    project: {
      findUnique: vi.fn(),
    },
  },
  loadProjectRepoDefaults: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, _context: unknown) =>
      handler({ user: mocks.user }, request),
}));

vi.mock("@repo/database", () => ({
  withDb: vi.fn((callback: (db: typeof mocks.db) => unknown) =>
    callback(mocks.db)
  ),
}));

vi.mock("@/app/projects/repository-resolver", () => ({
  loadProjectRepoDefaults: mocks.loadProjectRepoDefaults,
}));

vi.mock("@/app/branches/branch-service", () => ({
  branchService: {
    upsertBranchArtifact: mocks.branchUpsert,
  },
}));

import { POST } from "./route";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";

function request(body: unknown) {
  return new NextRequest("https://api.example.test/artifact-links/branches", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function routeContext() {
  return { params: Promise.resolve({}) };
}

describe("POST /artifact-links/branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.project.findUnique.mockResolvedValue({
      id: PROJECT_ID,
      settings: {},
    });
    mocks.loadProjectRepoDefaults.mockResolvedValue({
      primary: {
        installationRepositoryId: "repo-1",
        fullName: "closedloop-ai/closedloop-ai",
      },
    });
  });

  /**
   * ISS-10995: `projectId` here is REQUIRED and the caller's own choice
   * (`z.uuid()`, validated against the org above), so it files the branch
   * unconditionally — the fill-only rule the 2026-10-12 ruling set is the
   * SYNC's. A `projectFillOnly` on this producer would make the route answer
   * 200 for a re-file it discarded, which `pull-requests/route.ts`'s own
   * ISS-10169 contract note forbids.
   */
  it("asks for an unconditional project write, never the sync's fill", async () => {
    mocks.branchUpsert.mockResolvedValue({ ok: true, value: { id: "b-1" } });

    const response = await POST(
      request({ projectId: PROJECT_ID, branchName: "feature/refile" }),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.branchUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID }),
      undefined
    );
    expect(mocks.branchUpsert.mock.calls[0]?.[0]).not.toHaveProperty(
      "projectFillOnly"
    );
  });

  // ISS-8175: `DesktopPullRequestBase` outranks `McpInput` because it is gh's
  // own answer rather than an agent's claim, so a client that could NAME it
  // would buy that rank for free. Adding the member to the const object widened
  // this `z.enum` by derivation and nothing failed tsc — hence the explicit
  // refusal, and hence this pair (an accepted source alongside it, so the
  // rejection cannot be a blanket one).
  it("refuses a client-asserted desktop PR base source but accepts MCP input", async () => {
    mocks.branchUpsert.mockResolvedValue({ ok: true, value: { id: "b-1" } });
    const body = {
      projectId: PROJECT_ID,
      branchName: "feature/spoof",
      baseBranch: "release/2026-08",
    };

    const refused = await POST(
      request({
        ...body,
        baseBranchSource: BranchBaseBranchSource.DesktopPullRequestBase,
      }),
      routeContext()
    );
    expect(refused.status).toBe(400);
    expect(mocks.branchUpsert).not.toHaveBeenCalled();

    const accepted = await POST(
      request({ ...body, baseBranchSource: BranchBaseBranchSource.McpInput }),
      routeContext()
    );
    expect(accepted.status).toBe(200);
    expect(mocks.branchUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranchSource: BranchBaseBranchSource.McpInput,
      }),
      undefined
    );
  });

  it("returns a typed rejection when service validation denies a source artifact", async () => {
    mocks.branchUpsert.mockResolvedValue({ ok: false, error: 403 });

    const response = await POST(
      request({
        projectId: PROJECT_ID,
        sourceArtifactId: SOURCE_ARTIFACT_ID,
        branchName: "feature/non-document-spoof",
        defaultBranch: "main",
        baseBranch: "main",
        baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
        headSha: "head-sha",
        sourceArtifactTargetRepoAllowlist: ["closedloop-ai/closedloop-ai"],
        sourceArtifactTargetRepoAuthorization: {
          provenance: "spoofed",
          repositoryFullNames: ["closedloop-ai/closedloop-ai"],
        },
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Source artifact is not eligible");
    expect(mocks.branchUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        repositoryId: "repo-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        sourceArtifactId: SOURCE_ARTIFACT_ID,
      }),
      undefined
    );
    expect(mocks.branchUpsert.mock.calls[0]?.[0]).not.toHaveProperty(
      "sourceArtifactTargetRepoAllowlist"
    );
    expect(mocks.branchUpsert.mock.calls[0]?.[0]).not.toHaveProperty(
      "sourceArtifactTargetRepoAuthorization"
    );
  });

  it("rejects branch names over the shared branch-name limit before service work", async () => {
    const response = await POST(
      request({
        projectId: PROJECT_ID,
        branchName: "a".repeat(BRANCH_NAME_MAX_LENGTH + 1),
        defaultBranch: "main",
      }),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.branchUpsert).not.toHaveBeenCalled();
  });
});
