"use client";

import type { SessionPR } from "@repo/api/src/types/agent-session";
import { SESSION_EMPTY_PULL_REQUESTS_LABEL } from "./detail-content";
import { PullRequestPill } from "./session-pull-request-pill";

/**
 * The session-detail Properties-pane "Pull requests" row, extracted out of the
 * grandfathered `agent-session-detail-view.tsx` (shrink-only per the file-size
 * rules) as a sibling of `session-linked-artifacts-row.tsx` and
 * `session-output-diff.tsx`.
 *
 * ISS-4769: this row is where the contradiction actually lives. The row lists
 * only the PRs the session AUTHORED — referenced and reviewed links are filtered
 * out upstream by `resolveAuthoredPrLinkIdentity`, and ISS-4768 extends the same
 * rule to the desktop-reported legacy blob — but its empty state said the
 * unqualified "None", which a reader takes to mean "nothing was delivered". Beside
 * a real "Lines changed" figure (the working-tree or branch diff, neither of which
 * needs a PR) the two facts read as a contradiction.
 *
 * The fix is one word, here, in the row that is ambiguous: "None authored". It
 * names what the lane actually computed, so the two rows reconcile without either
 * one growing a clause, and it corrects the read at the place the reader forms it
 * rather than in a caption further down the pane. The "Lines changed" row is
 * deliberately untouched — see {@link SESSION_EMPTY_PULL_REQUESTS_LABEL} for why
 * an empty list is not evidence about where the LOC came from.
 *
 * ISS-5366: the copy shipped unconditionally when the `session-loc-pr-attribution`
 * flag retired to its enabled state. The string stays in the canonical
 * `detail-content` module and is imported here rather than re-declared at the
 * call site, so the row and anything else naming the empty state cannot drift.
 */
export function SessionPullRequestsRow({
  prs,
  repositoryFullName,
}: Readonly<{
  prs: readonly SessionPR[];
  repositoryFullName: string | null;
}>) {
  return (
    <div className="prd-prop">
      <span className="prd-prop-label">Pull requests</span>
      {/* Not a button: the pills carry their own affordances, so the value cell
          is inert and must not present a pointer cursor. */}
      <div
        className="prd-prop-value sd3-prs-value"
        style={{ cursor: "default" }}
      >
        {prs.length === 0 ? (
          <span>{SESSION_EMPTY_PULL_REQUESTS_LABEL}</span>
        ) : (
          prs.map((pr) => (
            <PullRequestPill
              key={pr.num}
              pr={pr}
              repositoryFullName={repositoryFullName}
            />
          ))
        )}
      </div>
    </div>
  );
}
