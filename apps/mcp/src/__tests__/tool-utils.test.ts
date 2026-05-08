import { describe, expect, it } from "vitest";
import { McpApiError } from "../api-error.js";
import { withErrorHandling } from "../tools/tool-utils.js";

describe("withErrorHandling", () => {
  it("returns friendly text for structured API errors", async () => {
    const result = await withErrorHandling(() =>
      Promise.reject(
        new McpApiError("Pre-commit hook failed", {
          code: "PROCESS_FAILED",
          details: {
            action: "commit",
            category: "pre_commit_hook",
            hookType: "lint",
            stderrExcerpt: "eslint failed",
          },
        })
      )
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Pre-commit hook failed");
    expect(result.content[0]?.text).toContain("Remediation:");
    expect(result.content[0]?.text).toContain("Fix the lint errors");
    expect(result.content[0]?.text).toContain("Technical details:");
  });

  it("maps legacy thrown Error values to fallback friendly output", async () => {
    const result = await withErrorHandling(() =>
      Promise.reject(new Error("legacy raw failure"))
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Operation failed");
    expect(result.content[0]?.text).toContain("legacy raw failure");
  });
});
