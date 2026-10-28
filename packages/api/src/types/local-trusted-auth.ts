/**
 * The bearer the browser sends while the `AUTH_MODE=local_trusted` synthetic
 * session is active.
 *
 * Inert but non-empty: `local_trusted` has no Clerk token, and a null one makes
 * the shared API client wait through the real-Clerk hydration retry. The api
 * behind that mode authenticates every request as the synthetic session
 * regardless of what the header carries, so the value is a marker, never a
 * credential.
 *
 * It lives HERE, and not beside the synthetic identity in
 * `packages/auth/auth-mode.ts`, because it is the one part of that identity
 * which crosses a process boundary. Three places hand back the same string:
 * `apps/app`'s client adapter, the ISS-10335 Clerk-free e2e lane's
 * `getClerkBearerToken`, and — since the SSR reads that took a null as a 404 —
 * the synthetic session's own `getToken` in
 * `packages/auth/local-trusted-session.ts`. `packages/auth` is CommonJS, so the
 * Playwright tree cannot import a named export from it at runtime, and a second
 * literal in `e2e/` is exactly the SSOT drift this constant exists to prevent.
 */
export const LOCAL_TRUSTED_CLIENT_TOKEN = "local-trusted-client-token";

/**
 * The user and org the synthetic session reports when the `E2E_LOCAL_TRUSTED_*`
 * overrides are unset — here for the same reason the token above is, and with
 * the same constraint: the suite has to name the ids it keys a saved view by
 * (`resolveViewScopeIdentity`), and cannot reach `packages/auth` to do it.
 *
 * `packages/auth/auth-mode.ts` is the PRODUCER — it is what the running app
 * actually resolves. These are the readable copy, and
 * `packages/auth/__tests__/auth-mode.test.ts` fails if the two ever disagree.
 * Importing the producer instead is not available in either direction: this
 * package cannot reach `@repo/auth` without a cycle (ISS-10335 made `@repo/auth`
 * depend on this one for the token above), and the Playwright tree cannot import
 * a CommonJS named export at runtime.
 */
export const LOCAL_TRUSTED_DEFAULT_USER_ID = "user_e2e_local_trusted";
export const LOCAL_TRUSTED_DEFAULT_ORG_ID = "org_e2e_local_trusted";
