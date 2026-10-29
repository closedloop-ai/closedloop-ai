"use client";

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { KPI_NO_VALUE } from "@repo/app/shared/lib/format-utils";
import { sessionOutputDiffDisplay } from "./session-output-diff-display";

/**
 * FEA-4378: the value for the session-detail Properties panel's own "Lines
 * changed" row (see {@link agent-session-detail-view.tsx}) — deliberately NOT
 * riding inside the "Pull requests" pills row, so a number after the PR pills can
 * never be misread as "LOC for those PRs".
 *
 * ISS-9964 / ISS-9980 (RULED 2026-09-11) reduced this to ONE measured shape. The
 * row now prints the lines this session landed in MERGED authored PRs and
 * nothing else — the same number the LOC/$ ratio beside it divides, from the
 * same {@link sessionOutputDiffDisplay} derivation, so the two can no longer
 * disagree. The working-tree and branch-diff rungs are gone, not re-homed: the
 * session scalars are transcript-derived (FEA-3922/FEA-3923) and fold a
 * delegated sub-agent's churn in (ISS-5402), which read 5313 against a 345-line
 * shipped diff on golden session 96fef0b5, and the branch diff spans sessions
 * this one did not author. Neither is delivered code, so neither belongs in a
 * delivered-code row. Losing the green/red `+added / -removed` split is the
 * cost of that: a merged-PR roll-up carries only `additions + deletions` per PR,
 * so there is no honest per-side breakdown left to color, and the combined total
 * renders at plain foreground weight — the green `.add` means "added" everywhere
 * else in this pane and this number is not that.
 *
 * `unavailable` is NOT "zero lines". A session that merged nothing prints a real
 * `0`; `unavailable` means the merged count could not be resolved at all (a
 * desktop session before its first cloud sync, a version-skewed producer sending
 * only the legacy `authoredPrLinesChanged` key, or ISS-4448's session whose 88
 * merged PRs have no reachable per-PR LOC rows). It renders the shared
 * {@link KPI_NO_VALUE} the other not-measured values in this pane use, rather
 * than a `0` that would report a measurement nobody took.
 *
 * Reuses the shipped `.sd3-out-diff` tokens; no new palette. Extracted to a
 * sibling so `agent-session-detail-view.tsx` does not grow.
 */
export function SessionOutputDiff({
  session,
}: Readonly<{
  session: Pick<
    AgentSessionDetail,
    "mergedAuthoredPrLinesChanged" | "authoredPrLinesChanged"
  >;
}>) {
  const display = sessionOutputDiffDisplay(session);
  if (display.kind === "unavailable") {
    return (
      <span className="sd3-out-diff">
        <b className="total">{KPI_NO_VALUE}</b>
        <span className="sd3-out-label">not available</span>
      </span>
    );
  }
  return (
    <span className="sd3-out-diff">
      <b className="total">{display.linesChanged.toLocaleString()}</b>
      <span className="sd3-out-label">in merged PRs</span>
    </span>
  );
}
