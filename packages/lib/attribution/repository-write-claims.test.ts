import { ToolResultState } from "@repo/api/src/types/operation-claims";
import { describe, expect, it } from "vitest";
import type { NormalizedToolUse } from "../harness/types";
import {
  commitListing,
  fileWritePaths,
  GitWriteAction,
  RepositoryActivityKind,
  repositoryActivity,
} from "./repository-write-claims";

// ISS-12552: the facts the write-to-commit join reads.

function tool(extra: Partial<NormalizedToolUse>): NormalizedToolUse {
  return {
    name: "Bash",
    timestamp: "2026-10-20T12:00:00.000Z",
    input: {},
    output: "",
    ...extra,
  };
}

describe("fileWritePaths", () => {
  it("reads the one path a Write, Edit or NotebookEdit names, and every path a patch names", () => {
    expect(
      fileWritePaths(tool({ name: "Write", input: { file_path: "/r/a.ts" } }))
    ).toEqual(["/r/a.ts"]);
    expect(
      fileWritePaths(tool({ name: "Edit", input: { file_path: "/r/b.ts" } }))
    ).toEqual(["/r/b.ts"]);
    expect(
      fileWritePaths(
        tool({ name: "NotebookEdit", input: { notebook_path: "/r/n.ipynb" } })
      )
    ).toEqual(["/r/n.ipynb"]);
    expect(
      fileWritePaths(
        tool({
          name: "apply_patch",
          input:
            "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/c.ts\n+c\n*** End Patch",
        })
      )
    ).toEqual(["src/a.ts", "src/c.ts"]);
    expect(
      fileWritePaths(tool({ name: "Read", input: { file_path: "/r/a.ts" } }))
    ).toEqual([]);
  });
});

describe("commitListing", () => {
  it("reads the listed files and the changed-file count", () => {
    expect(
      commitListing(
        "[feat/x abc1234] add\n 2 files changed, 3 insertions(+)\n create mode 100644 src/new.ts\n delete mode 100644 src/old.ts\n"
      )
    ).toEqual({ changedPaths: ["src/new.ts", "src/old.ts"], filesChanged: 2 });
    expect(
      commitListing("[feat/x abc1234] tweak\n 1 file changed, 1 insertion(+)")
    ).toEqual({
      changedPaths: [],
      filesChanged: 1,
    });
  });
});

describe("repositoryActivity", () => {
  it("records file writes and reads the commit from the stream, each with its request", () => {
    const calls = [
      {
        tu: tool({
          name: "Write",
          id: "toolu_w",
          input: { file_path: "/r/a.ts" },
          output: "ok",
          requestKey: "req-w",
        }),
        toolIndex: 0,
        agentId: null,
      },
      {
        tu: tool({
          id: "toolu_c",
          input: { command: "git commit -m add" },
          output: "[feat/x abc1234] add\n 1 file changed",
          requestKey: "req-c",
        }),
        toolIndex: 1,
        agentId: null,
      },
    ];

    expect(repositoryActivity("claude", calls, [])).toEqual([
      expect.objectContaining({
        key: "claude:write:toolu_w",
        kind: RepositoryActivityKind.FileWrite,
        paths: ["/r/a.ts"],
        requestKey: "req-w",
        resultState: ToolResultState.Present,
      }),
      expect.objectContaining({
        key: "claude:git:commit:feat/x:toolu_c",
        kind: RepositoryActivityKind.GitWrite,
        gitAction: GitWriteAction.Commit,
        branch: "feat/x",
        filesChanged: 1,
        requestKey: "req-c",
      }),
    ]);
  });

  it("puts a quiet commit with global options on the branch the session checked out", () => {
    const calls = [
      bash(
        0,
        "git checkout -b feat/quiet",
        "Switched to a new branch 'feat/quiet'"
      ),
      bash(1, "git -c user.name=x -C repo commit -q -m wip", ""),
    ];

    expect(repositoryActivity("claude", calls, [])).toEqual([
      expect.objectContaining({
        key: "claude:git:commit:feat/quiet:toolu_1",
        gitAction: GitWriteAction.Commit,
        branch: "feat/quiet",
      }),
    ]);
  });

  it("tracks the branch a show-current reports, and never reads one from a single-line ls", () => {
    const shown = [
      bash(0, "git branch --show-current", "feat/shown\n"),
      bash(1, "git commit -qm wip", ""),
    ];
    const listed = [
      bash(0, "ls", "README.md\n"),
      bash(1, "git commit -qm wip", ""),
    ];

    expect(repositoryActivity("claude", shown, [])).toEqual([
      expect.objectContaining({ branch: "feat/shown" }),
    ]);
    expect(repositoryActivity("claude", listed, [])).toEqual([]);
  });

  it("does not move the tracked branch on a failed checkout", () => {
    const calls = [
      bash(0, "git checkout -b feat/a", "Switched to a new branch 'feat/a'"),
      {
        ...bash(
          1,
          "git checkout -b feat/b",
          "fatal: a branch named 'feat/b' already exists"
        ),
        tu: tool({
          id: "toolu_1",
          input: { command: "git checkout -b feat/b" },
          output: "fatal: a branch named 'feat/b' already exists",
          isError: true,
        }),
      },
      bash(2, "git commit -qm wip", ""),
    ];

    expect(repositoryActivity("claude", calls, [])).toEqual([
      expect.objectContaining({ branch: "feat/a" }),
    ]);
  });

  it("records the pushes and PR creates the caller found, one claim per action and branch", () => {
    const calls = [bash(0, "git push -u origin feat/x && gh pr create", "ok")];

    expect(
      repositoryActivity("claude", calls, [
        { toolIndex: 0, branch: "feat/x", action: GitWriteAction.Push },
        { toolIndex: 0, branch: "feat/x", action: GitWriteAction.Push },
        {
          toolIndex: 0,
          branch: "feat/x",
          action: GitWriteAction.PullRequestCreate,
        },
        { toolIndex: 9, branch: "feat/x", action: GitWriteAction.Push },
      ])
    ).toEqual([
      expect.objectContaining({
        key: "claude:git:push:feat/x:toolu_0",
        gitAction: GitWriteAction.Push,
      }),
      expect.objectContaining({
        key: "claude:git:prCreate:feat/x:toolu_0",
        gitAction: GitWriteAction.PullRequestCreate,
      }),
    ]);
  });
});

function bash(toolIndex: number, command: string, output: string) {
  return {
    tu: tool({ id: `toolu_${toolIndex}`, input: { command }, output }),
    toolIndex,
    agentId: null,
  };
}
