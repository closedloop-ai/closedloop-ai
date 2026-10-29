"use client";

import { SignUp as ClerkSignUp } from "@clerk/nextjs";
import type { ComponentProps } from "react";
import { githubFirstAuthPageAppearance } from "./appearance";

type SignUpProps = {
  /**
   * ISS-5954 M5: prefill for the sign-up form — the desktop email landing
   * branch passes the already-narrowed typed address as
   * `initialValues.emailAddress`. A hint only; Clerk verifies the address.
   */
  initialValues?: ComponentProps<typeof ClerkSignUp>["initialValues"];
  /**
   * ISS-5954 M3: post-sign-up destination override for a host whose target is
   * NOT the query string's to read — the desktop email landing branch validates
   * `redirect_url` server-side and passes the result here, so the embed never
   * consumes the raw (attacker-controllable) param itself.
   */
  forceRedirectUrl?: string;
  /** Same destination for the cross-linked sign-IN flow ("Already have an account?"). */
  signInForceRedirectUrl?: string;
  /**
   * `hash` for a host mounted anywhere other than the dedicated /sign-up page
   * — Clerk's multi-step flow (verification code) then stays on that URL
   * instead of requiring the configured path route.
   */
  routing?: "hash";
};

/**
 * Web sign-up embed. Applies the GitHub-first appearance as the default
 * presentation (FEA-4059, PRD-532 M7): GitHub is the single filled primary
 * call-to-action, Google reads as an outline fallback, and the email/password
 * submit is demoted to secondary. All sign-up methods remain available — this
 * only sets which appearance is the default. Rendered on web and driven by the
 * desktop browser-based sign-in flow, so both surfaces share this embed.
 * Client component because Clerk's `<SignUp>` embed hydrates on the client.
 */
export const SignUp = ({
  forceRedirectUrl,
  signInForceRedirectUrl,
  routing,
  initialValues,
}: SignUpProps = {}) => (
  <ClerkSignUp
    appearance={githubFirstAuthPageAppearance}
    forceRedirectUrl={forceRedirectUrl}
    initialValues={initialValues}
    routing={routing}
    signInForceRedirectUrl={signInForceRedirectUrl}
  />
);
