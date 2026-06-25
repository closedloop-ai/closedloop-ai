import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";

/**
 * Returns true if the artifact matches the filter term.
 * Checks title and slug independently (OR logic).
 * Per-field matching avoids false positives at field boundaries.
 *
 * @param artifact - The artifact to test.
 * @param term - The raw filter text entered by the user.
 */
export function matchesFilter(
  artifact: DocumentRowData,
  term: string
): boolean {
  const q = term.toLowerCase().trim();
  if (!q) {
    return true;
  }
  return [artifact.title, artifact.slug].some((field) =>
    field.toLowerCase().includes(q)
  );
}
