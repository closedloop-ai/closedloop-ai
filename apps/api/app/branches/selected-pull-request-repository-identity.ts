import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";

/**
 * Which repository a selected pull request's detail row belongs to.
 *
 * The four-source precedence is the contract, not an implementation detail.
 * The PR detail outranks the branch: a detail names its own repository, and the
 * branch's only stands in for a detail that names none. Within each level the
 * JOINED `repository.fullName` is the authority over the denormalized column on
 * the same row, because the column is a projection of that join and can lag it.
 *
 * Whichever source wins is normalized before it is returned, so every lane that
 * builds an identity key from this compares byte-identical strings. Absence is
 * reported as `null` rather than as an empty key — but `??` treats an empty
 * string as PRESENT, so an empty higher-precedence value ends the chain and
 * yields `null` instead of falling through to the source below it.
 */
export function selectedPullRequestRepositoryFullName(
  row: SelectedPullRequestRepositoryRow,
  detail: SelectedPullRequestRepositoryFields
): string | null {
  const fullName =
    detail.repository?.fullName ??
    detail.repositoryFullName ??
    row.branch?.repository?.fullName ??
    row.branch?.repositoryFullName;
  return fullName ? normalizeRepoFullName(fullName) : null;
}

type SelectedPullRequestRepositoryFields = {
  repositoryFullName?: string | null;
  repository?: { fullName: string } | null;
};

type SelectedPullRequestRepositoryRow = {
  branch: SelectedPullRequestRepositoryFields | null;
};
