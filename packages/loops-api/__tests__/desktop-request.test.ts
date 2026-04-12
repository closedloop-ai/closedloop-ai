import { describe, expect, it } from "vitest";

import { LoopRequestBodySchema } from "../src/desktop-request";

const base = {
  loopId: "loop-1",
  command: "EXECUTE",
  closedLoopAuthToken: "tok",
  artifacts: [],
};

describe("LoopRequestBodySchema — additionalRepos", () => {
  it("omitted — must pass", () => {
    const result = LoopRequestBodySchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it("empty array — must pass", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      additionalRepos: [],
    });
    expect(result.success).toBe(true);
  });

  it("entry with both localRepoPath and fullName set — must pass", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      additionalRepos: [
        { localRepoPath: "/repo", fullName: "org/repo", branch: "main" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("entry with only localRepoPath set — must pass", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      additionalRepos: [{ localRepoPath: "/repo", branch: "main" }],
    });
    expect(result.success).toBe(true);
  });

  it("entry with only fullName set — must pass", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      additionalRepos: [{ fullName: "org/repo", branch: "main" }],
    });
    expect(result.success).toBe(true);
  });

  it("localRepoPath as empty string (not undefined) — must pass", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      additionalRepos: [{ localRepoPath: "", branch: "main" }],
    });
    expect(result.success).toBe(true);
  });

  it("both fields as empty strings — must pass", () => {
    const result = LoopRequestBodySchema.safeParse({
      ...base,
      additionalRepos: [{ localRepoPath: "", fullName: "", branch: "main" }],
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
