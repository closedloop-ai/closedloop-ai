import { describe, expect, it } from "vitest";
import { gitHubConfirmedHeadBranch } from "./pull-request-github-head";

describe("gitHubConfirmedHeadBranch", () => {
  it("returns the head when it lives in the PR's repository, whatever its casing", () => {
    expect(
      gitHubConfirmedHeadBranch({
        headBranch: "fix/search-reads-during-reindex",
        headRepositoryFullName: "ClosedLoop-AI/LemonCrow",
        repositoryFullName: "closedloop-ai/lemoncrow",
      })
    ).toBe("fix/search-reads-during-reindex");
  });

  it("skips a head that lives in a fork", () => {
    expect(
      gitHubConfirmedHeadBranch({
        headBranch: "read-config-gypi",
        headRepositoryFullName: "zcbenz/node-gyp",
        repositoryFullName: "nodejs/node-gyp",
      })
    ).toBeUndefined();
  });

  it.each([
    { name: "no head", headBranch: null, headRepositoryFullName: "a/b" },
    { name: "an empty head", headBranch: "", headRepositoryFullName: "a/b" },
    {
      name: "no head repository",
      headBranch: "x",
      headRepositoryFullName: null,
    },
  ])(
    "returns undefined for $name",
    ({ headBranch, headRepositoryFullName }) => {
      expect(
        gitHubConfirmedHeadBranch({
          headBranch,
          headRepositoryFullName,
          repositoryFullName: "a/b",
        })
      ).toBeUndefined();
    }
  );
});
