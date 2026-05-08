import type { PrCommentAuthorKind } from "@repo/api/src/types/branch-view";

/**
 * Detect bot authors by GitHub's [bot] suffix convention.
 */
export function detectAuthorKind(login: string): PrCommentAuthorKind {
  return login.endsWith("[bot]") ? "bot" : "user";
}
