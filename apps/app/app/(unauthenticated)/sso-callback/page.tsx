import { createMetadata } from "@repo/seo/metadata";
import { env } from "@/env";
import {
  buildSignInFallbackHref,
  resolveDesktopSignInProviderFromSearchParams,
  resolveGitHubConnectRedirectFromSearchParams,
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

  return (
    <SsoCallbackClient
      fallbackRedirectUrl={fallbackRedirectUrl}
      fallbackSignInHref={buildSignInFallbackHref(fallbackRedirectUrl)}
      provider={resolveDesktopSignInProviderFromSearchParams(resolved)}
    />
  );
}
