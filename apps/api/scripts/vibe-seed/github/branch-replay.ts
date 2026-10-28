import type { VibeSeedContext } from "../stage";
import { replayBranchEvidence } from "./branch-evidence";
import { assignBranchOwner } from "./branch-owner";
import { branchWorkFor, readGoldenGitHubCorpus } from "./corpus";
import { replayPullRequestReviews } from "./pr-reviews";
import { replayReviewConversation } from "./review-comments";
import { readSeededBranches } from "./seeded-branches";
import type { GitHubPerson } from "./store-work";

/**
 * ISS-12017: replay the GitHub side of every branch a golden session pushed —
 * pushes, commits, file changes, checks, pull request lifecycle, and review
 * conversation — through the webhook producers, once the session-links stage
 * has materialized the branches.
 */
export async function replayGoldenBranches(
  context: VibeSeedContext
): Promise<void> {
  const corpus = readGoldenGitHubCorpus(context);
  const cast = castOf([...corpus.work.values()].map((work) => work.author));
  let replayed = 0;
  for (const branch of await readSeededBranches(context)) {
    const work = branchWorkFor(
      corpus,
      branch.repositoryFullName,
      branch.branchName
    );
    if (work === undefined) {
      continue;
    }
    await replayBranchEvidence(context, branch, work);
    await replayReviewConversation(context, branch, work, cast);
    await replayPullRequestReviews(context, branch, work);
    await assignBranchOwner(context, branch, work.author.login);
    replayed += 1;
  }
  if (replayed === 0) {
    throw new Error(
      "no seeded branch matched a golden branch; run the github-session-links stage first"
    );
  }
  context.log(`replayed GitHub evidence for ${replayed} golden branch(es)`);
}

function castOf(people: readonly GitHubPerson[]): GitHubPerson[] {
  const byLogin = new Map(people.map((person) => [person.login, person]));
  return [...byLogin.values()].sort((a, b) => a.login.localeCompare(b.login));
}
