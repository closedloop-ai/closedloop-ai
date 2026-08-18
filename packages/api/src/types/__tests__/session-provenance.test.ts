import { describe, expect, it } from "vitest";
import { BranchProvenance, classifySessionProvenance } from "../branch";

describe("classifySessionProvenance (FEA-3575)", () => {
  it("classifies CI-harness sessions as bot regardless of branch", () => {
    expect(
      classifySessionProvenance({
        harness: "ci",
        branchName: "mikeangstadt/fea-3575",
        worktreePath: null,
      })
    ).toBe(BranchProvenance.Bot);
    // Case/whitespace-insensitive harness match.
    expect(classifySessionProvenance({ harness: " CI " })).toBe(
      BranchProvenance.Bot
    );
  });

  it("classifies bot-branch sessions as bot", () => {
    expect(
      classifySessionProvenance({
        branchName: "dependabot/npm_and_yarn/vite-8",
      })
    ).toBe(BranchProvenance.Bot);
    expect(
      classifySessionProvenance({ branchName: "renovate/react-19.x" })
    ).toBe(BranchProvenance.Bot);
  });

  it("classifies agent-worktree branch names as agent", () => {
    expect(
      classifySessionProvenance({
        branchName: "worktree-agent-a4385f34a4a3aa7b6",
      })
    ).toBe(BranchProvenance.Agent);
  });

  it("classifies `.claude/worktrees/*` working paths as agent when the branch is unrevealing", () => {
    expect(
      classifySessionProvenance({
        branchName: null,
        worktreePath: "/Users/x/repo/.claude/worktrees/agent-abc",
        harness: "claude",
      })
    ).toBe(BranchProvenance.Agent);
  });

  it("keeps bot precedence over an agent worktree path", () => {
    // A CI run inside a worktree path is still a bot (automation wins).
    expect(
      classifySessionProvenance({
        harness: "ci",
        worktreePath: "/repo/.claude/worktrees/agent-x",
      })
    ).toBe(BranchProvenance.Bot);
    // A bot-named branch beats an agent worktree path.
    expect(
      classifySessionProvenance({
        branchName: "dependabot/npm/foo",
        worktreePath: "/repo/.claude/worktrees/agent-x",
      })
    ).toBe(BranchProvenance.Bot);
  });

  it("treats real human sessions as human", () => {
    expect(
      classifySessionProvenance({
        branchName: "mikeangstadt/fea-3575",
        worktreePath: "/Users/x/repo",
        harness: "claude",
      })
    ).toBe(BranchProvenance.Human);
  });

  it("treats empty / missing signals as human (pre-capture rows)", () => {
    expect(classifySessionProvenance({})).toBe(BranchProvenance.Human);
    expect(
      classifySessionProvenance({
        branchName: null,
        worktreePath: null,
        harness: null,
      })
    ).toBe(BranchProvenance.Human);
  });
});
