import {
  OperationClaimSource,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import { describe, expect, it } from "vitest";
import {
  implementationJoinClaims,
  implementationRequestsByBranch,
} from "./implementation-requests";
import {
  GitWriteAction,
  type RepositoryActivity,
  RepositoryActivityKind,
} from "./repository-write-claims";

// ISS-12552: the write-to-commit join.

let second = 0;
function at(): string {
  second += 1;
  return `2026-10-20T12:00:${String(second).padStart(2, "0")}.000Z`;
}

function write(
  requestKey: string,
  paths: string[],
  resultState: ToolResultState = ToolResultState.Present
): RepositoryActivity {
  return {
    key: `claude:write:${requestKey}:${paths.join()}`,
    kind: RepositoryActivityKind.FileWrite,
    requestKey,
    paths,
    resultState,
    invokedAt: at(),
  };
}

function commit(
  requestKey: string,
  branch: string,
  listing: { changedPaths?: string[]; filesChanged?: number } = {},
  resultState: ToolResultState = ToolResultState.Present
): RepositoryActivity {
  return {
    key: `claude:git:${requestKey}`,
    kind: RepositoryActivityKind.GitWrite,
    gitAction: GitWriteAction.Commit,
    branch,
    requestKey,
    resultState,
    invokedAt: at(),
    ...listing,
  };
}

const proven = (claims: RepositoryActivity[]) =>
  Object.fromEntries(
    [...implementationRequestsByBranch(claims)].map(([branch, keys]) => [
      branch,
      [...keys].sort(),
    ])
  );

describe("implementationRequestsByBranch", () => {
  it("proves the requests that wrote what a commit captured, and the commit's own request", () => {
    expect(
      proven([
        write("req-a", ["/repo/src/a.ts"]),
        write("req-b", ["/repo/src/b.ts"]),
        commit("req-c", "feat/x", {
          changedPaths: ["src/a.ts"],
          filesChanged: 1,
        }),
      ])
    ).toEqual({ "feat/x": ["req-a", "req-c"] });
  });

  it("takes every write since the last commit when the output does not list every file", () => {
    expect(
      proven([
        write("req-a", ["/repo/src/a.ts"]),
        write("req-b", ["/repo/src/b.ts"]),
        commit("req-c", "feat/x", {
          changedPaths: ["src/new.ts"],
          filesChanged: 3,
        }),
      ])
    ).toEqual({ "feat/x": ["req-a", "req-b", "req-c"] });
  });

  it("lets a path be captured by the first commit that takes it", () => {
    expect(
      proven([
        write("req-a", ["/repo/src/a.ts"]),
        commit("req-c1", "feat/x"),
        commit("req-c2", "feat/y"),
      ])
    ).toEqual({ "feat/x": ["req-a", "req-c1"], "feat/y": ["req-c2"] });
  });

  it("proves nothing from a failed write or a failed commit", () => {
    expect(
      proven([
        write("req-a", ["/repo/src/a.ts"], ToolResultState.Error),
        commit("req-c", "feat/x", {}, ToolResultState.Error),
      ])
    ).toEqual({});
  });

  it("joins one request to each branch whose commit captured one of its writes", () => {
    expect(
      proven([
        write("req-a", ["/repo/src/a.ts"]),
        write("req-a", ["/repo/src/b.ts"]),
        commit("req-c1", "feat/x", {
          changedPaths: ["src/a.ts"],
          filesChanged: 1,
        }),
        commit("req-c2", "feat/y", {
          changedPaths: ["src/b.ts"],
          filesChanged: 1,
        }),
      ])
    ).toEqual({
      "feat/x": ["req-a", "req-c1"],
      "feat/y": ["req-a", "req-c2"],
    });
  });

  it("syncs one claim per branch holding only the branch and its request keys, never a path", () => {
    const claims = implementationJoinClaims("claude", [
      write("req-w", ["/repo/src/a.ts"]),
      commit("req-c", "feat/x", {
        changedPaths: ["src/a.ts"],
        filesChanged: 1,
      }),
    ]);

    expect(claims).toEqual([
      {
        claimKey: "claude:implementation:feat/x",
        source: OperationClaimSource.ImplementationJoin,
        branch: "feat/x",
        requestKeys: ["req-c", "req-w"],
      },
    ]);
    expect(JSON.stringify(claims)).not.toContain("src/a.ts");
  });
});
