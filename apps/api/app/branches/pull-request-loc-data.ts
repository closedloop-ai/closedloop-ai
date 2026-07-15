/**
 * Optional PR LOC fields returned by GitHub provider paths.
 *
 * Undefined means the producer did not supply the field and existing persisted
 * values should be preserved. Null means the producer supplied an explicit
 * unknown/empty value and should be stored.
 */
export type PullRequestLocInput = {
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
};

/**
 * Builds an omission-preserving Prisma data fragment for PR LOC fields.
 */
export function pullRequestLocData(input: PullRequestLocInput) {
  return {
    ...(input.additions === undefined ? {} : { additions: input.additions }),
    ...(input.deletions === undefined ? {} : { deletions: input.deletions }),
    ...(input.changedFiles === undefined
      ? {}
      : { changedFiles: input.changedFiles }),
  };
}
