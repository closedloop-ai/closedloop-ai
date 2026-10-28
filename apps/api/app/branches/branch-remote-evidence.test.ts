import { describe, expect, it } from "vitest";
import { getOwnedCurrentPullRequestDetail } from "./branch-remote-evidence";

const BRANCH_ROW_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BRANCH_ROW_ID = "22222222-2222-4222-8222-222222222222";
const REPOSITORY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPOSITORY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type TestDetail = {
  id: string;
  branchArtifactId: string;
  isCurrent: boolean;
  repositoryId: string | null;
};

function detail(overrides: Partial<TestDetail> = {}): TestDetail {
  return {
    id: "detail-current",
    branchArtifactId: BRANCH_ROW_ID,
    isCurrent: true,
    repositoryId: REPOSITORY_A,
    ...overrides,
  };
}

function row(args: {
  branchRepositoryId: string | null;
  currentPullRequestDetail?: TestDetail | null;
  pullRequestDetails?: TestDetail[];
}) {
  return {
    id: BRANCH_ROW_ID,
    branch: {
      currentPullRequestDetail: args.currentPullRequestDetail ?? null,
      repositoryId: args.branchRepositoryId,
    },
    pullRequestDetails: args.pullRequestDetails ?? [],
  };
}

describe("getOwnedCurrentPullRequestDetail", () => {
  it("returns null for a row with no branch relation", () => {
    expect(
      getOwnedCurrentPullRequestDetail({
        id: BRANCH_ROW_ID,
        branch: null,
        pullRequestDetails: [detail()],
      })
    ).toBeNull();
  });

  it("rejects a current PR whose repository differs from the branch's", () => {
    expect(
      getOwnedCurrentPullRequestDetail(
        row({
          branchRepositoryId: REPOSITORY_A,
          currentPullRequestDetail: detail({ repositoryId: REPOSITORY_B }),
        })
      )
    ).toBeNull();
  });

  it("rejects a repository-less PR detail against a repository-scoped branch", () => {
    expect(
      getOwnedCurrentPullRequestDetail(
        row({
          branchRepositoryId: REPOSITORY_A,
          currentPullRequestDetail: detail({ repositoryId: null }),
        })
      )
    ).toBeNull();
  });

  it("rejects a repository-scoped PR detail against a repository-less branch", () => {
    expect(
      getOwnedCurrentPullRequestDetail(
        row({
          branchRepositoryId: null,
          currentPullRequestDetail: detail({ repositoryId: REPOSITORY_A }),
        })
      )
    ).toBeNull();
  });

  // FEA-2732 / PRD-510: a desktop-produced branch and PR in a non-App repo both
  // carry no installation-repo id, and `null === null` is the match that pairs
  // them. An over-eager null guard on either side silently unpairs every
  // desktop non-App branch from its own PR.
  it("matches a desktop non-App branch and PR that both carry no repository id", () => {
    const desktopDetail = detail({ repositoryId: null });
    expect(
      getOwnedCurrentPullRequestDetail(
        row({
          branchRepositoryId: null,
          currentPullRequestDetail: desktopDetail,
        })
      )
    ).toBe(desktopDetail);
  });

  it("rejects a candidate that is not the current PR", () => {
    expect(
      getOwnedCurrentPullRequestDetail(
        row({
          branchRepositoryId: REPOSITORY_A,
          currentPullRequestDetail: detail({ isCurrent: false }),
        })
      )
    ).toBeNull();
  });

  it("rejects a candidate owned by a different branch artifact", () => {
    expect(
      getOwnedCurrentPullRequestDetail(
        row({
          branchRepositoryId: REPOSITORY_A,
          currentPullRequestDetail: detail({
            branchArtifactId: OTHER_BRANCH_ROW_ID,
          }),
        })
      )
    ).toBeNull();
  });

  it("searches the branch's currentPullRequestDetail before pullRequestDetails", () => {
    const current = detail({ id: "detail-from-branch" });
    const listed = detail({ id: "detail-from-list" });
    expect(
      getOwnedCurrentPullRequestDetail(
        row({
          branchRepositoryId: REPOSITORY_A,
          currentPullRequestDetail: current,
          pullRequestDetails: [listed],
        })
      )
    ).toBe(current);
  });

  it("falls back to an owned pullRequestDetails entry when the branch has no current PR", () => {
    const listed = detail({ id: "detail-from-list" });
    expect(
      getOwnedCurrentPullRequestDetail(
        row({
          branchRepositoryId: REPOSITORY_A,
          currentPullRequestDetail: null,
          pullRequestDetails: [detail({ isCurrent: false }), listed],
        })
      )
    ).toBe(listed);
  });

  // Several entries CAN qualify at once: `@@index([branchArtifactId,
  // isCurrent])` is not unique, and `@@unique([repositoryId, number])` only
  // separates them by number. The case above already pins precedence BETWEEN
  // the two sources. What nothing pinned is the order WITHIN
  // `pullRequestDetails`: reversing that array alone changes which PR a branch
  // reports and every other case stays green. This pins first-match there, and
  // claims nothing about which qualifying row the select delivers first.
  it("takes the first qualifying entry when several pullRequestDetails match", () => {
    const first = detail({ id: "detail-first" });
    const second = detail({ id: "detail-second" });
    expect(
      getOwnedCurrentPullRequestDetail(
        row({
          branchRepositoryId: REPOSITORY_A,
          currentPullRequestDetail: null,
          pullRequestDetails: [first, second],
        })
      )
    ).toBe(first);
  });
});
