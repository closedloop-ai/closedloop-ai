/**
 * FEA-3425: the desktop-wide policy for resolving the session-only cloud REST
 * credential. Session-only main-process HTTP lanes that read/write cloud data
 * on behalf of the signed-in user (components, trace comments, parent-session
 * sync) resolve here so the rule cannot drift per lane:
 *
 * 1. The first-party Desktop session token (a thrown token read counts as "no
 *    session" — surfaced via `onAccessTokenError`, never thrown).
 * 2. No session → `null`; the caller decides how loudly to fail.
 *
 * Session-only since PLN-1437 Phase 4a: the static `sk_live_*` key fallback was
 * removed once session coverage cleared the D7 no-strand gate. (The
 * agent-session sync and transcript clients resolve the same session-only
 * credential inline because they need caller-specific error classification.
 * Invocation and routine sync have their own explicit API-key fallback windows.)
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
