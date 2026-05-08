import { describe, expect, it } from "vitest";
import { hasApiKeyScopes } from "@/lib/auth/api-key-scopes";
import type { AuthContext } from "@/lib/auth/with-auth";

function makeContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    user: {
      id: "user-1",
      organizationId: "org-1",
      clerkId: "clerk-1",
      email: "u@example.com",
      firstName: "U",
      lastName: "Test",
      role: "ENGINEER",
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      avatarUrl: null,
      phoneNumber: null,
      linearId: null,
      slackId: null,
      githubUsername: null,
    },
    clerkUserId: "clerk-1",
    clerkOrgId: "org-1",
    authMethod: "session",
    apiKeyScopes: undefined,
    ...overrides,
  };
}

describe("hasApiKeyScopes", () => {
  it("allows all scopes for session auth", () => {
    const allowed = hasApiKeyScopes(makeContext(), ["admin"]);
    expect(allowed).toBe(true);
  });

  it("allows required scopes for api key when present", () => {
    const allowed = hasApiKeyScopes(
      makeContext({ authMethod: "api_key", apiKeyScopes: ["read", "write"] }),
      ["write"]
    );
    expect(allowed).toBe(true);
  });

  it("denies required scopes for api key when missing", () => {
    const allowed = hasApiKeyScopes(
      makeContext({ authMethod: "api_key", apiKeyScopes: ["read"] }),
      ["write"]
    );
    expect(allowed).toBe(false);
  });

  it("denies access when api key scopes are empty", () => {
    const allowed = hasApiKeyScopes(
      makeContext({ authMethod: "api_key", apiKeyScopes: [] }),
      ["delete", "admin"]
    );
    expect(allowed).toBe(false);
  });

  it("uses full-access fallback only when scopes are undefined", () => {
    const allowed = hasApiKeyScopes(
      makeContext({ authMethod: "api_key", apiKeyScopes: undefined }),
      ["delete", "admin"]
    );
    expect(allowed).toBe(true);
  });
});
