import { describe, expect, it } from "vitest";
import { connectGitHubValidator } from "./validators";

describe("connectGitHubValidator", () => {
  it("accepts code with installationId", () => {
    const result = connectGitHubValidator.safeParse({
      code: "abc123",
      installationId: "12345",
    });
    expect(result.success).toBe(true);
  });

  it("accepts code without installationId (standard OAuth flow)", () => {
    const result = connectGitHubValidator.safeParse({
      code: "abc123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty code", () => {
    const result = connectGitHubValidator.safeParse({
      code: "",
      installationId: "12345",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing code", () => {
    const result = connectGitHubValidator.safeParse({
      installationId: "12345",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty installationId when provided", () => {
    const result = connectGitHubValidator.safeParse({
      code: "abc123",
      installationId: "",
    });
    expect(result.success).toBe(false);
  });
});
