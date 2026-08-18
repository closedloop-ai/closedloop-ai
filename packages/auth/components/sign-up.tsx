"use client";

import { SignUp as ClerkSignUp } from "@clerk/nextjs";
import { githubFirstAuthPageAppearance } from "./appearance";

/**
 * Web sign-up embed. Applies the GitHub-first appearance as the default
 * presentation (FEA-4059, PRD-532 M7): GitHub is the single filled primary
 * call-to-action, Google reads as an outline fallback, and the email/password
 * submit is demoted to secondary. All sign-up methods remain available — this
 * only sets which appearance is the default. Rendered on web and driven by the
 * desktop browser-based sign-in flow, so both surfaces share this embed.
 * Client component because Clerk's `<SignUp>` embed hydrates on the client.
 */
export const SignUp = () => (
  <ClerkSignUp appearance={githubFirstAuthPageAppearance} />
);
