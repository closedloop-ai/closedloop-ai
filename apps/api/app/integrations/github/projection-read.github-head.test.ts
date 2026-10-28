import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ORG,
  PARITY_BRANCH_ARTIFACT_NAME,
  PARITY_PR,
  parityRow,
  REPO,
} from "@/__tests__/support/integrations/github/projection-read.test-fixtures";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
}));

vi.mock("./tracked-pull-requests", () => ({
  getTrackedPullRequestState: vi.fn(),
}));

import { withDb } from "@repo/database";
import { readRepositoryPullRequestsFromProjection } from "./projection-read";

/**
 * ISS-12344 decision record (thread th_1__bTDiF9jNPx9ebLHmn0): the projection
 * tells the desktop which head GitHub itself confirmed, so the desktop can take
 * it over its own stored head. `headBranch` cannot say that: it falls back to
 * the filing Branch's name while `head_ref_name` is unread.
 */
describe("projection read gitHubHeadBranch", () => {
  const prFindMany = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withDb).mockImplementation(((fn: (client: unknown) => unknown) =>
      fn({ pullRequestDetail: { findMany: prFindMany } })) as never);
  });

  it("serves the head GitHub reported when it lives in the PR's repository", async () => {
    prFindMany.mockResolvedValue([
      parityRow({
        repositoryFullName: "acme/widgets",
        headRepositoryFullName: "Acme/Widgets",
      }),
    ]);

    const [pr] = await readFirstPage();

    expect(pr.gitHubHeadBranch).toBe(PARITY_PR.headRefName);
  });

  it("compares an App row through its installation repository's name", async () => {
    prFindMany.mockResolvedValue([
      parityRow({
        repositoryFullName: null,
        repository: { fullName: "acme/widgets" },
        headRepositoryFullName: "acme/widgets",
      }),
    ]);

    const [pr] = await readFirstPage();

    expect(pr.gitHubHeadBranch).toBe(PARITY_PR.headRefName);
  });

  it("omits it while GitHub has not reported this PR's head", async () => {
    prFindMany.mockResolvedValue([
      parityRow({
        headRefName: null,
        repositoryFullName: "acme/widgets",
        headRepositoryFullName: "acme/widgets",
      }),
    ]);

    const [pr] = await readFirstPage();

    expect(pr.headBranch).toBe(PARITY_BRANCH_ARTIFACT_NAME);
    expect(pr).not.toHaveProperty("gitHubHeadBranch");
  });

  it("omits it for a head that lives in a fork", async () => {
    prFindMany.mockResolvedValue([
      parityRow({
        repositoryFullName: "acme/widgets",
        headRepositoryFullName: "contributor/widgets",
      }),
    ]);

    const [pr] = await readFirstPage();

    expect(pr.headBranch).toBe(PARITY_PR.headRefName);
    expect(pr).not.toHaveProperty("gitHubHeadBranch");
  });

  it("selects the PR's own repository name for the comparison", async () => {
    prFindMany.mockResolvedValue([parityRow()]);

    await readFirstPage();

    expect(prFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          repositoryFullName: true,
          repository: { select: { fullName: true } },
          headRepositoryFullName: true,
        }),
      })
    );
  });

  async function readFirstPage() {
    return (
      await readRepositoryPullRequestsFromProjection(
        { repositoryId: REPO },
        ORG,
        {
          limit: 30,
          targetNumbers: [],
        }
      )
    ).pullRequests;
  }
});
