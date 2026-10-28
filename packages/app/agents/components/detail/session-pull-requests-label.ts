/**
 * ISS-4769: what the session-detail "Pull requests" row says when it has no PR
 * to show. The canonical string — the row imports it rather than re-declaring
 * the copy at the call site.
 *
 * The Properties-panel facts are assembled by INDEPENDENT lanes with mismatched
 * predicates: the PR lane counts only the PRs a session AUTHORED
 * (`resolveAuthoredPrLinkIdentity` — referenced/reviewed excluded, and ISS-4768
 * extends that to the desktop-reported legacy blob), while the LOC lane
 * (`sessionOutputDiffDisplay`) resolves the session's own authored diff or
 * the branch-level diff and Linked artifacts resolves slug links — neither of which
 * requires an authored PR. So a session that committed code and referenced
 * artifacts, but whose PR links all resolved to Referenced/Reviewed, renders a
 * non-zero "Lines changed" beside "Pull requests: None", and the two read as a
 * contradiction: "None" is taken to mean nothing was delivered.
 *
 * The fix is one word in the row that is actually ambiguous (design review). The
 * empty PR row does not mean "no PRs touched this session" — it means "no PRs
 * this session AUTHORED", which is exactly what the lane computes. Naming that
 * makes the two facts reconcile without either row growing a clause, and it
 * un-learns the wrong read at the place the reader forms it rather than three
 * rows below.
 *
 * Deliberately NOT a provenance claim about the LOC figure. An empty list is a
 * statement about this row's own contents; it is not evidence the change came
 * from no PR, and the detail payload carries nothing that could establish that —
 * `mergedAuthoredPrLinesChanged` is zeroed by the SAME `headBranch === null` condition
 * that suppresses the PRs (`projections.ts`), so it cannot distinguish "authored
 * none" from "authored one that FEA-4188 suppressed". Rather than assert an
 * attribution we cannot support, the row narrows its own claim and the "Lines
 * changed" row keeps its untouched scope label.
 */
export const SESSION_EMPTY_PULL_REQUESTS_LABEL = "None authored" as const;
