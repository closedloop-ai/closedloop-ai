/**
 * FEA-3425: the single desktop-wide policy for resolving a cloud REST
 * credential. Every main-process HTTP lane that reads/writes cloud data on
 * behalf of the signed-in user (components, trace comments, parent-session
 * sync, branch cloud hydration) resolves its credential here so the rule
 * cannot drift per lane:
 *
 * 1. The first-party Desktop session token (a thrown token read counts as "no
 *    session" — surfaced via `onAccessTokenError`, never thrown).
 * 2. No session → `null`; the caller decides how loudly to fail.
 *
 * Session-only since PLN-1437 Phase 4a: the static `sk_live_*` key fallback was
 * removed once session coverage cleared the D7 no-strand gate. (The agent-session
 * sync HTTP client has always been session-only by decision — auth follows
 * transport, so key-auth traffic rides the relay socket, not a REST fallback.
 * Branch cloud hydration is the one lane that still layers its own legacy
 * `sk_live_*` fallback AROUND this resolver — a PLN-1535 M3 migration-window
 * shim for compute-target setups, owned by that lane, not reintroduced here.)
 */

export type DesktopCloudCredential = {
  token: string;
};

export type DesktopCloudCredentialSources = {
  getAccessToken?: () => Promise<string | null>;
};

export async function resolveDesktopCloudCredential(
  sources: DesktopCloudCredentialSources,
  onAccessTokenError?: (error: unknown) => void
): Promise<DesktopCloudCredential | null> {
  if (!sources.getAccessToken) {
    return null;
  }
  let sessionToken: string | null = null;
  try {
    sessionToken = await sources.getAccessToken();
  } catch (error) {
    onAccessTokenError?.(error);
    sessionToken = null;
  }
  return sessionToken ? { token: sessionToken } : null;
}
