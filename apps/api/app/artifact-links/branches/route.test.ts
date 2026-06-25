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
        fullName: "closedloop-ai/symphony-alpha",
      },
    });
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
        sourceArtifactTargetRepoAllowlist: ["closedloop-ai/symphony-alpha"],
        sourceArtifactTargetRepoAuthorization: {
          provenance: "spoofed",
          repositoryFullNames: ["closedloop-ai/symphony-alpha"],
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
        repositoryFullName: "closedloop-ai/symphony-alpha",
        sourceArtifactId: SOURCE_ARTIFACT_ID,
      })
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
