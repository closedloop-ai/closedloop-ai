import type { NextRequest } from "next/server";
import type { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import type { AuthenticatedHandler, RouteContext } from "@/lib/auth/with-auth";

export type SessionMeshAuthTestMocks = {
  authOptions: unknown[];
  userId: string;
  organizationId: string;
};

/**
 * Builds a `withSessionMeshAuth` mock replacement: injects a test auth
 * context carrying the mock's user/org ids, and records each call's
 * `options` for the "session mesh auth wiring" scope-assertion tests.
 * Callers pass `createTestAuthContext` in (rather than this module importing
 * it statically) because each route test's `vi.mock("../auth", ...)` factory
 * loads it via a dynamic `import()` to satisfy Vitest's mock-hoisting order.
 */
export function buildSessionMeshAuthMock(
  mocks: SessionMeshAuthTestMocks,
  makeAuthContext: typeof createTestAuthContext
) {
  return (
    handler: AuthenticatedHandler<unknown>,
    options?: { requiredScopes?: string[] }
  ) => {
    mocks.authOptions.push(options);
    return (request: NextRequest, context: RouteContext) => {
      const auth = makeAuthContext();
      return handler(
        {
          ...auth,
          user: {
            ...auth.user,
            id: mocks.userId,
            organizationId: mocks.organizationId,
          },
        },
        request,
        context.params
      );
    };
  };
}
