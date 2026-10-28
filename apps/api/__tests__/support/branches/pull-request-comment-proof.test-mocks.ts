const PROOF_READ_MARKER = "AS scoped(branch_id)";

/**
 * The Branch DB mock's answer to `readPullRequestCommentProof`, or `undefined`
 * when `sql` is some other statement. The unit fixtures seed no
 * `pull_request_comment_acquisitions` rows, so every requested Branch reads
 * incomplete, which is what the shared predicate returns over an empty proof
 * table. The Complete direction is pinned against a real database in
 * `pull-request-comment-proof.integration.test.ts`.
 */
export function mockPullRequestCommentProofRows(
  sql: string,
  values: readonly unknown[]
): { branchId: string }[] | undefined {
  if (!sql.includes(PROOF_READ_MARKER)) {
    return;
  }
  const requested = values.find((value) => Array.isArray(value));
  if (!Array.isArray(requested)) {
    return [];
  }
  return requested
    .filter((branchId) => typeof branchId === "string")
    .map((branchId) => ({ branchId }));
}
