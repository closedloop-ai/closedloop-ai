import { describe, expect, it } from "vitest";
import { createLoopValidator } from "./validators";

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
});
