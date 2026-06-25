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
};

/** Response shape for the move route. `newSortOrder` is the post-move value. */
export type MoveArtifactResponse = {
  moved: true;
  newSortOrder: number;
};
