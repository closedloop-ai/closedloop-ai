"use client";

import { SignIn as ClerkSignIn } from "@clerk/nextjs";
import type { ComponentProps } from "react";
import { githubFirstAuthPageAppearance } from "./appearance";

type SignInProps = {
  /**
   * ISS-5954: prefill for the sign-in form — the desktop email landing branch
   * passes the already-narrowed typed address as `initialValues.emailAddress`.
   * A hint only; Clerk verifies the address.
   */
  initialValues?: ComponentProps<typeof ClerkSignIn>["initialValues"];
  /**
   * ISS-5954: post-sign-in destination override for a host whose target is
   * NOT the query string's to read — the desktop email landing branch
   * validates `redirect_url` server-side and passes the result here, so the
   * embed never consumes the raw (attacker-controllable) param itself.
   */
  forceRedirectUrl?: string;
  /** Same destination for the cross-linked sign-UP flow ("Don't have an account?"). */
  signUpForceRedirectUrl?: string;
  /**
   * `hash` for a host mounted anywhere other than the dedicated /sign-in page
   * — Clerk's multi-step flow (verification code) then stays on that URL
   * instead of requiring the configured path route.
   */
  routing?: "hash";
};

/**
 * Web sign-in embed. Applies the GitHub-first appearance as the default
 * presentation (FEA-4059, PRD-532 M7): GitHub is the single filled primary
 * call-to-action, Google reads as an outline fallback, and the email/password
 * submit is demoted to secondary. All sign-in methods remain available — this
 * only sets which appearance is the default. Rendered on web and driven by the
 * desktop browser-based sign-in flow, so both surfaces share this embed.
 * Client component because Clerk's `<SignIn>` embed hydrates on the client.
 */
export const SignIn = ({
  forceRedirectUrl,
  signUpForceRedirectUrl,
  routing,
  initialValues,
}: SignInProps = {}) => (
  <ClerkSignIn
    appearance={githubFirstAuthPageAppearance}
    forceRedirectUrl={forceRedirectUrl}
    initialValues={initialValues}
    routing={routing}
    signUpForceRedirectUrl={signUpForceRedirectUrl}
  />
);
