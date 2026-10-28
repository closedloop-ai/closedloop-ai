import {
  normalizeRepoFullName,
  parseRepositoryFullName,
} from "@repo/api/src/types/branch-repository";
import { z } from "zod";

/**
 * The one entry validation for a selected-pull-request read: bound the caller's
 * `owner`/`repo`/`pullNumber`, fold them into a normalized `owner/repo`, and
 * re-derive the two segments FROM that normalized name so the identity the read
 * reports is the identity it queried with.
 *
 * The files half and the checks half of the same pull request each carried
 * their own copy of this, and the copies had already drifted: only the checks
 * copy refused a segment containing `/`. That refusal is not decoration.
 * `normalizeRepoFullName` strips leading AND trailing slashes, so without it
 * `owner="/acme", repo="widgets"` and `owner="acme", repo="widgets/"` both fold
 * to `acme/widgets` and the read answers about a repository the caller did not
 * name — accepted by one half and rejected by the other, for one PR. Those two
 * placements are the whole of what this guard decides: any other slash
 * over-segments the folded name, which `parseRepositoryFullName` refuses below
 * regardless. Adopting the stricter copy is the point of merging them; it is a
 * narrowing, and it is deliberate.
 *
 * Unreachable from today's callers, which is why the drift went unnoticed: both
 * halves are called only from `apps/api/app/branches`, which passes
 * `parseRepositoryFullName` output that cannot contain a slash. The guard is
 * defence in depth for the next caller, and it now applies to both halves or
 * neither.
 */
export function normalizeSelectedPullRequestInput(
  owner: string,
  repo: string,
  pullNumber: number
): NormalizedSelectedPullRequestInput | null {
  const parsed = selectedPullRequestInputSchema.safeParse({
    owner,
    repo,
    pullNumber,
  });
  if (!parsed.success) {
    return null;
  }
  const repositoryFullName = normalizeRepoFullName(
    `${parsed.data.owner}/${parsed.data.repo}`
  );
  const identity = parseRepositoryFullName(repositoryFullName);
  if (!identity) {
    return null;
  }
  return {
    owner: identity.owner,
    repo: identity.repo,
    pullNumber: parsed.data.pullNumber,
    repositoryFullName,
  };
}

function isRepositoryComponent(value: string): boolean {
  return !value.includes("/");
}

const selectedPullRequestInputSchema = z.object({
  owner: z.string().trim().min(1).refine(isRepositoryComponent),
  repo: z.string().trim().min(1).refine(isRepositoryComponent),
  pullNumber: z.number().int().positive(),
});

export type NormalizedSelectedPullRequestInput = {
  owner: string;
  repo: string;
  pullNumber: number;
  repositoryFullName: string;
};
