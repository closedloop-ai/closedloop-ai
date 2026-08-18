import { createMetadata } from "@repo/seo/metadata";
import { env } from "@/env";
import {
  buildSignInFallbackHref,
  resolveDesktopSignInProviderFromSearchParams,
  resolveGitHubConnectRedirectFromSearchParams,
} from "@/lib/github-connect-redirect";
import { GitHubConnectRedirectClient } from "./github-connect-redirect-client";

/**
 * GitHub-first connect entry (PRD-562). The proxy sends an unauthenticated
 * desktop authorize request here instead of the generic sign-in embed, so the
 * user lands on the provider's own authorize screen rather than a chooser.
 *
 * Which provider comes from the `provider` param the proxy forwarded off the
 * desktop authorize URL (ISS-5112), defaulting to GitHub when a version-skewed
 * desktop build sends none. Unlike `redirect_url` it is not a security boundary
 * — it selects a sign-in strategy and nothing else — so it is merely narrowed to
 * a known value rather than validated against the origin.
 *
 * The `redirect_url` param is validated HERE, on the server, before it reaches
 * the client: it is attacker-controllable in principle (anyone can craft this
 * link) and becomes a post-authentication navigation target, so an off-origin
 * value would hand a fresh session to another page. The client component
 * receives only an already-normalized same-origin path.
 */
/**
 * Provider-neutral on purpose: this route serves Google as well as GitHub since
 * ISS-5112, and `metadata` is static — it cannot read the `provider` param. A
 * GitHub-specific title would name the wrong provider in the browser tab for the
 * whole redirect, and for the full 10s ceiling if the hop stalls.
 */
export const metadata = createMetadata({
  title: "Connecting your account",
  description: "Authorize Closedloop to connect your account.",
});

export default async function ConnectGitHubPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  const target = resolveGitHubConnectRedirectFromSearchParams(
    resolved,
    env.NEXT_PUBLIC_APP_URL
  );

  return (
    <GitHubConnectRedirectClient
      fallbackSignInHref={buildSignInFallbackHref(target)}
      provider={resolveDesktopSignInProviderFromSearchParams(resolved)}
      redirectUrlComplete={target}
    />
  );
}
