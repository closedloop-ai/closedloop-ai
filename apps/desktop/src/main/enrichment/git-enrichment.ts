import {
  catFileType,
  gitDiffShortstat,
  gitDiffThreeDotShortstat,
  gitShowShortstat,
  isAncestor,
} from "./git-exec.js";
import {
  type EnrichmentResult,
  EnrichmentSource,
  EnrichmentState,
  type LocStats,
} from "./types.js";

export async function enrichCommitViaGit(
  gitPath: string,
  cwd: string,
  sha: string
): Promise<EnrichmentResult | null> {
  const objType = await catFileType(gitPath, cwd, sha);
  if (objType === null) {
    return null;
  }
  if (objType !== "commit") {
    return {
      stats: null,
      state: EnrichmentState.NotApplicable,
      source: EnrichmentSource.GitShow,
    };
  }

  const stats = await gitShowShortstat(gitPath, cwd, sha);
  if (!stats) {
    return null;
  }
  return {
    stats,
    state: EnrichmentState.Final,
    source: EnrichmentSource.GitShow,
  };
}

export async function enrichBranchViaGit(
  gitPath: string,
  cwd: string,
  branchName: string,
  defaultBranch: string
): Promise<EnrichmentResult | null> {
  const baseRef = `origin/${defaultBranch}`;
  const tipRef = branchName;

  const isMerged = await isAncestor(gitPath, cwd, tipRef, baseRef);
  if (isMerged) {
    return null;
  }

  const stats = await gitDiffThreeDotShortstat(gitPath, cwd, baseRef, tipRef);
  if (!stats) {
    return null;
  }
  return {
    stats,
    state: EnrichmentState.Provisional,
    source: EnrichmentSource.GitDiff,
  };
}

export async function enrichMergeCommitForBranch(
  gitPath: string,
  cwd: string,
  mergeCommitSha: string
): Promise<EnrichmentResult | null> {
  const objType = await catFileType(gitPath, cwd, mergeCommitSha);
  if (objType !== "commit") {
    return null;
  }

  const stats = await gitDiffShortstat(
    gitPath,
    cwd,
    `${mergeCommitSha}^1`,
    mergeCommitSha
  );
  if (!stats) {
    return null;
  }
  return {
    stats,
    state: EnrichmentState.Final,
    source: EnrichmentSource.GitDiff,
  };
}

export function enrichSquashCommit(
  gitPath: string,
  cwd: string,
  squashSha: string
): Promise<EnrichmentResult | null> {
  return enrichCommitViaGit(gitPath, cwd, squashSha);
}

export function sumCommitStats(stats: Array<LocStats | null>): LocStats | null {
  const valid = stats.filter((s): s is LocStats => s !== null);
  if (valid.length === 0) {
    return null;
  }
  return {
    linesAdded: valid.reduce((sum, s) => sum + s.linesAdded, 0),
    linesRemoved: valid.reduce((sum, s) => sum + s.linesRemoved, 0),
    filesChanged: valid.reduce((sum, s) => sum + s.filesChanged, 0),
  };
}
