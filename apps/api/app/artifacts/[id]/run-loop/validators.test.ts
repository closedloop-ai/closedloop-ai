import { describe, expect, it } from "vitest";
import { runLoopSchema } from "./validators";

const BASE = { command: "plan" as const };

describe("runLoopSchema — additionalRepos", () => {
  it("rejects additionalRepos with 6 entries (exceeds max of 5)", () => {
    const result = runLoopSchema.safeParse({
      ...BASE,
      additionalRepos: Array.from({ length: 6 }, (_, i) => ({
        fullName: `owner/repo-${i}`,
        branch: "main",
      })),
    });
    expect(result.success).toBe(false);
  });

  it("transforms an empty additionalRepos array to undefined", () => {
    const result = runLoopSchema.safeParse({
      ...BASE,
      additionalRepos: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.additionalRepos).toBeUndefined();
    }
  });
});
