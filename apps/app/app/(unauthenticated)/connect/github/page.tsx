import {
  DesktopSignInFraming,
  providerForSignInMethod,
} from "@repo/api/src/types/desktop-authorize-url";
import { SignIn } from "@repo/auth/components/sign-in";
import { SignUp } from "@repo/auth/components/sign-up";
import { createMetadata } from "@repo/seo/metadata";
import { env } from "@/env";
import { resolveDesktopBootstrapBrowserRun } from "@/lib/desktop-bootstrap-run";
import {
  buildSignInFallbackHref,
  resolveDesktopEmailHintFromSearchParams,
  resolveDesktopSignInFramingFromSearchParams,
  resolveDesktopSignInMethodFromSearchParams,
  resolveGitHubConnectRedirectFromSearchParams,
} from "@/lib/github-connect-redirect";
import { DesktopBootstrapSignUpGate } from "../../sign-up/desktop-bootstrap-sign-up-gate";
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
  const method = resolveDesktopSignInMethodFromSearchParams(resolved);
  const provider = providerForSignInMethod(method);

  // ISS-5954 M3 — the email landing branch. An SSO auto-fire is right for a
  // social pick and wrong for email, which has no consent screen to skip: the
  // person lands on the Clerk sign-up/sign-in form instead, with the validated
  // `redirect_url` preserved on BOTH directions of the embed so completing
  // either flow returns to the desktop authorize page and the loopback
  // listener finishes normally. Hash routing keeps the multi-step form
  // (verification code) on this URL rather than requiring the /sign-up route.
  if (!provider) {
    // M5: the typed address prefills the form when the desktop sent one —
    // narrowed by the resolver, absent otherwise.
    const emailHint = resolveDesktopEmailHintFromSearchParams(resolved);
    const initialValues = emailHint ? { emailAddress: emailHint } : undefined;
    // A returning-user door (the guided onboarding Account step's "Already
    // have an account? Sign in", Settings → Account) declares the sign-in
    // framing, and answering it with an account-creation form is the
    // wrong-door class this route exists to close — that framing renders the
    // sign-IN embed. Both embeds keep the validated `redirect_url` on BOTH
    // directions, so either cross-link still returns to the desktop authorize
    // page.
    if (
      resolveDesktopSignInFramingFromSearchParams(resolved) ===
      DesktopSignInFraming.SignIn
    ) {
      return (
        <SignIn
          forceRedirectUrl={target}
          initialValues={initialValues}
          routing="hash"
          signUpForceRedirectUrl={target}
        />
      );
    }
    const browserRun = await resolveDesktopBootstrapBrowserRun();
    return (
      <DesktopBootstrapSignUpGate browserRun={browserRun}>
        <SignUp
          forceRedirectUrl={target}
          initialValues={initialValues}
          routing="hash"
          signInForceRedirectUrl={target}
        />
      </DesktopBootstrapSignUpGate>
    );
  }

  return (
    <GitHubConnectRedirectClient
      fallbackSignInHref={buildSignInFallbackHref(target)}
      provider={provider}
      redirectUrlComplete={target}
    />
  );
}
