import type { BranchRow, SelectedPullRequest } from "./mock";

/**
 * Builds the prototype's atomic selected-PR projection when a scenario opts
 * into selected-PR behavior. `undefined` means no selected projection, while
 * `null` remains an explicit selected body that may use the compatibility body.
 */
export function buildSelectedPullRequest(
  row: BranchRow,
  selectedBody: string | null | undefined
): SelectedPullRequest | null {
  if (row.prNumber == null || selectedBody === undefined) {
    return null;
  }
  return {
    number: row.prNumber,
    title: row.prTitle,
    url: row.prUrl,
    state: row.prState,
    body: selectedBody,
  };
}
