import type { VibeSeedContext } from "../stage";
import { SEEDED_REPOSITORIES } from "./repositories";
import { readStoreLinks, type StoreLink } from "./store-links";
import type { PullRequestFacts, PullRequestFactsLookup } from "./store-refs";
import { type BranchWork, branchWorkKey, readBranchWork } from "./store-work";

/**
 * ISS-12017: the golden store's GitHub-side story, read once per stage: every
 * resolvable branch, pull request, and commit link, and the work each pushed
 * branch carries. Deterministic for a given store and `now`, so the stages
 * that read it separately agree.
 */
export type GoldenGitHubCorpus = {
  readonly storePath: string;
  readonly links: readonly StoreLink[];
  readonly work: ReadonlyMap<string, BranchWork>;
};

export function readGoldenGitHubCorpus(
  context: Pick<VibeSeedContext, "desktopStorePath" | "corpusShiftMs" | "now">
): GoldenGitHubCorpus {
  const storePath = context.desktopStorePath;
  if (storePath === null) {
    throw new Error(
      "the GitHub stages need the golden Desktop store; the run was started without one"
    );
  }
  const shift = {
    shiftMs: context.corpusShiftMs,
    nowMs: context.now.getTime(),
  };
  const links = readStoreLinks(storePath, SEEDED_REPOSITORIES, shift);
  return { storePath, links, work: readBranchWork(storePath, links, shift) };
}

/** The work recorded for one branch, by repository and branch name. */
export function branchWorkFor(
  corpus: GoldenGitHubCorpus,
  repositoryFullName: string,
  branchName: string
): BranchWork | undefined {
  return corpus.work.get(branchWorkKey(repositoryFullName, branchName));
}

/** The derived facts of every pull request a golden session opened. */
export function pullRequestFactsLookup(
  corpus: GoldenGitHubCorpus
): PullRequestFactsLookup {
  const byPullRequest = new Map<string, PullRequestFacts>();
  for (const work of corpus.work.values()) {
    for (const pullRequest of work.pullRequests) {
      byPullRequest.set(
        `${work.repositoryFullName.toLowerCase()}#${pullRequest.number}`,
        pullRequest.facts
      );
    }
  }
  return (repositoryFullName, prNumber) =>
    byPullRequest.get(`${repositoryFullName.toLowerCase()}#${prNumber}`);
}
