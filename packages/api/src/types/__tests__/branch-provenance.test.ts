import { describe, expect, it } from "vitest";
import { BranchProvenance, classifyBranchProvenance } from "../branch";

describe("classifyBranchProvenance (FEA-3285)", () => {
  it("classifies agent-worktree branches", () => {
    expect(classifyBranchProvenance("worktree-agent-a4385f34a4a3aa7b6")).toBe(
      BranchProvenance.Agent
    );
    expect(classifyBranchProvenance("WORKTREE-AGENT-DEADBEEF")).toBe(
      BranchProvenance.Agent
    );
    expect(
      classifyBranchProvenance("feature/.claude/worktrees/agent-x/fix")
    ).toBe(BranchProvenance.Agent);
  });

  it("classifies bot branches", () => {
    expect(classifyBranchProvenance("dependabot/npm_and_yarn/vite-8")).toBe(
      BranchProvenance.Bot
    );
    expect(classifyBranchProvenance("renovate/react-19.x")).toBe(
      BranchProvenance.Bot
    );
    expect(classifyBranchProvenance("Dependabot/GitHub_Actions/checkout")).toBe(
      BranchProvenance.Bot
    );
  });

  it("treats real human branches as human — including ones that merely contain 'agent'", () => {
    expect(classifyBranchProvenance("main")).toBe(BranchProvenance.Human);
    expect(classifyBranchProvenance("mikeangstadt/fea-3285")).toBe(
      BranchProvenance.Human
    );
    // The word "agent" appears but not as the dedicated worktree prefix — human.
    expect(classifyBranchProvenance("feat/FEA-3537-agent-pipeline-graph")).toBe(
      BranchProvenance.Human
    );
    expect(
      classifyBranchProvenance("fix/agent-coaching-claude-spawn-timeout")
    ).toBe(BranchProvenance.Human);
    // "dependabot" as a mid-name substring (not the `dependabot/` prefix) is human.
    expect(classifyBranchProvenance("chore/upgrade-dependabot-config")).toBe(
      BranchProvenance.Human
    );
  });

  it("treats null / empty names as human (pre-capture rows)", () => {
    expect(classifyBranchProvenance(null)).toBe(BranchProvenance.Human);
    expect(classifyBranchProvenance(undefined)).toBe(BranchProvenance.Human);
    expect(classifyBranchProvenance("")).toBe(BranchProvenance.Human);
  });
});
