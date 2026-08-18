import { describe, expect, it } from "vitest";
import {
  LOC_SOURCE_BRANCH_FALLBACK,
  LOC_SOURCE_GIT,
  type SessionLocEntry,
  sumSessionLocDedupedByBranch,
} from "./session-loc.js";

const REPO = "closedloop-ai/symphony-alpha";

function fallback(loc: number, branch: string): SessionLocEntry {
  return {
    loc,
    locSource: LOC_SOURCE_BRANCH_FALLBACK,
    repositoryFullName: REPO,
    branch,
  };
}

function committed(loc: number, branch = "feat/x"): SessionLocEntry {
  return {
    loc,
    locSource: LOC_SOURCE_GIT,
    repositoryFullName: REPO,
    branch,
  };
}

describe("sumSessionLocDedupedByBranch", () => {
  it("(a) N fallback sessions on ONE branch → branch total counted ONCE", () => {
    // 3 authoring sessions each carry the branch's 500-line total.
    const entries = [
      fallback(500, "feat/shared"),
      fallback(500, "feat/shared"),
      fallback(500, "feat/shared"),
    ];
    // Deduped: 500 (once), NOT 1500.
    expect(sumSessionLocDedupedByBranch(entries)).toBe(500);
  });

  it("(b) authored-commit (git) LOC sums per-session, unchanged", () => {
    const entries = [committed(100), committed(250), committed(30)];
    expect(sumSessionLocDedupedByBranch(entries)).toBe(380);
  });

  it("(c) single fallback session on a branch is unchanged", () => {
    expect(sumSessionLocDedupedByBranch([fallback(420, "feat/solo")])).toBe(
      420
    );
  });

  it("(d) mixed: some commit-enriched, some fallback → correct total", () => {
    const entries = [
      // Fallback branch A shared by 2 sessions → 800 once.
      fallback(800, "feat/a"),
      fallback(800, "feat/a"),
      // Fallback branch B shared by 3 sessions → 200 once.
      fallback(200, "feat/b"),
      fallback(200, "feat/b"),
      fallback(200, "feat/b"),
      // Commit-sourced sessions → sum per-session.
      committed(150),
      committed(50),
    ];
    // 800 + 200 + 150 + 50 = 1200.
    expect(sumSessionLocDedupedByBranch(entries)).toBe(1200);
  });

  it("dedups fallback per DISTINCT branch (two branches each count once)", () => {
    const entries = [
      fallback(300, "feat/a"),
      fallback(300, "feat/a"),
      fallback(700, "feat/b"),
    ];
    expect(sumSessionLocDedupedByBranch(entries)).toBe(1000);
  });

  it("keeps the MAX when a shared branch's fallback total grew between syncs", () => {
    const entries = [fallback(500, "feat/grow"), fallback(650, "feat/grow")];
    // Most complete observation of the one branch, never 1150, never 500.
    expect(sumSessionLocDedupedByBranch(entries)).toBe(650);
  });

  it("scopes the dedup by repository (same branch name, different repos)", () => {
    const entries: SessionLocEntry[] = [
      {
        loc: 400,
        locSource: LOC_SOURCE_BRANCH_FALLBACK,
        repositoryFullName: "org/one",
        branch: "main",
      },
      {
        loc: 400,
        locSource: LOC_SOURCE_BRANCH_FALLBACK,
        repositoryFullName: "org/two",
        branch: "main",
      },
    ];
    // Different repos ⇒ different branches ⇒ both count.
    expect(sumSessionLocDedupedByBranch(entries)).toBe(800);
  });

  it("does NOT collapse fallback rows that cannot be branch-keyed (no over-drop)", () => {
    const entries: SessionLocEntry[] = [
      { loc: 100, locSource: LOC_SOURCE_BRANCH_FALLBACK, branch: null },
      {
        loc: 100,
        locSource: LOC_SOURCE_BRANCH_FALLBACK,
        repositoryFullName: REPO,
        branch: null,
      },
    ];
    // Unkeyable fallbacks sum per-session (over-count at worst, never drop).
    expect(sumSessionLocDedupedByBranch(entries)).toBe(200);
  });

  it("does not dedup a git row and a fallback row that share a branch", () => {
    // A commit-sourced session and a fallback session on the same branch: the
    // authored-commit LOC is genuinely distinct work and must still sum.
    const entries = [
      committed(120, "feat/shared"),
      fallback(500, "feat/shared"),
    ];
    expect(sumSessionLocDedupedByBranch(entries)).toBe(620);
  });

  it("ignores zero / negative / non-finite loc", () => {
    const entries: SessionLocEntry[] = [
      fallback(0, "feat/z"),
      committed(-5),
      { loc: Number.NaN, locSource: LOC_SOURCE_GIT },
      committed(10),
    ];
    expect(sumSessionLocDedupedByBranch(entries)).toBe(10);
  });

  it("empty input → 0", () => {
    expect(sumSessionLocDedupedByBranch([])).toBe(0);
  });
});
