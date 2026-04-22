import { describe, expect, it } from "vitest";

import { LoopRequestBodySchema } from "../src/desktop-request";

const base = {
  loopId: "loop-1",
  command: "EXECUTE",
  closedLoopAuthToken: "tok",
  artifacts: [],
};

describe("LoopRequestBodySchema — additionalRepos", () => {
  it("valid entry with both localRepoPath and fullName — must pass", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      additionalRepos: [
        { localRepoPath: "/repo", fullName: "org/repo", branch: "main" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("entry with neither localRepoPath nor fullName — must fail with localRepoPath error path", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      additionalRepos: [{ branch: "main" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const path = result.error.issues[0].path;
      expect(path.at(-2)).toBe(0);
      expect(path.at(-1)).toBe("localRepoPath");
    }
  });

  it("entry missing branch — must fail", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      additionalRepos: [{ localRepoPath: "/repo" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("LoopRequestBodySchema — implementation plan raw state", () => {
  it("accepts implementation plan artifacts with raw plan state", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      artifacts: [
        {
          id: "plan-1",
          type: "IMPLEMENTATION_PLAN",
          title: "Plan",
          content: "Latest markdown",
          raw: {
            content: "Previous markdown",
            pendingTasks: ["task-1"],
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("keeps raw plan state optional for older content-only payloads", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      artifacts: [
        {
          id: "plan-1",
          type: "IMPLEMENTATION_PLAN",
          title: "Plan",
          content: "Latest markdown",
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
