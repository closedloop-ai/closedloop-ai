"use client";

import type {
  AgentSessionDetail,
  SessionBranch,
} from "@repo/api/src/types/agent-session";
import { SessionBranchPill } from "../session-branch-pill";

/**
 * PLN-2169 M2: the Branches VALUE — every branch the session touched as a
 * pill, or the empty word — label-free, read by the Properties row
 * (`SessionBranchesRow`) and built for the Details tab (M3).
 *
 * ISS-8427: renders EVERY branch in the wire's `createdAt asc` order. It does
 * not cap and it does not rank: which of a session's branches matters most is a
 * product question nobody has answered, so the value answers it by not asking —
 * showing all of them drops no data and invents no priority.
 */
export function SessionBranchesValue({
  branches,
  getBranchHref,
}: Readonly<{
  branches: readonly SessionBranch[];
  getBranchHref?: (branchArtifactId: string) => string;
}>) {
  if (branches.length === 0) {
    return <span>{SESSION_EMPTY_BRANCHES_LABEL}</span>;
  }
  return (
    <>
      {branches.map((branch) => (
        <SessionBranchPill
          branch={branch}
          href={getBranchHref?.(branch.branchArtifactId) ?? null}
          key={branch.branchArtifactId}
        />
      ))}
    </>
  );
}

/**
 * ISS-8427: which Branch row a session gets — the plural set, or `null` for the
 * unchanged single-branch row.
 *
 * Two cases fall back, and they fall back for different reasons. An ABSENT
 * `branches` is a producer that does not compute the set (a version-skewed
 * server, and the desktop's local SQLite reader): it can assert "the branch we
 * picked" and not "the branches it touched", so it renders the row that makes
 * only the first claim. An EMPTY `branches` beside a non-null `branch` should be
 * unreachable — both derive from the same eligibility — but if it ever ships,
 * rendering "None" while another served field names a branch would be the pane
 * contradicting its own payload, so the scalar wins.
 *
 * An empty set with no scalar is a real computed answer and renders as one.
 */
export function resolveDisplayedBranches(
  session: Pick<AgentSessionDetail, "branch" | "branches">
): readonly SessionBranch[] | null {
  const served = session.branches;
  if (!served) {
    return null;
  }
  if (served.length === 0 && session.branch) {
    return null;
  }
  return served;
}

/**
 * The word the Branches value shows when the session touched none. The same
 * "None" the single Branch row uses for a null branch — deliberately NOT the
 * PR row's qualified "None authored", whose qualifier exists to reconcile
 * against a Lines-changed figure that needs no PR. "Touched" is already the
 * whole eligibility rule here, so there is nothing to disambiguate.
 */
export const SESSION_EMPTY_BRANCHES_LABEL = "None";
