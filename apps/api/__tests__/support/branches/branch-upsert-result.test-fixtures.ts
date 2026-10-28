import type { PullRequestArtifactLinkResult } from "@repo/api/src/types/pull-request-artifact-link";

/**
 * The success value `branchService.upsertBranchArtifact` resolves to.
 *
 * ISS-10169 added two OBSERVED fields beside the row it reads back: whether
 * this call created the branch, and the PRODUCES edges it actually wrote. Every
 * case in the suite states the row it expects, and repeating both fields inline
 * at each one would say nothing about that case — these builders name the
 * create/update and linked/unlinked distinctions in the call itself, so a case
 * only spells out what it varies.
 *
 * Exposed as ONE object rather than five named exports because
 * `branch-service.test.ts` is on the shrink-only grandfather list: a five-name
 * import is six lines there, a single-name import is one, and the difference is
 * the whole line budget this change had to fit inside.
 */

/** The `artifact_links` row a `plan-1` source link resolves to in fixtures. */
const LINK_ROW = { id: "produces-link-1" };

/** The edge a `sourceArtifactId: "plan-1"` input is expected to write. */
const PLAN_LINK: PullRequestArtifactLinkResult = {
  sourceArtifactId: "plan-1",
  linkId: LINK_ROW.id,
};

function value<T>(
  row: T,
  created: boolean,
  linkedArtifacts: PullRequestArtifactLinkResult[]
) {
  return { ok: true, value: { ...row, created, linkedArtifacts } };
}

export const branchUpsert = {
  /** What a mocked `artifactLink.upsert` must resolve for the read-back. */
  linkRow: LINK_ROW,
  /** A branch this call CREATED, with no source link requested. */
  created: <T>(row: T) => value(row, true, []),
  /** A branch this call RESOLVED and updated, with no source link requested. */
  updated: <T>(row: T) => value(row, false, []),
  /** A branch this call CREATED, having written the `plan-1` edge. */
  createdLinked: <T>(row: T) => value(row, true, [PLAN_LINK]),
  /** A branch this call RESOLVED, having written the `plan-1` edge. */
  updatedLinked: <T>(row: T) => value(row, false, [PLAN_LINK]),
};
