import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";

/**
 * Returns true if the artifact matches the filter term.
 * Checks title, text snippet, and workstream title independently (OR logic).
 * Per-field matching avoids false positives at field boundaries.
 *
 * @param artifact - The artifact to test.
 * @param term - The raw filter text entered by the user.
 */
export function matchesFilter(
  artifact: ArtifactWithWorkstream,
  term: string
): boolean {
  const q = term.toLowerCase().trim();
  if (!q) {
    return true;
  }
  return [
    artifact.title,
    artifact.snippet ?? "",
    artifact.workstream?.title ?? "",
  ].some((field) => field.toLowerCase().includes(q));
}
