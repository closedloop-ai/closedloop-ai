"use client";

import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import type { SessionUntrackedRepositoryTarget } from "@repo/api/src/types/session-untracked-repository";
import { GitBranchIcon, GitPullRequestIcon } from "lucide-react";

/**
 * PLN-2169 M2: the Other repositories VALUE — one pill per untracked
 * repository target the session's run touched, label-free, read by the
 * Properties row (`SessionOtherRepositoriesRow`) and built for the Details tab
 * (M3).
 *
 * Each entry reuses the `.sd3-result-pr` chip the Pull requests and Branches
 * pills use: an external link when the evidence carries a URL, the same chip
 * as inert text when it does not.
 */
export function SessionOtherRepositoriesValue({
  targets,
}: Readonly<{
  targets: readonly SessionUntrackedRepositoryTarget[];
}>) {
  return (
    <>
      {targets.map((target) => (
        <OtherRepositoryPill key={targetKey(target)} target={target} />
      ))}
    </>
  );
}

function OtherRepositoryPill({
  target,
}: Readonly<{ target: SessionUntrackedRepositoryTarget }>) {
  const Icon =
    target.kind === ArtifactRefTargetKind.PullRequest
      ? GitPullRequestIcon
      : GitBranchIcon;
  // Repository and target in their own spans so the pill's gap separates two
  // slash-heavy names; the space between them keeps the accessible name spaced.
  const content = (
    <>
      <Icon aria-hidden className="size-3.5" />
      <span className="mono">{target.repositoryFullName}</span>{" "}
      <span className="mono">{targetAddress(target)}</span>
    </>
  );
  if (target.url === undefined) {
    return <span className={PILL_CLASS_NAME}>{content}</span>;
  }
  return (
    <a
      className={PILL_CLASS_NAME}
      href={target.url}
      rel="noreferrer"
      target="_blank"
    >
      {content}
    </a>
  );
}

function targetAddress(target: SessionUntrackedRepositoryTarget): string {
  return target.kind === ArtifactRefTargetKind.PullRequest
    ? `#${target.prNumber}`
    : target.branchName;
}

function targetKey(target: SessionUntrackedRepositoryTarget): string {
  return `${target.kind}:${target.repositoryFullName}:${targetAddress(target)}`;
}

const PILL_CLASS_NAME = "sd3-result-pr sd3-other-repo-pill";
