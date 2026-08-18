"use client";

import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { parseBranchViewFileDiffAccessDenial } from "@repo/app/github/lib/branch-view-file-diff-access";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { usePath } from "@repo/navigation/use-path";
import { Clock, CloudOff, Github, Lock, type LucideIcon } from "lucide-react";
import { getGitHubConnectUrl } from "@/lib/integration-connect-urls";

/**
 * The diff pane's failure state. Branch View reads run as the requesting user
 * with no installation-credential fallback (PLN-1525), so a refusal now has a
 * specific cause worth naming instead of collapsing into "Failed to load diff".
 *
 * Two shapes of cause, and the difference is what the reader needs: a
 * credential problem they can fix from here (connect / reconnect), versus
 * repository access only GitHub can grant — where offering a button would be a
 * dead end.
 */

type DenialCopy = {
  title: string;
  body: string;
  /**
   * Named per cause, not derived from whether there's a button: a padlock on
   * "GitHub didn't respond" would read as "you're locked out" when GitHub is
   * just having a moment.
   */
  icon: LucideIcon;
  /** Credential problems get a connect CTA; access problems get none. */
  connectLabel: string | null;
};

// Total by construction: a new GitHubAccessDenialReason fails typecheck here
// until it is given copy, rather than silently rendering an empty pane.
const DENIAL_COPY: Record<GitHubAccessDenialReason, DenialCopy> = {
  [GitHubAccessDenialReason.NotConnected]: {
    title: "Connect GitHub to view this diff",
    body: "File contents are read with your own GitHub access, so you see exactly what you can see on GitHub.",
    icon: Github,
    connectLabel: "Connect GitHub",
  },
  [GitHubAccessDenialReason.Revoked]: {
    title: "Your GitHub connection needs renewing",
    body: "The access you granted is no longer valid. Reconnect to keep reading diffs as yourself.",
    icon: Github,
    connectLabel: "Reconnect GitHub",
  },
  [GitHubAccessDenialReason.InsufficientScope]: {
    title: "Your GitHub connection is missing repository access",
    body: "Reconnect and grant access to this repository to view its diffs.",
    icon: Github,
    connectLabel: "Reconnect GitHub",
  },
  [GitHubAccessDenialReason.OrgRestricted]: {
    title: "This organization hasn't approved Closedloop on GitHub",
    body: "An owner of the GitHub organization needs to approve access before these diffs can load.",
    icon: Lock,
    connectLabel: null,
  },
  // Deliberately names the reader's own repository access, NOT the "Install
  // ClosedLoop" remedy the shared taxonomy suggests for this reason. The
  // resolver collapses 403 and 404 into `no_installation` because GitHub
  // cloaks a no-access private repo as a 404, so the two are indistinguishable
  // from the response. In THIS pane the repository provably has a Closedloop
  // installation already (the branch and PR records came through it), which
  // leaves "your GitHub account cannot read it" as the live cause. Offering an
  // install here would send the reader to a flow that cannot fix their problem
  // and that most members cannot complete.
  [GitHubAccessDenialReason.NoInstallation]: {
    title: "You don't have access to this repository",
    body: "This diff is only visible to people whose GitHub account can read the repository. Ask an admin there for access.",
    icon: Lock,
    connectLabel: null,
  },
  [GitHubAccessDenialReason.RateLimited]: {
    title: "GitHub is rate-limiting this request",
    body: "Too many GitHub requests right now. This usually clears in a few minutes. Reopen the file to try again.",
    icon: Clock,
    connectLabel: null,
  },
  [GitHubAccessDenialReason.Unavailable]: {
    title: "GitHub didn't respond",
    body: "The diff couldn't be loaded from GitHub. Reopen the file to try again.",
    icon: CloudOff,
    connectLabel: null,
  },
  // Sync-lane-only outcome (PLN-1535 coverage marker) with no interactive path
  // to this pane; the map stays total so adding a reason cannot skip this file.
  [GitHubAccessDenialReason.BudgetDeferred]: {
    title: "GitHub didn't respond",
    body: "The diff couldn't be loaded from GitHub. Reopen the file to try again.",
    icon: CloudOff,
    connectLabel: null,
  },
};

const GENERIC_DIFF_ERROR = "Failed to load diff";

/**
 * The diff pane's error slot: a named access denial when the API said so,
 * otherwise the generic message this surface has always shown. Keeping both
 * behind one component means the grandfathered `branch-diff-view` only ever
 * renders "the error state" and never learns the branching.
 *
 * Ungated. A denial only reaches here when the API refused the read with
 * `github_access_denied`, which nothing produced before PLN-1525, so every
 * render of the named state replaces a generic "Failed to load diff" that was
 * strictly less informative. Any other failure still takes the generic path.
 */
export function BranchDiffErrorState({ error }: Readonly<{ error: unknown }>) {
  const denial = parseBranchViewFileDiffAccessDenial(error);

  if (!denial) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        {GENERIC_DIFF_ERROR}
      </div>
    );
  }
  return <BranchDiffAccessDenied reason={denial} />;
}

export function BranchDiffAccessDenied({
  reason,
}: Readonly<{ reason: GitHubAccessDenialReason }>) {
  const copy = DENIAL_COPY[reason];
  // Send the reader back to the diff they were already looking at. Read
  // through the navigation port, not `globalThis.location`, so the href is
  // identical on the server and the first client render and cannot cause a
  // hydration mismatch.
  const connectHref = getGitHubConnectUrl("authorize", {
    returnTo: usePath(),
  });

  return (
    // The section carries the accessible name; EmptyState renders a plain
    // container, so without it this pane would announce as unlabelled.
    <section
      aria-label={copy.title}
      className="flex h-full items-center justify-center"
    >
      <EmptyState
        action={
          copy.connectLabel ? (
            // A real anchor, carrying the mark, to match the connect button in
            // `branch-comment-write-identity-prompt` that can share this screen.
            // The href also has to survive middle-click and keyboard opening,
            // which a navigation-only onClick does not.
            <Button asChild className="gap-1.5" size="sm">
              <a href={connectHref}>
                <Github className="h-3.5 w-3.5" />
                {copy.connectLabel}
              </a>
            </Button>
          ) : undefined
        }
        description={copy.body}
        icon={copy.icon}
        size="compact"
        title={copy.title}
      />
    </section>
  );
}
