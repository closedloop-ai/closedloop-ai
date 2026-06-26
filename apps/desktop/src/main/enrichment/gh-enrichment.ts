import { gitExec } from "./git-exec.js";
import {
  type EnrichmentResult,
  EnrichmentSource,
  EnrichmentState,
  type PrMetadata,
  PrState,
} from "./types.js";

let ghAvailable: boolean | null = null;
let ghAvailableCheckedAt = 0;
const GH_CHECK_INTERVAL_MS = 30 * 60 * 1000;

// owner/repo, each segment limited to GitHub's allowed characters. Non-GitHub
// remotes (GitLab groups with nested subgroups, Bitbucket, bare hostnames) fail
// this and must never be handed to `gh`, which only speaks to github.com.
const GITHUB_REPO_FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

export function isGitHubRepoFullName(
  repoFullName: string | null | undefined
): repoFullName is string {
  return (
    typeof repoFullName === "string" &&
    GITHUB_REPO_FULL_NAME_RE.test(repoFullName)
  );
}

export async function isGhAvailable(ghPath: string): Promise<boolean> {
  const now = Date.now();
  if (
    ghAvailable !== null &&
    now - ghAvailableCheckedAt < GH_CHECK_INTERVAL_MS
  ) {
    return ghAvailable;
  }
  try {
    const { exitCode } = await gitExec(ghPath, ["auth", "status"], ".", 10_000);
    ghAvailable = exitCode === 0;
  } catch {
    // gitExec rethrows when the binary cannot be spawned (ghPath unresolved or
    // not on disk). Treat that as "gh unavailable" rather than failing the sweep.
    ghAvailable = false;
  }
  ghAvailableCheckedAt = now;
  return ghAvailable;
}

export function resetGhCache(): void {
  ghAvailable = null;
  ghAvailableCheckedAt = 0;
}

export async function ghGetPrMetadata(
  ghPath: string,
  repoFullName: string,
  prNumber: number
): Promise<PrMetadata | null> {
  const { stdout, exitCode } = await gitExec(
    ghPath,
    [
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repoFullName,
      "--json",
      "state,additions,deletions,changedFiles,mergeCommit,baseRefName,headRefName,createdAt,mergedAt,closedAt",
    ],
    ".",
    30_000
  );
  if (exitCode !== 0) {
    return null;
  }

  try {
    const data = JSON.parse(stdout);
    return {
      prState: mapGhState(data.state),
      additions: data.additions ?? 0,
      deletions: data.deletions ?? 0,
      changedFiles: data.changedFiles ?? 0,
      mergeCommitSha: data.mergeCommit?.oid ?? null,
      baseRefName: data.baseRefName ?? null,
      headRefName: data.headRefName ?? null,
      // PRD-486: the GitHub PR open time, for the rail's PR-opened lifecycle dot.
      openedAt: parseGhTimestamp(data.createdAt),
      // AUTHORITATIVE merge/close instants from GitHub. Absent for an open (or
      // closed-not-merged) PR — `parseGhTimestamp` keeps those null so the
      // branch "last active" never gets back-dated to enrichment wall-clock time.
      mergedAt: parseGhTimestamp(data.mergedAt),
      closedAt: parseGhTimestamp(data.closedAt),
    };
  } catch {
    return null;
  }
}

// `gh ... --json mergedAt,closedAt` reports unset timestamp fields as either
// JSON null or the Go zero time (`0001-01-01T00:00:00Z`). Both, plus any
// non-string/empty value, mean "GitHub has no real instant here" — return null
// so we never persist a bogus timestamp as genuine lifecycle activity.
const GH_ZERO_TIME = "0001-01-01T00:00:00Z";
function parseGhTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value === GH_ZERO_TIME) {
    return null;
  }
  return value;
}

export async function ghGetCommitStats(
  ghPath: string,
  repoFullName: string,
  sha: string
): Promise<EnrichmentResult | null> {
  const { stdout, exitCode } = await gitExec(
    ghPath,
    [
      "api",
      `repos/${repoFullName}/commits/${sha}`,
      "--jq",
      "{additions: .stats.additions, deletions: .stats.deletions, files: (.files | length)}",
    ],
    ".",
    30_000
  );
  if (exitCode !== 0) {
    return null;
  }

  try {
    const data = JSON.parse(stdout);
    if (typeof data.additions !== "number") {
      return null;
    }
    return {
      stats: {
        linesAdded: data.additions,
        linesRemoved: data.deletions,
        filesChanged: typeof data.files === "number" ? data.files : 0,
      },
      state: EnrichmentState.Final,
      source: EnrichmentSource.GhApi,
    };
  } catch {
    return null;
  }
}

export async function ghListPrForBranch(
  ghPath: string,
  repoFullName: string,
  branchName: string
): Promise<
  | {
      prNumber: number;
      state: PrState;
      additions: number;
      deletions: number;
    }[]
  | null
> {
  const { stdout, exitCode } = await gitExec(
    ghPath,
    [
      "pr",
      "list",
      "--repo",
      repoFullName,
      "--head",
      branchName,
      "--state",
      "all",
      "--json",
      "number,state,additions,deletions",
    ],
    ".",
    30_000
  );
  if (exitCode !== 0) {
    return null;
  }

  try {
    const data = JSON.parse(stdout);
    if (!Array.isArray(data)) {
      return null;
    }
    return data.map(
      (pr: {
        number: number;
        state: string;
        additions: number;
        deletions: number;
      }) => ({
        prNumber: pr.number,
        state: mapGhState(pr.state),
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
      })
    );
  } catch {
    return null;
  }
}

function mapGhState(state: string): PrState {
  const s = state.toUpperCase();
  if (s === "MERGED") {
    return PrState.Merged;
  }
  if (s === "CLOSED") {
    return PrState.Closed;
  }
  return PrState.Open;
}
