import { describe, expect, it } from "vitest";
import { runLoopSchema } from "./validators";

// A valid base payload — only `command` is required.
const BASE = { command: "plan" as const };

// A valid repo entry satisfying repoSchema.
const VALID_REPO = { fullName: "owner/repo", branch: "main" };

// ---------------------------------------------------------------------------
// runLoopSchema — additionalRepos field
// ---------------------------------------------------------------------------

describe("runLoopSchema — additionalRepos", () => {
  it("accepts a valid additionalRepos array with 1 entry", () => {
    const result = runLoopSchema.safeParse({
      ...BASE,
      additionalRepos: [VALID_REPO],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid additionalRepos array with 5 entries (max allowed)", () => {
    const result = runLoopSchema.safeParse({
      ...BASE,
      additionalRepos: Array.from({ length: 5 }, (_, i) => ({
        fullName: `owner/repo-${i}`,
        branch: "main",
      })),
    });
    expect(result.success).toBe(true);
  });

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

  it("rejects an additionalRepos entry missing the branch field", () => {
    const result = runLoopSchema.safeParse({
      ...BASE,
      additionalRepos: [{ fullName: "owner/repo" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an additionalRepos entry with an invalid fullName (no slash)", () => {
    const result = runLoopSchema.safeParse({
      ...BASE,
      additionalRepos: [{ fullName: "just-a-name", branch: "main" }],
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

  it("accepts undefined additionalRepos", () => {
    const result = runLoopSchema.safeParse(BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.additionalRepos).toBeUndefined();
    }
  });

  it("accepts an entry with a valid fullName 'owner/repo' and branch 'main'", () => {
    const result = runLoopSchema.safeParse({
      ...BASE,
      additionalRepos: [{ fullName: "owner/repo", branch: "main" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.additionalRepos).toEqual([
        { fullName: "owner/repo", branch: "main" },
      ]);
    }
  });
});
