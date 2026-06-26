import { FileChangeStatus } from "@repo/api/src/types/branch-view";
import { describe, expect, test } from "vitest";
import { resolveCommittedCommentFileTarget } from "./file-targets";
import type { BranchViewFile } from "./types";

const LOCAL_FILE_ID_PATTERN = /^local:/;

function file(
  path: string,
  previousPath: string | null = null
): BranchViewFile {
  return {
    additions: 1,
    deletions: 0,
    patch: null,
    path,
    previousPath,
    status: FileChangeStatus.Modified,
  };
}

describe("resolveCommittedCommentFileTarget", () => {
  test("returns a committed file id for direct path matches", () => {
    expect(
      resolveCommittedCommentFileTarget([file("src/app.tsx")], "src/app.tsx")
    ).toEqual({ fileId: "committed:src/app.tsx" });
  });

  test("returns the current committed file id for previousPath matches", () => {
    expect(
      resolveCommittedCommentFileTarget(
        [file("src/new.ts", "src/old.ts")],
        "src/old.ts"
      )
    ).toEqual({ fileId: "committed:src/new.ts" });
  });

  test("returns null for unknown paths", () => {
    expect(
      resolveCommittedCommentFileTarget([file("src/app.tsx")], "src/missing.ts")
    ).toBeNull();
  });

  test("never produces a local file id", () => {
    const target = resolveCommittedCommentFileTarget(
      [file("src/app.tsx")],
      "src/app.tsx"
    );
    expect(target?.fileId).toBe("committed:src/app.tsx");
    expect(target?.fileId).not.toMatch(LOCAL_FILE_ID_PATTERN);
  });
});
