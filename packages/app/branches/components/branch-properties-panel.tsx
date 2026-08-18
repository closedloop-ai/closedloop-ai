"use client";

import type {
  BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { BranchStatus as BranchStatusEnum } from "@repo/api/src/types/branch";
import { formatNumber } from "@repo/app/shared/lib/format-utils";
import { ChevronRightIcon, GitBranchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { BRANCH_STATUS_CONFIG } from "../lib/branch-row";
import { toRenderStatus } from "../lib/branch-row-adapter";
import type { PreferredBranchLoc } from "../lib/preferred-branch-loc";

/**
 * Branch Properties panel (Epic D / D8) — restyled to the Branches Page design
 * handoff. Reuses the session-detail's `.sd3-props` quiet aesthetic and keeps
 * only Branch-owned facts here. Pull-request selection belongs to the
 * persistent selector below this panel.
 */
export type BranchPropertiesPanelProps = {
  detail: BranchPageDetail;
  /** Branch changed-LOC from `resolvePreferredBranchLoc`; omit to use `detail` columns. */
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
  // PLN-1535 M5.3 retired the live `/pr/files` overlay, so `loc` is now just
  // `resolvePreferredBranchLoc`'s read of the same projection columns; it stays
  // a prop so the page resolves LOC once and every panel shows one number.
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
    ["Changes", changesValue],
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
      <button
        aria-expanded={open}
        className="w-full border-0 bg-transparent p-0 text-left"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="prd-props-header">
          <span className="prd-props-title">Properties</span>
          <span className="prd-props-chevron">
            <ChevronRightIcon aria-hidden className="size-4" />
          </span>
        </span>
        {open ? null : (
          <span className="sd3-props-preview">
            <span className="sd3-pp">
              <span className="sd3-status-dot" style={{ background: dot }} />
              {statusLabel}
            </span>
            <span className="sd3-pp font-mono" title={detail.branchName}>
              <GitBranchIcon aria-hidden className="size-3.5" />
              <span className="min-w-0 truncate">{detail.branchName}</span>
            </span>
          </span>
        )}
      </button>

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
      ) : null}
    </section>
  );
}
