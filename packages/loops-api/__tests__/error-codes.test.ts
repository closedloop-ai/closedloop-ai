import { describe, expect, it } from "vitest";
import {
  RunnerErrorSubcode,
  RunnerErrorSubcodeSchema,
} from "../src/error-codes";

describe("RunnerErrorSubcodeSchema", () => {
  it("accepts CLAUDE_UNKNOWN_SKILL", () => {
    expect(
      RunnerErrorSubcodeSchema.parse(RunnerErrorSubcode.ClaudeUnknownSkill)
    ).toBe("CLAUDE_UNKNOWN_SKILL");
  });

  it("rejects arbitrary unknown runner subcodes", () => {
    expect(RunnerErrorSubcodeSchema.safeParse("SOME_NEW_FAILURE").success).toBe(
      false
    );
  });
});
