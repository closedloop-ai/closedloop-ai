/**
 * Which field a mixed artifact table groups its rows into sections by.
 *
 * Shared because `apps/api` cannot import `@repo/app` (ISS-10472): the assigned
 * tree packs its root groups into pages server-side, so the wire carries the
 * mode. The client's `GroupByMode` aliases this rather than declaring its own,
 * so a mode the browser can select is a mode the query can honor.
 */
export const ArtifactGroupByMode = {
  None: "none",
  Status: "status",
  Assignee: "assignee",
  Priority: "priority",
} as const;
export type ArtifactGroupByMode =
  (typeof ArtifactGroupByMode)[keyof typeof ArtifactGroupByMode];

/**
 * The section ordering a grouped read was built with, named on the response.
 *
 * Three whole shapes, selected by two PostHog keys the SERVER resolves
 * (`ARTIFACT_STATUS_ROOT_ORDER`, then `universal-artifact-status`). They differ
 * on what keys a status section and how sections order:
 *
 * - `vocabulary` — key is the status COERCED to its lifecycle vocabulary
 *   (`parseStatusForSubtype`), so an off-vocabulary row sections under the
 *   lifecycle fallback; order is `coerced` `statusDisplayRank`.
 * - `rootFirst` — key is the RAW `status`; order is the folded root band first
 *   (the LOWEST root in the section), raw `statusDisplayRank` as the tiebreak,
 *   then the key by code unit.
 * - `retained` — key is the RAW `status`; order is raw `statusDisplayRank`.
 *
 * The coerced/raw split is what `sectionValueSql` applies and what the
 * universal-status work changes; getting it backwards here is how a reader
 * concludes an off-vocabulary status sections under its own spelling.
 *
 * Named on the response rather than requested, because a client that asked for
 * an ordering would get rows ordered by something other than what the server
 * evaluated — the request-contract change ISS-9437 declined for Branches
 * (`apps/api/app/branches/branch-status-ordering.ts`). Only `status` grouping
 * reads it; priority and assignee sections have one order each.
 */
export const ArtifactSectionOrdering = {
  Vocabulary: "vocabulary",
  RootFirst: "root_first",
  Retained: "retained",
} as const;
export type ArtifactSectionOrdering =
  (typeof ArtifactSectionOrdering)[keyof typeof ArtifactSectionOrdering];
