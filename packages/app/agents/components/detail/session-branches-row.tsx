"use client";

import type { SessionBranch } from "@repo/api/src/types/agent-session";
import { SessionBranchesValue } from "./values/session-branches-value";

/**
 * ISS-8427: the session-detail Properties-pane "Branches" row — the label and
 * the row chrome around {@link SessionBranchesValue}, which owns the pills.
 *
 * Follows `SessionPullRequestsRow` rather than `SessionLinkedArtifactsRow`: the
 * PR row renders every item and states an explicit empty word, where the
 * artifacts row caps behind a `+N` chip whose visible set IS a ranking.
 *
 * The label stays plural at every count, matching the pane's "Pull requests" and
 * "Linked artifacts" siblings — a label that switched word by count would also
 * jitter the fixed label column between sessions.
 */
export function SessionBranchesRow({
  branches,
  getBranchHref,
}: Readonly<{
  branches: readonly SessionBranch[];
  getBranchHref?: (branchArtifactId: string) => string;
}>) {
  // `sd3-linked-prop` pins the label to the top: branch names wrap readily, and
  // the shared `align-items: center` would float the label to the middle of a
  // multi-line pill stack.
  return (
    <div className="prd-prop sd3-linked-prop">
      <span className="prd-prop-label">Branches</span>
      {/* Inert value cell: the pills carry their own affordances, so it must not
          present a pointer cursor. */}
      <div
        className="prd-prop-value sd3-prs-value"
        style={{ cursor: "default" }}
      >
        <SessionBranchesValue
          branches={branches}
          getBranchHref={getBranchHref}
        />
      </div>
    </div>
  );
}
