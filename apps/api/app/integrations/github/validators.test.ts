import { describe, expect, it } from "vitest";
import { claimGitHubInstallationValidator } from "./validators";

describe("claimGitHubInstallationValidator", () => {
  it("accepts an installationId", () => {
    const result = claimGitHubInstallationValidator.safeParse({
      installationId: "12345",
    });
    expect(result.success).toBe(true);
  });

  it("strips a stale deploy's OAuth code instead of rejecting it", () => {
    // Cross-repo/deploy skew: an older apps/app callback still POSTs `code`.
    const result = claimGitHubInstallationValidator.safeParse({
      code: "abc123",
      installationId: "12345",
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ installationId: "12345" });
  });

  it("rejects a missing installationId", () => {
    const result = claimGitHubInstallationValidator.safeParse({
      code: "abc123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty installationId", () => {
    const result = claimGitHubInstallationValidator.safeParse({
      installationId: "",
    });
    expect(result.success).toBe(false);
  });
});
