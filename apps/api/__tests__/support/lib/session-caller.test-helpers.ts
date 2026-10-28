import { receiptRouteState } from "@/__tests__/support/lib/operation-receipt-route.test-mocks";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

/**
 * ISS-12552 flag-off parity: turn the harness's API-key caller into a
 * browser session caller for the same user. A session request never gets a
 * receipt, so its writes must run exactly as they did on main. Call after
 * `createReceiptRouteHarness().seedWorld()`; cleanup clears the context.
 */
export function useSessionCaller(): void {
  const apiKeyContext = receiptRouteState.context as AuthContext;
  receiptRouteState.context = createTestAuthContext({
    user: apiKeyContext.user,
    authMethod: "session",
  });
}
