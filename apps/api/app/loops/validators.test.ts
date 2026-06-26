import { HarnessType } from "@repo/api/src/types/compute-target";
import { describe, expect, it } from "vitest";
import { additionalReposSchema, createLoopValidator } from "./validators";

describe("createLoopValidator additionalRepos", () => {
  it("accepts a known harness selection", () => {
    const result = createLoopValidator.safeParse({
      command: "PLAN",
      harness: HarnessType.Codex,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.harness).toBe(HarnessType.Codex);
    }
  });

  it("rejects an unknown harness selection", () => {
    const result = createLoopValidator.safeParse({
      command: "PLAN",
      harness: "future-harness",
    });

    expect(result.success).toBe(false);
  });

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

  it("accepts additionalRepos with distinct fullName values", () => {
    const result = additionalReposSchema.safeParse([
      { fullName: "org/repo-a", branch: "main" },
      { fullName: "org/repo-b", branch: "main" },
      { fullName: "org/repo-c", branch: "main" },
    ]);

    expect(result.success).toBe(true);
  });
});
