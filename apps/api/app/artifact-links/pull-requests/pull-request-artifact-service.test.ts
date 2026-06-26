import { GitHubPRState } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import {
  findAssertionMismatch,
  isSafeRepositorySegment,
  parseGitHubPullRequestUrl,
} from "./pull-request-artifact-service";
import type { CreatePrArtifactInput } from "./route-contract";

// ---------------------------------------------------------------------------
// parseGitHubPullRequestUrl
// ---------------------------------------------------------------------------

describe("parseGitHubPullRequestUrl", () => {
  it.each([
    [
      "canonical PR URL",
      "https://github.com/acme/my-repo/pull/42",
      { owner: "acme", repo: "my-repo", number: 42, fullName: "acme/my-repo" },
    ],
    [
      "PR with trailing slash is accepted",
      "https://github.com/acme/my-repo/pull/1/",
      { owner: "acme", repo: "my-repo", number: 1, fullName: "acme/my-repo" },
    ],
    [
      "owner/repo with dots and hyphens",
      "https://github.com/my-org/repo.name/pull/99",
      {
        owner: "my-org",
        repo: "repo.name",
        number: 99,
        fullName: "my-org/repo.name",
      },
    ],
    [
      "PR number 1 (smallest valid)",
      "https://github.com/org/repo/pull/1",
      { owner: "org", repo: "repo", number: 1, fullName: "org/repo" },
    ],
  ])("parses valid %s", (_label, input, expected) => {
    expect(parseGitHubPullRequestUrl(input)).toEqual(expected);
  });

  it.each([
    ["http (non-https)", "http://github.com/acme/repo/pull/1"],
    ["non-github host", "https://gitlab.com/acme/repo/pull/1"],
    [
      "embedded userinfo (SSRF)",
      "https://user:pass@github.com/acme/repo/pull/1",
    ],
    ["embedded username only", "https://user@github.com/acme/repo/pull/1"],
    ["PR number zero", "https://github.com/acme/repo/pull/0"],
    ["missing /pull/ segment", "https://github.com/acme/repo/issues/1"],
    ["too many path segments", "https://github.com/acme/repo/pull/1/files"],
    ["missing repo segment", "https://github.com/acme/pull/1"],
    ["percent-encoded owner", "https://github.com/ac%2Fme/repo/pull/1"],
    ["empty string", ""],
    ["not a URL", "not-a-url"],
    ["javascript: scheme", "javascript:alert(1)"],
    ["data: URI", "data:text/html,<h1>xss</h1>"],
    ["ftp scheme", "ftp://github.com/acme/repo/pull/1"],
  ])("returns null for %s", (_label, input) => {
    expect(parseGitHubPullRequestUrl(input)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isSafeRepositorySegment
// ---------------------------------------------------------------------------

describe("isSafeRepositorySegment", () => {
  it.each([
    ["simple name", "acme"],
    ["name with hyphen", "my-org"],
    ["name with underscore", "my_repo"],
    ["name with dot", "repo.js"],
    ["name with digits", "org123"],
    ["mixed alphanumeric", "Abc-Def_123.ghi"],
  ])("accepts %s", (_label, input) => {
    expect(isSafeRepositorySegment(input)).toBe(true);
  });

  it.each([
    ["percent-encoded slash", "ac%2Fme"],
    ["percent-encoded dot", "re%2Eme"],
    ["percent-encoded at-sign", "re%40me"],
    ["forward slash", "ac/me"],
    ["control character NUL", "abc\x00def"],
    ["control character DEL (0x7F)", "abc\x7fdef"],
    ["control character 0x01", "abc\x01def"],
    ["empty string", ""],
    ["invalid percent sequence", "%GG"],
    ["space", "my org"],
    ["at-sign", "@org"],
  ])("rejects %s", (_label, input) => {
    expect(isSafeRepositorySegment(input)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findAssertionMismatch
// ---------------------------------------------------------------------------

type LivePR = {
  githubId: string;
  number: number;
  title: string;
  htmlUrl: string;
  headBranch: string;
  baseBranch: string;
  state: (typeof GitHubPRState)[keyof typeof GitHubPRState];
  mergedAt: string | null;
  closedAt: string | null;
  authorLogin: string | null;
  isDraft: boolean;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
};

function makeLivePr(overrides: Partial<LivePR> = {}): LivePR {
  return {
    githubId: "PR_kwDOA1234",
    number: 42,
    title: "feat: add thing",
    htmlUrl: "https://github.com/acme/repo/pull/42",
    headBranch: "feature-branch",
    baseBranch: "main",
    state: GitHubPRState.Open,
    mergedAt: null,
    closedAt: null,
    authorLogin: "alice",
    isDraft: false,
    headSha: "deadbeef",
    baseSha: "cafebabe",
    mergeCommitSha: null,
    ...overrides,
  };
}

function makeBody(
  overrides: Partial<CreatePrArtifactInput> = {}
): CreatePrArtifactInput {
  return {
    projectId: "00000000-0000-0000-0000-000000000001",
    title: "feat: add thing",
    externalUrl: "https://github.com/acme/repo/pull/42",
    number: 42,
    githubId: "PR_kwDOA1234",
    headBranch: "feature-branch",
    baseBranch: "main",
    state: GitHubPRState.Open,
    headSha: "deadbeef",
    isDraft: false,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    ...overrides,
  };
}

describe("findAssertionMismatch", () => {
  it("returns null when all required and optional fields match", () => {
    expect(findAssertionMismatch(makeBody(), makeLivePr())).toBeNull();
  });

  it("returns 'githubId' when required githubId does not match", () => {
    expect(
      findAssertionMismatch(makeBody({ githubId: "WRONG_ID" }), makeLivePr())
    ).toBe("githubId");
  });

  it("returns 'number' when required number does not match", () => {
    expect(findAssertionMismatch(makeBody({ number: 99 }), makeLivePr())).toBe(
      "number"
    );
  });

  it("returns 'state' when required state does not match", () => {
    expect(
      findAssertionMismatch(
        makeBody({ state: GitHubPRState.Closed }),
        makeLivePr({ state: GitHubPRState.Open })
      )
    ).toBe("state");
  });

  it("returns 'headSha' when optional headSha is provided and does not match", () => {
    expect(
      findAssertionMismatch(
        makeBody({ headSha: "wrongsha" }),
        makeLivePr({ headSha: "deadbeef" })
      )
    ).toBe("headSha");
  });

  it("returns null when optional headSha is undefined (not asserted)", () => {
    const body = makeBody();
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    const { headSha: _removed, ...bodyWithoutHeadSha } = body;
    expect(
      findAssertionMismatch(
        bodyWithoutHeadSha as CreatePrArtifactInput,
        makeLivePr({ headSha: "anything" })
      )
    ).toBeNull();
  });

  it("returns 'isDraft' when optional isDraft does not match", () => {
    expect(
      findAssertionMismatch(
        makeBody({ isDraft: true }),
        makeLivePr({ isDraft: false })
      )
    ).toBe("isDraft");
  });

  it("returns 'closedAt' when optional closedAt iso strings do not match", () => {
    expect(
      findAssertionMismatch(
        makeBody({ closedAt: "2024-01-01T00:00:00.000Z" }),
        makeLivePr({ closedAt: "2024-06-01T00:00:00.000Z" })
      )
    ).toBe("closedAt");
  });

  it("returns null when closedAt strings represent the same instant in different formats", () => {
    // Both normalize to the same ISO string via new Date().toISOString()
    expect(
      findAssertionMismatch(
        makeBody({ closedAt: "2024-01-01T00:00:00.000Z" }),
        makeLivePr({ closedAt: "2024-01-01T00:00:00.000Z" })
      )
    ).toBeNull();
  });

  it("returns 'mergeCommitSha' when optional mergeCommitSha does not match", () => {
    expect(
      findAssertionMismatch(
        makeBody({ mergeCommitSha: "aaaaaa" }),
        makeLivePr({ mergeCommitSha: "bbbbbb" })
      )
    ).toBe("mergeCommitSha");
  });

  it("checks required fields before optional fields (githubId mismatch shadows headSha mismatch)", () => {
    expect(
      findAssertionMismatch(
        makeBody({ githubId: "WRONG", headSha: "alsowrong" }),
        makeLivePr()
      )
    ).toBe("githubId");
  });
});
