"use client";

import type {
  BranchPageDetail,
  BranchPrState,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  ExternalLinkIcon,
  FileTextIcon,
  GitPullRequestIcon,
} from "lucide-react";
import { useState } from "react";

/**
 * "What was delivered" section of the Branch-details tab (Epic F / FEA-1952).
 * Ports the design handoff's `BQContextFull`: a section header, then two boxes —
 * box 1 is the branch's LINKED ARTIFACTS (the Closedloop documents/plans/features
 * the branch implements), box 2 is the PULL REQUEST (identity + read-only
 * description).
 *
 * v1 data reality (desktop local source): box 1 reads `detail.linkedArtifacts`
 * (slug only — no title/url is captured locally), derived from the branch-name's
 * embedded slug (e.g. `fea-1952-…` → FEA-1952); session-transcript mentions are
 * deliberately excluded. The PR identity (`prNumber`/`prTitle`/`prUrl`/`prState`)
 * is real; `prBody` has no producer yet (FEA-1899 enrichment), so the description
 * renders its empty state on most branches. The "draft from session" generation
 * CTA from the mock is omitted (no producer; deferred).
 */

export type BranchDeliveredPanelProps = {
  detail: BranchPageDetail;
};

const PR_STATE_CHIP: Record<
  BranchPrState,
  { label: string; variant: "info" | "success" | "muted" }
> = {
  [GitHubPRState.Open]: { label: "Open", variant: "info" },
  [GitHubPRState.Merged]: { label: "Merged", variant: "success" },
  [GitHubPRState.Closed]: { label: "Closed", variant: "muted" },
};

/**
 * Box 1 — linked Closedloop artifacts the branch implements, derived from the
 * branch-name slug (e.g. "fea-1952-…" → FEA-1952). v1 captures the slug only (no
 * title/url), so each row shows the slug.
 */
function LinkedArtifacts({ detail }: { detail: BranchPageDetail }) {
  if (detail.linkedArtifacts.length === 0) {
    return <p className="bq-ctx-empty-hint">No linked artifacts.</p>;
  }
  return (
    <div className="bq-ctx-issues">
      {detail.linkedArtifacts.map((artifact) => (
        <div className="bq-ctx-issue" key={artifact.slug}>
          <span className="bq-ctx-iss-key font-mono">
            <FileTextIcon aria-hidden className="mr-1 inline size-3" />
            {artifact.slug}
          </span>
          <span className="bq-ctx-iss-title text-muted-foreground">
            Closedloop artifact
          </span>
          <span />
        </div>
      ))}
    </div>
  );
}

/** Box 2 — the pull request: identity (number/title/state/link) + description. */
function PullRequest({ detail }: { detail: BranchPageDetail }) {
  const [open, setOpen] = useState(false);
  const hasPr = detail.prNumber != null;
  const body = detail.prBody?.trim() ? detail.prBody : null;
  const stateChip =
    detail.prState == null ? null : PR_STATE_CHIP[detail.prState];

  return (
    <div className="bq-ctx-pr">
      <div className="bq-ctx-prhead">
        <GitPullRequestIcon aria-hidden className="size-3.5" />
        <span className="bq-ctx-prlabel">Pull request</span>
        {hasPr ? (
          <span className="bq-ctx-prnum font-mono">#{detail.prNumber}</span>
        ) : null}
        {stateChip ? (
          <Chip size="sm" variant={stateChip.variant}>
            {stateChip.label}
          </Chip>
        ) : null}
        {detail.prUrl ? (
          <a
            aria-label={`Open pull request #${detail.prNumber} on GitHub`}
            className="ml-auto text-muted-foreground hover:text-foreground"
            href={detail.prUrl}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLinkIcon aria-hidden className="size-3.5" />
          </a>
        ) : null}
      </div>
      {hasPr && detail.prTitle ? (
        <p className="mb-1.5 font-medium text-sm">{detail.prTitle}</p>
      ) : null}
      {body ? (
        <>
          <div className={open ? "bq-ctx-prbody" : "bq-ctx-prbody clamped"}>
            {body}
          </div>
          <button
            aria-expanded={open}
            className="bq-ctx-more"
            onClick={() => setOpen((value) => !value)}
            type="button"
          >
            {open ? "Show less" : "Show full description"}
          </button>
        </>
      ) : (
        <p className="bq-ctx-empty-t">
          {hasPr
            ? `Pull request #${detail.prNumber} has no description captured yet.`
            : "No pull request opened yet — a description is captured once a PR is raised."}
        </p>
      )}
    </div>
  );
}

export function BranchDeliveredPanel({ detail }: BranchDeliveredPanelProps) {
  return (
    <section className="bq-ctx">
      <div className="bq-sec-head">
        <span className="bq-sec-title">What was delivered</span>
      </div>
      <LinkedArtifacts detail={detail} />
      <PullRequest detail={detail} />
    </section>
  );
}
