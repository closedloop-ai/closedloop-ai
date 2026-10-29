import { describe, expect, it } from "vitest";
import {
  githubShadowClerkId,
  isGitHubShadowClerkId,
} from "./github-shadow-identity";

describe("GitHub shadow identity", () => {
  it("recognizes only the shared shadow namespace", () => {
    const clerkId = githubShadowClerkId("org-1", "123");

    expect(clerkId).toBe("github-shadow:org-1:123");
    expect(isGitHubShadowClerkId(clerkId)).toBe(true);
    expect(isGitHubShadowClerkId("user_real_123")).toBe(false);
  });
});
