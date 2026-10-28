/**
 * ISS-8522 (ISS-8261 phase 3) — ROW-LEVEL provider authority: whether one
 * PullRequestDetail row was produced or verified by a GitHub-App producer,
 * answered from that row's own columns.
 *
 * Webhook-wins used to be answerable only on a WRITE, by asking where
 * `promoteBranchCurrentPullRequest` had left the branch pointer. Expressed as a
 * function of a single row it can be answered at read/derive time instead, so a
 * reader no longer has to trust that the pointer was maintained.
 *
 * WHICH COLUMN, AND WHY (ISS-8462 / PR #6214). `githubId` is the durable term:
 * only an App/webhook producer ever writes a value into it, no path clears it,
 * and the desktop upsert writes it exactly once — as `null`, on its own insert.
 * `fetchMechanism` and `fetchCredentialType` are NOT durable; every successful
 * reconcile rewrites them, which is the precise defect ISS-8462 fixed by adding
 * a separate `desktopOriginated` column rather than keying on `fetch_mechanism`.
 *
 * The mechanism arm is kept on purpose and is the one non-durable term. A
 * provider row that has no `githubId` yet — the factless stub ISS-8423 owns —
 * is authoritative today, so dropping the arm would NARROW authority, silently
 * changing which writer wins. Keeping it is safe because the arm can only ever
 * be rewritten to another App mechanism: the sole non-App producer is the
 * desktop upsert, and its own webhook-wins gate is this predicate, so it never
 * writes provenance to a row this returns true for.
 *
 * `desktopOriginated` is deliberately NOT the signal. It answers the inverse
 * question (did the DESKTOP originate this row) that ISS-8462 needed for the
 * tier-2 reconcile selector, and its `false` default is carried by every
 * provider row and every empty stub alike — so negating it would call a
 * factless stub provider-authoritative.
 */

import { isGitHubAppFetchMechanism } from "@/lib/github-fetch-provenance";

/** The columns provider authority is decided from. No pointer field: ISS-8522. */
export type PullRequestProviderAuthorityRow = {
  fetchMechanism: string | null;
  githubId: string | null;
};

/**
 * True when a GitHub-App producer owns this row — the webhook-wins subject.
 * A desktop write may gap-fill such a row but never overwrite its facts.
 *
 * Authority is NOT a floor on which row a derivation may return. ISS-8522's
 * operator ruling made canonical selection eligibility-first, so a factless
 * provider stub loses to a live fact-carrying sibling whatever wrote it, and
 * this predicate only breaks ties WITHIN one suitability tier
 * (`branch-canonical-pull-request.ts`). The write-side gate in
 * `promoteBranchCurrentPullRequest` is the unconditional one.
 */
export function isProviderAuthoritativePullRequest(
  row: PullRequestProviderAuthorityRow | null | undefined
): boolean {
  if (!row) {
    return false;
  }
  return row.githubId != null || isGitHubAppFetchMechanism(row.fetchMechanism);
}
