import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const indexAfterCommit = vi.hoisted(() => vi.fn());

vi.mock("@/app/search/search-index-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/search/search-index-service")
  >("@/app/search/search-index-service");
  return {
    ...actual,
    searchIndexService: { indexAfterCommit, removeAfterCommit: vi.fn() },
  };
});

import { indexBranchArtifactAfterCommit } from "./branch-search-index";

type IndexableBranchArtifact = Parameters<
  typeof indexBranchArtifactAfterCommit
>[0];

const AT = new Date("2026-07-24T00:00:00.000Z");

describe("indexBranchArtifactAfterCommit (FEA-3930 write hook)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("indexes a branch keyed on its artifact id with repo/base-branch body", () => {
    indexBranchArtifactAfterCommit({
      id: "branch-artifact-1",
      organizationId: "org-1",
      updatedAt: AT,
      branch: {
        branchName: "feature/search",
        baseBranch: "main",
        repositoryFullName: "acme/widgets",
      },
      pullRequest: null,
    });

    expect(indexAfterCommit).toHaveBeenCalledTimes(1);
    expect(indexAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: SearchEntityType.Branch,
        entityId: "branch-artifact-1",
        title: "feature/search",
        body: "acme/widgets main",
        anchorEntityId: null,
      })
    );
  });

  it("also indexes the current pull request, routed to the branch anchor", () => {
    indexBranchArtifactAfterCommit({
      id: "branch-artifact-2",
      organizationId: "org-1",
      updatedAt: AT,
      branch: {
        branchName: "feature/pr",
        baseBranch: null,
        repositoryFullName: "acme/widgets",
      },
      pullRequest: {
        id: "pr-9",
        title: "Fix the thing",
        body: "the PR description",
      },
    });

    expect(indexAfterCommit).toHaveBeenCalledTimes(2);
    // The PR row routes to its owning branch via anchorEntityId.
    expect(indexAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: SearchEntityType.PullRequest,
        entityId: "pr-9",
        title: "Fix the thing",
        body: "the PR description",
        anchorEntityId: "branch-artifact-2",
        updatedAt: AT,
      })
    );
  });

  it("indexes nothing when the artifact has no branch detail", () => {
    indexBranchArtifactAfterCommit({
      id: "branch-artifact-3",
      organizationId: "org-1",
      updatedAt: AT,
      branch: null,
      pullRequest: null,
    });
    expect(indexAfterCommit).not.toHaveBeenCalled();
  });

  it("is fail-open: a partial branch shape (no repositoryFullName) never throws into the caller", () => {
    // A legacy/partial branch row can surface `repositoryFullName` as undefined
    // even though the type declares it `string`. This hook is documented to
    // never block or fail the authoritative branch write, so it must swallow the
    // malformed shape rather than throw synchronously while building the body.
    const partial = {
      id: "branch-artifact-4",
      organizationId: "org-1",
      updatedAt: AT,
      branch: { branchName: "feature/partial", baseBranch: "main" },
      pullRequest: null,
    } as unknown as IndexableBranchArtifact;

    expect(() => indexBranchArtifactAfterCommit(partial)).not.toThrow();
  });
});
