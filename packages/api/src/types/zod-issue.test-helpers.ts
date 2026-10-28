/**
 * Locates the issue a Zod rejection raised for one exact field path, so a test
 * can assert WHICH rule rejected rather than only that something did.
 *
 * Returns the FIRST issue at that path. Zod collects every failing check, so a
 * value that breaks more than one rule at the same path (a too-short slug that
 * is also reserved) yields several — assert over `error.issues` directly when
 * the distinction between them is the point.
 */
export function findIssue(
  issues: { path: PropertyKey[]; message: string; code: string }[],
  path: PropertyKey[]
) {
  return issues.find(
    (issue) => JSON.stringify(issue.path) === JSON.stringify(path)
  );
}
