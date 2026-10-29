import { describe, expect, it } from "vitest";
import { getWorktreePath } from "../worktree";

describe("getWorktreePath", () => {
  it("resolves under the configured worktree parent directory", () => {
    expect(
      getWorktreePath("/home/dev/repo", "ISS-123", "/home/dev/worktrees")
    ).toBe("/home/dev/worktrees/repo-ISS-123");
  });

  it("strips a trailing slash from the worktree parent directory before joining", () => {
    expect(
      getWorktreePath("/home/dev/repo", "ISS-123", "/home/dev/worktrees/")
    ).toBe("/home/dev/worktrees/repo-ISS-123");
  });

  it("falls back to a sibling of the repo when no parent directory is configured", () => {
    expect(getWorktreePath("/home/dev/repo", "ISS-123")).toBe(
      "/home/dev/repo-ISS-123"
    );
  });

  // Pins current behavior, and it looks wrong: a trailing slash is a valid
  // spelling of the same repo root, but `split("/").pop() || ""` reads the empty
  // final segment, so the caller gets `.../-ISS-123` instead of
  // `.../repo-ISS-123`. ISS-9169 forbids a coverage PR from changing behavior in
  // either direction, so this asserts what main does today and arms the tripwire
  // for whoever normalizes `baseRepoPath`.
  it("produces an empty repo-name segment when baseRepoPath ends with a trailing slash", () => {
    expect(
      getWorktreePath("/home/dev/repo/", "ISS-123", "/home/dev/worktrees")
    ).toBe("/home/dev/worktrees/-ISS-123");
  });
});
