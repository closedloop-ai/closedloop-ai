import { DESKTOP_AUTHORIZE_RUN_COOKIE } from "@repo/api/src/types/desktop-authorize-url";
import type { DesktopBootstrapMintRequest } from "@repo/api/src/types/desktop-bootstrap";
import { parseDesktopAuthorizeParams } from "@repo/app/onboarding/lib/desktop-authorize-params";
import { cookies } from "next/headers";
import { parseDesktopAuthorizeRunCookie } from "./desktop-authorize-run";

export type DesktopBootstrapBrowserRun = Omit<
  DesktopBootstrapMintRequest,
  "webAppOrigin"
> & {
  bootstrapSupported: boolean;
  state: string;
};

/**
 * The valid Desktop run waiting behind the sign-up page, narrowed to the
 * device-binding fields the bootstrap mint accepts.
 *
 * The run remains in its HttpOnly cookie. The client receives no account or
 * authorization fact, only the public device key, PKCE challenge, loopback
 * return and opaque state that Desktop put in the browser URL to begin with.
 * The API still validates every field and resolves the pending Clerk principal.
 */
export async function resolveDesktopBootstrapBrowserRun(): Promise<DesktopBootstrapBrowserRun | null> {
  const cookieStore = await cookies();
  return desktopBootstrapBrowserRunFromCookie(
    cookieStore.get(DESKTOP_AUTHORIZE_RUN_COOKIE)?.value,
    Date.now()
  );
}

/** Pure boundary for the server resolver, kept separate so malformed cookies
 * and authorize queries are covered without mocking Next request storage. */
export function desktopBootstrapBrowserRunFromCookie(
  cookieValue: string | undefined,
  now: number
): DesktopBootstrapBrowserRun | null {
  const run = parseDesktopAuthorizeRunCookie(cookieValue, now);
  if (run === null || run.consumed === true) {
    return null;
  }
  const parsed = parseDesktopAuthorizeParams(
    searchParamsToRecord(new URLSearchParams(run.query))
  );
  if (!parsed.ok) {
    return null;
  }
  const { params } = parsed;
  return {
    bootstrapSupported: params.bootstrapSupported,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    gatewayId: params.gatewayId,
    gatewayPublicKeyPem: params.gatewayPublicKeyPem,
    redirectUri: params.redirectUri,
    state: params.state,
  };
}

function searchParamsToRecord(
  searchParams: URLSearchParams
): Record<string, string | string[] | undefined> {
  const record: Record<string, string | string[] | undefined> =
    Object.create(null);
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    record[key] = values.length === 1 ? values[0] : values;
  }
  return record;
}
