"use client";

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { sessionOutputDiffDisplay } from "./detail-content";

/**
 * FEA-4378: the value for the session-detail Properties panel's own "Lines
 * changed" row (see {@link agent-session-detail-view.tsx}) — deliberately NOT
 * riding inside the "Pull requests" pills row, so a number after the PR pills can
 * never be misread as "LOC for those PRs". Renders one of three honest shapes
 * ({@link sessionOutputDiffDisplay}):
 *   - `working-tree`: the session's OWN `+added / -removed` diff. Add is
 *     green (`--success-foreground`), removed is red (`--destructive`) — the same
 *     honest per-side meaning those colors carry everywhere else in this pane.
 *     Captioned "in session": this was a local git diff when FEA-4378 shipped, but
 *     FEA-3922 made the scalars transcript-derived and ISS-5402 folded delegated
 *     sub-agent lines into them, so on a delegating session it is the whole
 *     session's authored churn — a real number, but not the working tree and not
 *     the shipped diff. The old "working tree" caption named a scope this value no
 *     longer has.
 *   - `branch-diff` (ISS-4448): the session's branch-level `+added / -removed` diff
 *     (`branchDiffStats`), used when it is materially larger than both the local
 *     residual and the authored-PR roll-up. A real per-side split, so it keeps the
 *     green/red coloring; a quiet "on branch" qualifier distinguishes it from the
 *     tiny local residual. This is the fix for the 88-merged-PR session that read
 *     `+51 -5` (local residual) while its branch diff was 3315/689.
 *   - `authored-pr`: the summed lines *changed* across the session's AUTHORED PRs
 *     (the real delivered code) when that roll-up is the largest signal. A single
 *     combined total, so it renders at plain foreground weight (no green `.add` —
 *     that means "added" everywhere else and this number is added+removed), with a
 *     quiet "in PRs" qualifier so the roll-up case is distinguishable from the
 *     working-tree diff.
 *
 * Reuses the shipped `.sd3-out-diff` tokens; no new palette. Extracted to a
 * sibling so the grandfathered `agent-session-detail-view.tsx` does not grow.
 */
export function SessionOutputDiff({
  session,
}: Readonly<{
  session: Pick<
    AgentSessionDetail,
    "linesAdded" | "linesRemoved" | "authoredPrLinesChanged" | "branchDiffStats"
  >;
}>) {
  const display = sessionOutputDiffDisplay(session);
  if (display.kind === "branch-diff") {
    // ISS-4448: the branch-level diff is a real +added / -removed split (unlike
    // the authored-PR roll-up's single combined total), so it keeps the honest
    // per-side green/red coloring. The "branch total" qualifier says plainly what
    // this scope is: the whole branch's diff, which can span several sessions —
    // not the tiny local working-tree residual that survives after merge.
    return (
      <span className="sd3-out-diff">
        <b className="add">+{display.linesAdded.toLocaleString()}</b>
        <b className="del">-{display.linesRemoved.toLocaleString()}</b>
        <span className="sd3-out-label">branch total</span>
      </span>
    );
  }
  if (display.kind === "authored-pr") {
    // A single combined lines-changed total, not a green-add / red-del split: the
    // authored-PR roll-up carries only `additions + deletions` per PR (the LOC/$
    // basis), so there is no honest per-side breakdown to color. Plain foreground
    // weight — the green add color would mis-teach an added+removed total as
    // "added". The "in PRs" qualifier tells the reader this is the PRs' delivered
    // code, not the session's local working-tree diff.
    return (
      <span className="sd3-out-diff">
        <b className="total">{display.linesChanged.toLocaleString()}</b>
        <span className="sd3-out-label">in PRs</span>
      </span>
    );
  }
  // The session's own authored diff. With three shapes, an unlabeled case would
  // make "no qualifier" itself a hidden signal nobody learns; label all three so
  // the reader always knows which scope this number measures. "in session" rather
  // than "working tree": ISS-5402 folds a delegated sub-agent's authored lines
  // into these scalars, so this counts everything the session wrote — the working
  // tree is not the scope, and a row that names the wrong scope is a lying row.
  return (
    <span className="sd3-out-diff">
      <b className="add">+{display.linesAdded.toLocaleString()}</b>
      <b className="del">-{display.linesRemoved.toLocaleString()}</b>
      <span className="sd3-out-label">in session</span>
    </span>
  );
}
