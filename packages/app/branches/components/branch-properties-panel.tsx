"use client";

import type {
  BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { BranchStatus as BranchStatusEnum } from "@repo/api/src/types/branch";
import { formatNumber } from "@repo/app/shared/lib/format-utils";
import { activateOnEnterOrSpace } from "@repo/design-system/lib/keyboard-activation";
import {
  ChevronRightIcon,
  GitBranchIcon,
  GitPullRequestIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { BRANCH_STATUS_CONFIG } from "../lib/branch-row";
import { toRenderStatus } from "../lib/branch-row-adapter";
import type { PreferredBranchLoc } from "../lib/live-overlays/use-preferred-branch-loc";

/**
 * Branch Properties panel (Epic D / D8) — restyled to the Branches Page design
 * handoff. Reuses the session-detail's `.sd3-props` "quiet" aesthetic (same
 * collapsible header, preview chips when collapsed, and `prd-props` grid when
 * open) so the branch and session detail rails match. Shows the fields with a
 * real v1 producer (Status, Branch, Pull request, Changes, Reviewer,
 * Repository, Sessions); the empty placeholder fields are not rendered until
 * their enrichment lands. Defaults collapsed, like the session detail.
 */
export type BranchPropertiesPanelProps = {
  detail: BranchPageDetail;
  /** PR-preferred LOC from `usePreferredBranchLoc`; omit to use `detail` columns. */
  loc?: PreferredBranchLoc;
};

/** Status-dot color per branch status, mapped to shared tokens. */
const STATUS_DOT: Record<BranchStatus, string> = {
  [BranchStatusEnum.Open]: "var(--info)",
  [BranchStatusEnum.Review]: "var(--primary)",
  [BranchStatusEnum.Merged]: "var(--success-foreground)",
  [BranchStatusEnum.Draft]: "var(--muted-foreground)",
  [BranchStatusEnum.Blocked]: "var(--destructive)",
  [BranchStatusEnum.Closed]: "var(--muted-foreground)",
};

const EMPTY = "—";

/**
 * Build the full Properties grid rows. Kept out of the component to bound its
 * cognitive complexity — gated fields (no v1 producer) render an explicit empty
 * affordance ("—" / "Unassigned" / "None"), never a fabricated value.
 */
function buildPropertyRows({
  detail,
  dot,
  statusLabel,
  loc,
}: {
  detail: BranchPageDetail;
  dot: string;
  statusLabel: string;
  loc?: PreferredBranchLoc;
}): [string, ReactNode][] {
  // Prefer the connected PR's live LOC (authoritative) over enrichment columns.
  const additions = loc ? loc.additions : detail.additions;
  const deletions = loc ? loc.deletions : detail.deletions;
  const hasChanges = additions != null && deletions != null;
  const changesValue: ReactNode = hasChanges ? (
    <span className="sd3-pp">
      <b className="bq-add">+{formatNumber(additions ?? 0)}</b>
      <b className="bq-del">−{formatNumber(deletions ?? 0)}</b>
    </span>
  ) : (
    EMPTY
  );

  return [
    [
      "Status",
      <span className="sd3-pp" key="status">
        <span className="sd3-status-dot" style={{ background: dot }} />
        {statusLabel}
      </span>,
    ],
    [
      "Branch",
      <span className="font-mono" key="branch" title={detail.branchName}>
        {detail.branchName}
      </span>,
    ],
    [
      "Pull request",
      detail.prNumber == null ? (
        <span className="text-muted-foreground" key="pr">
          No PR yet
        </span>
      ) : (
        <span className="sd3-pp" key="pr" title={formatPrTitle(detail)}>
          <GitPullRequestIcon aria-hidden className="size-3.5" />
          <span className="font-mono">#{detail.prNumber}</span>
          {detail.prTitle ? (
            <span className="min-w-0 truncate">{detail.prTitle}</span>
          ) : null}
        </span>
      ),
    ],
    ["Changes", changesValue],
    [
      "Reviewer",
      <span className="text-muted-foreground" key="rev">
        Unassigned
      </span>,
    ],
    [
      "Repository",
      detail.repoFullName ? (
        <span className="font-mono" key="repo" title={detail.repoFullName}>
          {detail.repoFullName}
        </span>
      ) : (
        EMPTY
      ),
    ],
    [
      "Sessions",
      `${detail.sessions.length} session${detail.sessions.length === 1 ? "" : "s"}`,
    ],
  ];
}

export function BranchPropertiesPanel({
  detail,
  loc,
}: BranchPropertiesPanelProps) {
  const [open, setOpen] = useState(false);
  const statusLabel = BRANCH_STATUS_CONFIG[toRenderStatus(detail.status)].label;
  const dot = STATUS_DOT[detail.status] ?? "var(--muted-foreground)";
  const rows = buildPropertyRows({ detail, dot, statusLabel, loc });

  return (
    <section className="prd-props-section sd3-props bq-props" data-open={open}>
      {/* biome-ignore lint/a11y/useSemanticElements: matches the session detail's role="button" properties header for design parity (FEA-1769). */}
      <div
        aria-expanded={open}
        className="prd-props-header"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={activateOnEnterOrSpace(() => setOpen((value) => !value))}
        role="button"
        tabIndex={0}
      >
        <span className="prd-props-title">Properties</span>
        <span className="prd-props-chevron">
          <ChevronRightIcon aria-hidden className="size-4" />
        </span>
      </div>

      {open ? (
        <div className="prd-props">
          {rows.map(([label, value]) => (
            <div className="prd-prop" key={label}>
              <span className="prd-prop-label">{label}</span>
              <span className="prd-prop-value" style={{ cursor: "default" }}>
                {value}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <button
          className="sd3-props-preview"
          onClick={() => setOpen(true)}
          type="button"
        >
          <span className="sd3-pp">
            <span className="sd3-status-dot" style={{ background: dot }} />
            {statusLabel}
          </span>
          <span className="sd3-pp font-mono" title={detail.branchName}>
            <GitBranchIcon aria-hidden className="size-3" />
            <span className="min-w-0 truncate">{detail.branchName}</span>
          </span>
          {detail.prNumber == null ? null : (
            <span className="sd3-pp font-mono">
              <GitPullRequestIcon aria-hidden className="size-3" />#
              {detail.prNumber}
            </span>
          )}
        </button>
      )}
    </section>
  );
}

function formatPrTitle(detail: BranchPageDetail): string {
  return detail.prTitle
    ? `#${detail.prNumber} ${detail.prTitle}`
    : `#${detail.prNumber}`;
}
