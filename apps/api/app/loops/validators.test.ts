import { describe, expect, it } from "vitest";
import { additionalReposSchema, createLoopValidator } from "./validators";

describe("createLoopValidator additionalRepos", () => {
  it("rejects additionalRepos above max count", () => {
    const result = createLoopValidator.safeParse({
      command: "PLAN",
      additionalRepos: Array.from({ length: 6 }, (_, index) => ({
        fullName: `org/repo-${index}`,
        branch: "main",
      })),
    });

    expect(result.success).toBe(false);
  });

  it("coerces empty additionalRepos to undefined", () => {
    const result = createLoopValidator.safeParse({
      command: "PLAN",
      additionalRepos: [],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.additionalRepos).toBeUndefined();
    }
  });

  it("rejects duplicate fullName values in additionalRepos", () => {
    const result = additionalReposSchema.safeParse([
      { fullName: "org/repo-a", branch: "main" },
      { fullName: "org/repo-b", branch: "main" },
      { fullName: "org/repo-a", branch: "feat" },
    ]);

    expect(result.success).toBe(false);
  });

  it("accepts additionalRepos with distinct fullName values", () => {
    const result = additionalReposSchema.safeParse([
      { fullName: "org/repo-a", branch: "main" },
      { fullName: "org/repo-b", branch: "main" },
      { fullName: "org/repo-c", branch: "main" },
    ]);

    expect(result.success).toBe(true);
  });

  it("reports error path and message for duplicate fullName", () => {
    const result = additionalReposSchema.safeParse([
      { fullName: "org/repo-a", branch: "main" },
      { fullName: "org/repo-a", branch: "feat" },
    ]);

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue.path).toEqual([1, "fullName"]);
      expect(issue.message).toBe('Duplicate repository: "org/repo-a"');
    }
  });
});
