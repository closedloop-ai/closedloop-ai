import type { User } from "@repo/api/src/types/user";
import { NextRequest } from "next/server";
import type { AuthContext } from "@/lib/auth/with-auth";

/**
 * Create a test AuthContext with default or overridden values.
 */
export function createTestAuthContext(
  overrides?: Partial<AuthContext>
): AuthContext {
  const defaultUser: User = {
    id: "test-user-id",
    organizationId: "test-org-id",
    clerkId: "clerk_test_user",
    email: "test@example.com",
    firstName: "Test",
    lastName: "User",
    role: "ENGINEER",
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    avatarUrl: null,
    phoneNumber: null,
    linearId: null,
    slackId: null,
    githubUsername: null,
  };

  return {
    user: overrides?.user ?? defaultUser,
    clerkUserId: overrides?.clerkUserId ?? "clerk_test_user",
    clerkOrgId: overrides?.clerkOrgId ?? "org_test",
    authMethod: overrides?.authMethod ?? "session",
    apiKeyScopes: overrides?.apiKeyScopes,
    orgRole: overrides?.orgRole,
    ...(overrides?.apiKeyId ? { apiKeyId: overrides.apiKeyId } : {}),
  };
}

/**
 * Create a mock NextRequest for testing.
 */
export function createMockRequest(options?: {
  url?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): NextRequest {
  const url = options?.url ?? "http://localhost:3002/api/test";
  const method = options?.method ?? "GET";
  const headers = new Headers(options?.headers ?? {});

  if (options?.body) {
    headers.set("Content-Type", "application/json");
  }

  return new NextRequest(url, {
    method,
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
}

/**
 * Create mock route context with type-safe params.
 * CRITICAL: Returns Promise<T> for params to match Next.js App Router.
 */
export function createMockRouteContext<T extends Record<string, string>>(
  params: T
): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

/**
 * Create AuthContext for user in different organization.
 * Use for testing cross-org authorization failures.
 */
export function createCrossOrgAuthContext(
  userOrgId: string,
  targetOrgId: string
): AuthContext {
  return createTestAuthContext({
    user: {
      ...createTestAuthContext().user,
      organizationId: userOrgId,
    },
    clerkOrgId: targetOrgId,
  });
}

/**
 * Create AuthContext with specific user role.
 * Use for testing role-based authorization.
 */
export function createAuthContextWithRole(
  role: "ENGINEER" | "PM" | "DESIGNER" | "TECH_LEAD" | "STAKEHOLDER"
): AuthContext {
  return createTestAuthContext({
    user: {
      ...createTestAuthContext().user,
      role,
    },
  });
}

/**
 * Clerk organization role slugs, hand-written here as the suites' oracle for
 * Clerk's external wire values.
 *
 * Deliberately independent of `ADMIN_ROLES` (`lib/auth/org-admin.ts`), which is
 * the set under test: deriving these from it would make every admin-gate suite
 * unfalsifiable, because removing a role would silently remove its case instead
 * of failing one, and a mis-spelled slug would change expectation and policy
 * together. Independent means test-side — do not make production import this.
 */
export const ClerkOrgRoleFixture = {
  Admin: "org:admin",
  Owner: "org:owner",
  Member: "org:member",
} as const;

export type ClerkOrgRoleFixture =
  (typeof ClerkOrgRoleFixture)[keyof typeof ClerkOrgRoleFixture];

/** The roles `ADMIN_ROLES` must admit, as separate cases. */
export const PRIVILEGED_CLERK_ORG_ROLES = [
  ClerkOrgRoleFixture.Admin,
  ClerkOrgRoleFixture.Owner,
] as const;
