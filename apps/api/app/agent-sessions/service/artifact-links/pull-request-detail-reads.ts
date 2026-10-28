/** The existing PullRequestDetail columns the desktop upsert inspects. */
export type ExistingDesktopPrRow = {
  number: number;
  id: string;
  branchArtifactId: string;
  fetchMechanism: string | null;
  fetchObservedAt: Date | null;
  githubId: string | null;
  repositoryId: string | null;
  repositoryFullName: string | null;
  title: string | null;
  htmlUrl: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  baseRefName: string | null;
};

export function findDesktopPrRow(
  rows: readonly ExistingDesktopPrRow[],
  identity: {
    repositoryId: string | null;
    repositoryFullName: string;
    number: number;
  }
): ExistingDesktopPrRow | null {
  if (identity.repositoryId) {
    const exact = rows.find(
      (row) =>
        row.repositoryId === identity.repositoryId &&
        row.number === identity.number
    );
    if (exact) {
      return exact;
    }
  }
  return (
    rows.find(
      (row) =>
        row.repositoryFullName === identity.repositoryFullName &&
        row.number === identity.number &&
        (!identity.repositoryId || row.repositoryId === null)
    ) ?? null
  );
}
