import { createMetadata } from "@repo/seo/metadata";
import { env } from "@/env";
import {
  buildSignInFallbackHref,
  GITHUB_CONNECT_REDIRECT_PARAM,
  resolveDesktopSignInProviderFromSearchParams,
  resolveGitHubConnectRedirectFromSearchParams,
  resolveGitHubConnectRedirectTarget,
} from "@/lib/github-connect-redirect";
import { SsoCallbackClient } from "./sso-callback-client";

/**
 * OAuth landing route for the custom flow started on `/connect/github`.
 *
 * Clerk normally carries `redirectUrlComplete` through the handshake itself, so
 * the fallback here only applies when that is unavailable (a resumed or
 * malformed callback). It is validated on the server for the same
 * open-redirect reason as the connect entry.
 *
 * `provider` rides in from `/connect/github`'s `redirectCallbackUrl` so the
 * recovery copy on this screen names the provider the user actually picked. An
 * absent value defaults to GitHub, which is what this screen showed before
 * ISS-5112 — so a lost param degrades to the old behavior rather than breaking.
 *
 * `redirect_url` rides in the same way, and is forced as the destination of the
 * sign-UP arm of the handshake; the sign-in arm keeps using the flow's own
 * `redirectUrl`, so nothing about where a returning user lands changes. An
 * absent or untrusted `redirect_url` forces nothing at all. Whether the run
 * created an account is not carried on this URL: the authorize page
 * derives it on the server (ISS-11395 / PLN-2118).
 */
export const metadata = createMetadata({
  title: "Signing in",
  description: "Completing your sign-in.",
});

export default async function SsoCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  const fallbackRedirectUrl = resolveGitHubConnectRedirectFromSearchParams(
    resolved,
    env.NEXT_PUBLIC_APP_URL
  );
  // The null-returning resolver, not the defaulting one: a target that was
  // never sent (or failed the open-redirect boundary) must force nothing, and
  // the default `/` is not a destination worth overriding the flow's own with.
  const rawRedirectUrl = resolved[GITHUB_CONNECT_REDIRECT_PARAM];
  const signUpTarget = resolveGitHubConnectRedirectTarget(
    Array.isArray(rawRedirectUrl) ? rawRedirectUrl[0] : rawRedirectUrl,
    env.NEXT_PUBLIC_APP_URL
  );

  return (
    <SsoCallbackClient
      fallbackRedirectUrl={fallbackRedirectUrl}
      fallbackSignInHref={buildSignInFallbackHref(fallbackRedirectUrl)}
      provider={resolveDesktopSignInProviderFromSearchParams(resolved)}
      signUpRedirectUrl={signUpTarget ?? undefined}
    />
  );
}
