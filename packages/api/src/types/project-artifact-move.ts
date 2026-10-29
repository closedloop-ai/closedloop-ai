// Stack-rank move request shape for POST /projects/:id/artifacts/move
// (PRD-421 / PLN-755). Shared between apps/api (Zod validator + service) and
// apps/app (React Query mutation hook).

export const MovePosition = {
  Top: "top",
  Bottom: "bottom",
  Before: "before",
  After: "after",
} as const;
export type MovePosition = (typeof MovePosition)[keyof typeof MovePosition];

/**
 * Request body for moving a single artifact within its project's stack rank.
 *
 * - `Top` / `Bottom`: move to the first / last position in the project.
 * - `Before` / `After`: require `referenceArtifactId` and place the moved
 *   artifact immediately before / after that reference.
 *
 * `referenceArtifactId` is meaningless (and must be omitted) for `Top` and
 * `Bottom`. The server-side validator enforces this with a discriminated
 * union.
 */
export type MoveArtifactRequest = {
  artifactId: string;
  position: MovePosition;
  /** Required iff `position` is `Before` or `After`. */
  referenceArtifactId?: string;
  /**
   * ISS-8728 — the caller's belief about the project's current root ordering,
   * checked against what the move transaction actually sees before it writes.
   *
   * OPTIONAL, and omission keeps the long-standing last-write-wins behavior, so
   * every existing caller (drag-drop, keyboard move, row menu, MCP agents, an
   * older deployed bundle) is unaffected. A caller that supplies it is asking
   * the server to refuse rather than silently overwrite a reorder that landed
   * after the caller's read: a mismatch is a {@link MOVE_ARTIFACT_CONFLICT}
   * 409, never a partial write.
   *
   * The full root ordering, in the order the caller believes it to be, by
   * artifact UUID. It is an echo of a prior server read rather than something a
   * human types, so it is UUIDs only — a slug arm would cost one lookup per
   * entry inside the transaction that is holding the write.
   */
  expectedOrder?: string[];
};

/**
 * Upper bound on {@link MoveArtifactRequest.expectedOrder}, shared so the
 * validator and its tests cannot disagree about the cap.
 *
 * The precondition describes a whole project's root ordering, and the same
 * bound the batch mutations put on a set of documents applies for the same
 * reason: an unbounded array is an unbounded parse and an unbounded comparison
 * inside a transaction that holds a write lock.
 */
export const MOVE_ARTIFACT_EXPECTED_ORDER_LIMIT = 500;

/**
 * The error message prefix a stale-precondition refusal carries, so the client
 * that sent the precondition can tell a 409 it caused from any other conflict
 * without parsing prose.
 */
export const MOVE_ARTIFACT_CONFLICT =
  "Project ordering changed since it was read" as const;

/** Response shape for the move route. `newSortOrder` is the post-move value. */
export type MoveArtifactResponse = {
  moved: true;
  newSortOrder: number;
};
