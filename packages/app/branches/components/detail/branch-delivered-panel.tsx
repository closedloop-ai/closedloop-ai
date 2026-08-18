"use client";

import type {
  BranchPageDetail,
  BranchPrState,
} from "@repo/api/src/types/branch";
import { BranchLinkedArtifactCollectionState } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { getLabelForSlug } from "@repo/app/documents/lib/document-navigation";
import { Chip } from "@repo/design-system/components/ui/chip";
import { Link } from "@repo/navigation/link";
import {
  ExternalLinkIcon,
  FileTextIcon,
  GitPullRequestIcon,
} from "lucide-react";
import { useState } from "react";
import { PrDescriptionMarkdown } from "../pr-comment-markdown";

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
 * is real. Its selected-PR body is rendered through the shared safe GitHub
 * Markdown policy on both web and Desktop. The "draft from session" generation
 * CTA from the mock is omitted (no producer; deferred).
 */

export type BranchDeliveredPanelProps = {
  detail: BranchPageDetail;
  /**
   * FEA-4292: resolve the in-app href for a recognized Closedloop artifact slug
   * so "What was delivered" links each artifact to its canonical record — the
   * same navigation affordance Session Properties uses (`IssueLinkPill`).
   * Web injects an org-relative route; Desktop injects an absolute web-app URL
   * because it has no document detail routes. A null return for a given slug
   * (non-navigable/untyped) renders that row as a plain label.
   */
  getArtifactHref?: (slug: string) => string | null;
};

const PR_STATE_CHIP: Record<
  BranchPrState,
  { label: string; variant: "info" | "success" | "muted" }
> = {
  [GitHubPRState.Open]: { label: "Open", variant: "info" },
  [GitHubPRState.Merged]: { label: "Merged", variant: "success" },
  [GitHubPRState.Closed]: { label: "Closed", variant: "muted" },
};
const ABSOLUTE_HTTP_HREF = /^https?:\/\//;

/** The kind label + slug for one linked artifact, in the row's inner grid. */
function LinkedArtifactRowBody({
  slug,
  kindLabel,
}: {
  slug: string;
  kindLabel: string;
}) {
  return (
    <>
      <span className="bq-ctx-iss-key font-mono">
        <FileTextIcon aria-hidden className="mr-1 inline size-3" />
        {slug}
      </span>
      <span className="bq-ctx-iss-title">{kindLabel}</span>
    </>
  );
}

/**
 * One linked-artifact row. FEA-4292: when the shell supplies an href
 * (`getArtifactHref`), the ENTIRE row links to the artifact's canonical record.
 * Root-relative destinations use the in-app navigation port; absolute Desktop
 * web-app destinations use an external anchor so Electron hands them to the OS
 * browser instead of hash-prefixing and dropping them. Otherwise the row is an
 * inert `<div>`. The accessible name leads with the artifact kind, matching
 * Session Properties; the leading icon stays `aria-hidden`.
 */
function LinkedArtifactRow({
  slug,
  href,
}: {
  slug: string;
  href: string | null;
}) {
  // Name the kind from the slug prefix (Issue/PRD/Plan/Document); a slug we can't
  // type (e.g. PRO-/WRK-/SES-, which also produce no href) falls back to a plain
  // "Artifact" instead of the old repeated "Closedloop artifact".
  const kindLabel = getLabelForSlug(slug) ?? "Artifact";
  if (!href) {
    return (
      <div className="bq-ctx-issue">
        <LinkedArtifactRowBody kindLabel={kindLabel} slug={slug} />
      </div>
    );
  }
  if (ABSOLUTE_HTTP_HREF.test(href)) {
    return (
      <a
        aria-label={`${kindLabel} ${slug}`}
        className="bq-ctx-issue bq-ctx-issue-link"
        href={href}
        rel="noreferrer"
        target="_blank"
      >
        <LinkedArtifactRowBody kindLabel={kindLabel} slug={slug} />
      </a>
    );
  }
  return (
    <Link
      aria-label={`${kindLabel} ${slug}`}
      className="bq-ctx-issue bq-ctx-issue-link"
      href={href}
    >
      <LinkedArtifactRowBody kindLabel={kindLabel} slug={slug} />
    </Link>
  );
}

/**
 * Box 1 — linked Closedloop artifacts the branch implements, derived from the
 * branch-name slug (e.g. "fea-1952-…" → FEA-1952). v1 captures the slug only (no
 * title/url), so each row shows the slug plus its derived kind. FEA-4292: a
 * recognized slug links the whole row to its canonical record when the shell
 * provides `getArtifactHref`.
 */
function LinkedArtifacts({
  detail,
  getArtifactHref,
}: {
  detail: BranchPageDetail;
  getArtifactHref?: (slug: string) => string | null;
}) {
  if (detail.linkedArtifacts.length === 0) {
    return (
      <div>
        <p className="bq-ctx-empty-hint">
          {detail.linkedArtifactsCollection?.state ===
          BranchLinkedArtifactCollectionState.Complete
            ? "No linked artifacts."
            : "Linked artifacts are unavailable."}
        </p>
        <ArtifactCoverageNote detail={detail} />
      </div>
    );
  }
  return (
    <div>
      <div className="bq-ctx-issues">
        {detail.linkedArtifacts.map((artifact) => (
          <LinkedArtifactRow
            href={getArtifactHref?.(artifact.slug) ?? null}
            key={artifact.slug}
            slug={artifact.slug}
          />
        ))}
      </div>
      <ArtifactCoverageNote detail={detail} />
    </div>
  );
}

/** Box 2 — the pull request: identity (number/title/state/link) + description. */
function PullRequest({ detail }: { detail: BranchPageDetail }) {
  const [open, setOpen] = useState(false);
  const selected = detail.selectedPullRequest;
  const prNumber = selected ? selected.number : detail.prNumber;
  const hasPr = prNumber != null;
  const bodySource = selected?.body ?? detail.prBody;
  const body = bodySource?.trim() ? bodySource : null;
  const prState = selected ? selected.state : detail.prState;
  const stateChip = prState == null ? null : PR_STATE_CHIP[prState];
  const prUrl = selected ? selected.url : detail.prUrl;
  const prTitle = selected ? selected.title : detail.prTitle;

  return (
    <div className="bq-ctx-pr">
      <div className="bq-ctx-prhead">
        <GitPullRequestIcon aria-hidden className="size-3.5" />
        <span className="bq-ctx-prlabel">Pull request</span>
        {hasPr ? (
          <span className="bq-ctx-prnum font-mono">#{prNumber}</span>
        ) : null}
        {stateChip ? (
          <Chip size="sm" variant={stateChip.variant}>
            {stateChip.label}
          </Chip>
        ) : null}
        {prUrl ? (
          <a
            aria-label={`Open pull request #${prNumber} on GitHub`}
            className="ml-auto text-muted-foreground hover:text-foreground"
            href={prUrl}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLinkIcon aria-hidden className="size-3.5" />
          </a>
        ) : null}
      </div>
      {hasPr && prTitle ? (
        <p className="mb-1.5 font-medium text-sm">{prTitle}</p>
      ) : null}
      {body ? (
        <>
          <div
            className={open ? "bq-ctx-prbody" : "bq-ctx-prbody clamped"}
            inert={!open}
          >
            <PrDescriptionMarkdown text={body} />
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
            ? `Pull request #${prNumber} has no description captured yet.`
            : "No pull request opened yet — a description is captured once a PR is raised."}
        </p>
      )}
    </div>
  );
}

function ArtifactCoverageNote({ detail }: { detail: BranchPageDetail }) {
  const state = detail.linkedArtifactsCollection?.state;
  if (state !== BranchLinkedArtifactCollectionState.Incomplete) {
    return null;
  }
  return (
    <p className="mt-2 text-muted-foreground text-xs">
      The linked artifact list includes only the relationships we could verify.
    </p>
  );
}

export function BranchDeliveredPanel({
  detail,
  getArtifactHref,
}: BranchDeliveredPanelProps) {
  return (
    <section className="bq-ctx">
      <div className="bq-sec-head">
        <span className="bq-sec-title">What was delivered</span>
      </div>
      <LinkedArtifacts detail={detail} getArtifactHref={getArtifactHref} />
      <PullRequest detail={detail} />
    </section>
  );
}
