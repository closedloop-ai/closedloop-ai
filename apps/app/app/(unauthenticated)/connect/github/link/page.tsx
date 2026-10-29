import {
  GITHUB_CLERK_LINK_PATH,
  GITHUB_RESUME_INSTALLATION_ID_PARAM,
} from "@repo/api/src/types/github-clerk-link";
import { auth } from "@repo/auth/server";
import { createMetadata } from "@repo/seo/metadata";
import { getCanonicalBranchViewReturnPath } from "@/app/api/integrations/github/github-return-path";
import { ClerkGitHubLinkClient } from "./clerk-github-link-client";

/**
 * Clerk GitHub LINKING entry (PLN-1742 M3; sole authorize front door since
 * M5). The sibling `/connect/github` route signs a user IN with GitHub; this
 * one attaches GitHub as an external account to an EXISTING session
 * (Google/email users). It replaced the in-house `/api/integrations/github`
 * authorize redirect, which since M5 exists only to redirect stale clients
 * here.
 *
 * `returnTo` is validated HERE, on the server, exactly like the legacy route
 * validated it: it is attacker-controllable and becomes a post-link
 * navigation target. The client receives only an already-canonicalized
 * same-origin path.
 */
export const metadata = createMetadata({
  title: "Connecting GitHub",
  description: "Link your GitHub account to Closedloop.",
});

/** Same default landing the legacy authorize flow uses. */
const DEFAULT_RETURN_PATH = "/settings";

/** GitHub installation ids are positive integers; anything else is not ours. */
const NUMERIC_INSTALLATION_ID_PATTERN = /^\d{1,20}$/u;

export default async function ClerkGitHubLinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  const rawReturnTo =
    typeof resolved.returnTo === "string" ? resolved.returnTo : null;
  const { orgSlug } = await auth();
  const returnToPath =
    getCanonicalBranchViewReturnPath(rawReturnTo, { orgSlug }) ??
    DEFAULT_RETURN_PATH;
  // Where a signed-out visitor should land AFTER signing in: this page, with
  // the RAW returnTo preserved — not the destination. Signing in must resume
  // the connect, and the raw value matters because a signed-out `auth()` has
  // no orgSlug, so `returnToPath` above already degraded to the default.
  const resumePath =
    rawReturnTo === null
      ? GITHUB_CLERK_LINK_PATH
      : `${GITHUB_CLERK_LINK_PATH}?returnTo=${encodeURIComponent(rawReturnTo)}`;
  // Set by the install callback when the App is installed but the claim was
  // refused for a missing GitHub link (PLN-1742 M5). Validated here, on the
  // server, for the same reason `returnTo` is: it arrives on a query string.
  const rawResumeInstallationId =
    typeof resolved[GITHUB_RESUME_INSTALLATION_ID_PARAM] === "string"
      ? (resolved[GITHUB_RESUME_INSTALLATION_ID_PARAM] as string)
      : null;
  const resumeInstallationId =
    rawResumeInstallationId &&
    NUMERIC_INSTALLATION_ID_PATTERN.test(rawResumeInstallationId)
      ? rawResumeInstallationId
      : null;
  return (
    <ClerkGitHubLinkClient
      resumeInstallationId={resumeInstallationId}
      resumePath={resumePath}
      returnToPath={returnToPath}
    />
  );
}
