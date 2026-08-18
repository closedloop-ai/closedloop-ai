"use client";

import {
  type SessionPR,
  SessionPrLifecycleStatus,
} from "@repo/api/src/types/agent-session";
import { toGitHubRepoPath } from "@repo/app/agents/lib/session-repository-label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { GitPullRequestIcon } from "lucide-react";

const PULL_REQUEST_NUMBER_REGEX = /^[1-9]\d*$/;

/**
 * Word starts, for the tooltip's title-casing. Mirrors what CSS
 * `text-transform: capitalize` does to the pill, so a multi-word status cannot
 * render differently in the two places.
 */
const TITLE_CASE_WORD_REGEX = /\b\w/g;

/**
 * ISS-4793: how much of a PR subject the pill's tooltip will carry. The title is
 * unbounded text off the wire, so a 200-character subject would otherwise become
 * the entire tooltip.
 */
const PR_TITLE_MAX_LENGTH = 80 as const;

/**
 * ISS-4793: the session-detail Properties-pane "Pull requests" pill, extracted
 * out of the grandfathered `agent-session-detail-view.tsx` (which is shrink-only
 * per the file-size rules) as a sibling of `session-linked-artifacts-row.tsx`.
 *
 * FEA-4256: the pill's whole content is the PR's identity (icon + #num + the
 * GitHub state), so a click on it opens the PR on GitHub, never a branch page.
 * The session-to-branch in-app seam lives on the Branch row instead, so two PRs
 * on one branch stay two distinct destinations. A null href keeps the pill an
 * inert label.
 */
export function PullRequestPill({
  pr,
  repositoryFullName,
}: Readonly<{
  pr: SessionPR;
  repositoryFullName: string | null;
}>) {
  const content = (
    <>
      <GitPullRequestIcon aria-hidden className="size-3.5" />
      <span className="mono">{pr.num}</span>
      <span className="sd3-result-status">{pr.status}</span>
    </>
  );

  const githubHref = getPullRequestHref(pr, repositoryFullName);
  if (!githubHref) {
    // ISS-4793: the unresolvable pill is the one case that most needs a
    // sentence — it is shaped exactly like the clickable pill beside it and is
    // not one, and it is quieter now but quiet is not an explanation. Same DS
    // Tooltip as the link branch, so the reason reaches pointer and touch users
    // (a native `title` gives touch nothing). It stays a non-focusable span: a
    // tabIndex on a non-interactive element is a tab stop that does nothing.
    // Turning the pane's inert chips into real focusable controls — this one and
    // the `+N` overflow chip beside it — is ISS-4897, so they land as one
    // consistent pass rather than three half-measures.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="sd3-result-pr">{content}</span>
        </TooltipTrigger>
        <TooltipContent>
          {buildUnresolvedPullRequestTitle(pr, repositoryFullName)}
        </TooltipContent>
      </Tooltip>
    );
  }

  // ISS-4793: the visible text is bare identity ("4170 Merged") and names
  // neither what it is nor where it goes. This is a real link, so the
  // description rides the design-system Tooltip rather than a native `title`:
  // `title` never opens on keyboard focus or touch, which would have left the
  // exact users this ticket added a focus ring for with nothing. Matches the
  // sibling `LinkedArtifactsOverflowChip`, which already uses the DS Tooltip in
  // this same row.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          className="sd3-result-pr"
          href={githubHref}
          rel="noreferrer"
          target="_blank"
        >
          {content}
        </a>
      </TooltipTrigger>
      <TooltipContent>{buildPullRequestTitle(pr)}</TooltipContent>
    </Tooltip>
  );
}

export function getPullRequestHref(
  pr: SessionPR,
  repositoryFullName: string | null
): string | null {
  const repo = toGitHubRepoPath(repositoryFullName);
  const prNumber = normalizePullRequestNumber(pr.num);

  if (!(repo && prNumber)) {
    return null;
  }

  return `https://github.com/${repo}/pull/${prNumber}`;
}

function normalizePullRequestNumber(value: number | string): string | null {
  const raw = String(value).trim();
  if (!PULL_REQUEST_NUMBER_REGEX.test(raw)) {
    return null;
  }

  return raw;
}

/**
 * The pill's tooltip copy.
 *
 * The status is title-cased here rather than left as the raw wire value (which
 * is lowercase, and only looks capitalized in the pill because
 * `.sd3-result-status` applies `text-transform: capitalize`), so the tooltip
 * cannot read "merged" a pixel below a pill reading "Merged". It capitalizes
 * EVERY word, matching what the CSS does: `sessionPrSchema` accepts any 1-64
 * character status and `sanitizeUnverifiedSessionPrStatus` passes unrecognized
 * legacy values through verbatim, so a multi-word status like "changes
 * requested" is reachable and a capitalize-first would render "Changes
 * Requested" in the pill and "Changes requested" in the tooltip below it.
 *
 * `unknown` is NOT a GitHub state — it is the projection's sentinel for "we
 * could not verify the lifecycle" (`derivePrLifecycleStatus`'s default, and
 * what an unverified "merged" is rewritten to). Rendering it as "(Unknown)"
 * inside a sentence reads as a state the PR is in, so it gets explicit
 * not-a-state wording instead.
 *
 * The subject is truncated rather than allowed to run unbounded, and omitted
 * entirely when absent so no empty separator dangles.
 */
export function buildPullRequestTitle(pr: SessionPR): string {
  const head = `Pull request #${pr.num}${buildStatusSuffix(pr.status)}`;
  const subject = toPullRequestSubject(pr);
  return subject
    ? `${head}: ${subject}. Opens on GitHub.`
    : `${head}. Opens on GitHub.`;
}

function buildStatusSuffix(status: string): string {
  const raw = status?.trim() ?? "";
  if (!raw) {
    return "";
  }
  if (raw.toLowerCase() === SessionPrLifecycleStatus.Unknown) {
    return " (status not verified)";
  }
  return ` (${toTitleCase(raw)})`;
}

function toTitleCase(value: string): string {
  return value.replace(
    TITLE_CASE_WORD_REGEX,
    (word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`
  );
}

/**
 * The PR's real subject, or "" when we do not have one.
 *
 * `sessionPrWithLifecycle` (`packages/lib/session-trace/derivation.ts`) fills an
 * absent title with the literal `PR #<num>`, and `sessionPrSchema` requires
 * `title` min-length 1 on the legacy JSON path, so "no subject" reaches this
 * component as that placeholder rather than as an empty string. Echoing it back
 * would render "Pull request #4170: PR #4170", presenting the projection's
 * stand-in for missing data as the data itself. Drop it and let the caller fall
 * back to the head-only sentence, which is what we can actually assert.
 */
/**
 * The unresolvable pill's tooltip copy: the same identity sentence as the link
 * branch, then WHY there is no destination, so the reader is not left comparing
 * two identical-looking chips and guessing.
 *
 * The two causes are distinguishable and mean different things to the reader: a
 * session whose repository never resolved (nothing to link against) versus a PR
 * reference whose number is not a usable GitHub number. Naming the actual one
 * beats a single generic "unavailable".
 */
export function buildUnresolvedPullRequestTitle(
  pr: SessionPR,
  repositoryFullName: string | null
): string {
  const head = `Pull request #${pr.num}${buildStatusSuffix(pr.status)}`;
  const subject = toPullRequestSubject(pr);
  const identity = subject ? `${head}: ${subject}.` : `${head}.`;
  const reason = toGitHubRepoPath(repositoryFullName)
    ? "This reference has no usable pull request number, so it cannot be opened."
    : "No repository is linked to this session, so it cannot be opened on GitHub.";
  return `${identity} ${reason}`;
}

function toPullRequestSubject(pr: SessionPR): string {
  const subject = pr.title?.trim() ?? "";
  if (!subject || subject === `PR #${pr.num}`) {
    return "";
  }
  if (subject.length > PR_TITLE_MAX_LENGTH) {
    return `${subject.slice(0, PR_TITLE_MAX_LENGTH).trimEnd()}…`;
  }
  return subject;
}
