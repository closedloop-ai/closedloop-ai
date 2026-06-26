import { setTimeout as sleep } from "node:timers/promises";
import { artifactLinkId } from "../collectors/artifact-ref-extractor.js";
import type { DesktopPrisma } from "../database/prisma-client.js";
import { writePersistentLog } from "../persistent-log.js";
import {
  ghGetCommitStats,
  ghGetPrMetadata,
  ghListPrForBranch,
  isGhAvailable,
  isGitHubRepoFullName,
} from "./gh-enrichment.js";
import {
  enrichBranchViaGit,
  enrichCommitViaGit,
  enrichMergeCommitForBranch,
  enrichSquashCommit,
} from "./git-enrichment.js";
import {
  ArtifactKind,
  artifactIdFromIdentityKey,
  computeIdentityKey,
} from "./identity-key.js";
import {
  ENRICHMENT_SWEEP_DEBOUNCE_MS,
  type EnrichmentResult,
  EnrichmentSource,
  EnrichmentState,
  GH_RATE_LIMIT_INTERVAL_MS,
  LEASE_STALE_MS,
  MAX_ENRICHMENT_ATTEMPTS,
  type PrMetadata,
  PrState,
} from "./types.js";

type ArtifactRow = {
  id: string;
  identity_key: string;
  kind: string;
  repo_full_name: string | null;
  git_dir: string | null;
  sha: string | null;
  branch_name: string | null;
  pr_number: number | null;
  enrichment_state: string | null;
  enrichment_attempts: number;
  lease_at: string | null;
  pr_state: string | null;
  merge_commit_sha: string | null;
  base_ref: string | null;
};

// The exact columns the sweep read projects off the `artifact` delegate. Carries
// `lastSeenAt` (used only for the JS priority sort below, not by `ArtifactRow`).
const ARTIFACT_SWEEP_SELECT = {
  id: true,
  identityKey: true,
  kind: true,
  repoFullName: true,
  gitDir: true,
  sha: true,
  branchName: true,
  prNumber: true,
  enrichmentState: true,
  enrichmentAttempts: true,
  leaseAt: true,
  prState: true,
  mergeCommitSha: true,
  baseRef: true,
  lastSeenAt: true,
} as const;

type ArtifactSweepRow = {
  id: string;
  identityKey: string;
  kind: string;
  repoFullName: string | null;
  gitDir: string | null;
  sha: string | null;
  branchName: string | null;
  prNumber: number | null;
  enrichmentState: string | null;
  enrichmentAttempts: number;
  leaseAt: string | null;
  prState: string | null;
  mergeCommitSha: string | null;
  baseRef: string | null;
  lastSeenAt: string;
};

function toArtifactRow(row: ArtifactSweepRow): ArtifactRow {
  return {
    id: row.id,
    identity_key: row.identityKey,
    kind: row.kind,
    repo_full_name: row.repoFullName,
    git_dir: row.gitDir,
    sha: row.sha,
    branch_name: row.branchName,
    pr_number: row.prNumber,
    enrichment_state: row.enrichmentState,
    enrichment_attempts: row.enrichmentAttempts,
    lease_at: row.leaseAt,
    pr_state: row.prState,
    merge_commit_sha: row.mergeCommitSha,
    base_ref: row.baseRef,
  };
}

// The prior raw read ordered by two CASE expressions Prisma's `orderBy` cannot
// express (null enrichment_state first, then a present git_dir first), then
// `kind`, then `last_seen_at` DESC. This is a processing-priority tie-break over
// the SAME single read, so we reproduce it as a JS sort of the materialized set
// — no extra query, no per-row fan-out.
function compareSweepPriority(
  a: ArtifactSweepRow,
  b: ArtifactSweepRow
): number {
  const aState = a.enrichmentState === null ? 0 : 1;
  const bState = b.enrichmentState === null ? 0 : 1;
  if (aState !== bState) {
    return aState - bState;
  }
  const aGit = a.gitDir === null ? 1 : 0;
  const bGit = b.gitDir === null ? 1 : 0;
  if (aGit !== bGit) {
    return aGit - bGit;
  }
  if (a.kind !== b.kind) {
    return a.kind < b.kind ? -1 : 1;
  }
  if (a.lastSeenAt !== b.lastSeenAt) {
    return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
  }
  return 0;
}

const GIT_DIR_SUFFIX_RE = /\/.git$/;
const ENRICHMENT_ARTIFACT_PAUSE_MS = 25;

const NOT_ENRICHABLE: unique symbol = Symbol("not_enrichable");
type NotEnrichable = typeof NOT_ENRICHABLE;

let lastSweepAt = 0;
let sweepRunning = false;

export type EnrichmentSweepOptions = {
  debounce?: boolean;
  repoFullName?: string;
  cooperativeDelay?: (ms: number) => Promise<void>;
  shouldContinue?: () => boolean;
};

export function resetSweepState(): void {
  lastSweepAt = 0;
  sweepRunning = false;
}

export async function triggerEnrichmentSweep(
  prisma: DesktopPrisma,
  gitPath: string,
  ghPath: string,
  opts?: EnrichmentSweepOptions
): Promise<void> {
  if (sweepRunning) {
    return;
  }
  if (opts?.debounce !== false) {
    const now = Date.now();
    if (now - lastSweepAt < ENRICHMENT_SWEEP_DEBOUNCE_MS) {
      return;
    }
  }

  sweepRunning = true;
  try {
    await runSweep(prisma, gitPath, ghPath, opts ?? {});
  } finally {
    sweepRunning = false;
    lastSweepAt = Date.now();
  }
}

async function runSweep(
  prisma: DesktopPrisma,
  gitPath: string,
  ghPath: string,
  options: EnrichmentSweepOptions
): Promise<void> {
  const now = new Date().toISOString();
  const filterRepoFullName = options.repoFullName ?? null;
  const shouldContinue = options.shouldContinue ?? (() => true);

  // Eligible = null/provisional enrichment_state, never a closedloop_artifact,
  // optionally scoped to one repo. The CASE-priority ORDER BY is applied in JS
  // (see compareSweepPriority) since Prisma `orderBy` has no CASE form.
  const candidates = await prisma.client.artifact.findMany({
    where: {
      kind: { not: ArtifactKind.ClosedloopArtifact },
      OR: [
        { enrichmentState: null },
        { enrichmentState: EnrichmentState.Provisional },
      ],
      ...(filterRepoFullName ? { repoFullName: filterRepoFullName } : {}),
    },
    select: ARTIFACT_SWEEP_SELECT,
  });
  candidates.sort(compareSweepPriority);
  const artifacts = candidates.map(toArtifactRow);

  const ghReady = await isGhAvailable(ghPath);
  let ghCallCount = 0;
  const ghThrottle = async () => {
    ghCallCount++;
    if (ghCallCount % 10 === 0) {
      await sleep(GH_RATE_LIMIT_INTERVAL_MS);
    }
  };

  for (const art of artifacts) {
    if (!shouldContinue()) {
      return;
    }
    if (art.enrichment_attempts >= MAX_ENRICHMENT_ATTEMPTS) {
      await markNotApplicable(prisma, art.id, now);
      await pauseAfterArtifact(options);
      continue;
    }

    const leased = await tryAcquireLease(prisma, art.id, now);
    if (!leased) {
      await pauseAfterArtifact(options);
      continue;
    }

    try {
      const result = await enrichArtifact(
        prisma,
        art,
        gitPath,
        ghPath,
        ghReady,
        ghThrottle
      );
      if (result === NOT_ENRICHABLE) {
        await markNotApplicable(prisma, art.id, now);
      } else if (result) {
        await applyEnrichmentResult(prisma, art.id, result, now);
      } else {
        await incrementAttempts(prisma, art.id, now);
      }
    } catch {
      await incrementAttempts(prisma, art.id, now);
    } finally {
      await releaseLease(prisma, art.id);
    }
    await pauseAfterArtifact(options);
  }
}

function enrichArtifact(
  prisma: DesktopPrisma,
  art: ArtifactRow,
  gitPath: string,
  ghPath: string,
  ghReady: boolean,
  ghThrottle: () => Promise<void>
): Promise<EnrichmentResult | NotEnrichable | null> {
  const cwd = art.git_dir ? art.git_dir.replace(GIT_DIR_SUFFIX_RE, "") : null;

  if (!(cwd || (ghReady && isGitHubRepoFullName(art.repo_full_name)))) {
    writePersistentLog(
      "warn",
      "enrichment",
      `no enrichment path for ${art.kind} ${art.identity_key}: git_dir is null and gh is unavailable`
    );
  }

  switch (art.kind) {
    case ArtifactKind.Commit:
      return enrichCommit(art, gitPath, ghPath, ghReady, ghThrottle, cwd);
    case ArtifactKind.Branch:
      return enrichBranch(
        prisma,
        art,
        gitPath,
        ghPath,
        ghReady,
        ghThrottle,
        cwd
      );
    case ArtifactKind.PullRequest:
      return enrichPullRequest(
        prisma,
        art,
        gitPath,
        ghPath,
        ghReady,
        ghThrottle,
        cwd
      );
    default:
      return Promise.resolve(NOT_ENRICHABLE);
  }
}

async function enrichCommit(
  art: ArtifactRow,
  gitPath: string,
  ghPath: string,
  ghReady: boolean,
  ghThrottle: () => Promise<void>,
  cwd: string | null
): Promise<EnrichmentResult | NotEnrichable | null> {
  if (!art.sha) {
    return NOT_ENRICHABLE;
  }

  if (cwd) {
    const gitResult = await enrichCommitViaGit(gitPath, cwd, art.sha);
    if (gitResult) {
      return gitResult;
    }
  }

  if (ghReady && isGitHubRepoFullName(art.repo_full_name)) {
    await ghThrottle();
    return ghGetCommitStats(ghPath, art.repo_full_name, art.sha);
  }

  if (!(cwd || isGitHubRepoFullName(art.repo_full_name))) {
    return NOT_ENRICHABLE;
  }

  return null;
}

async function enrichBranch(
  prisma: DesktopPrisma,
  art: ArtifactRow,
  gitPath: string,
  ghPath: string,
  ghReady: boolean,
  ghThrottle: () => Promise<void>,
  cwd: string | null
): Promise<EnrichmentResult | NotEnrichable | null> {
  if (!art.branch_name) {
    return NOT_ENRICHABLE;
  }

  if (cwd) {
    // `git_dir` is non-null in practice here (cwd is derived from it). When it
    // is absent the prior `WHERE git_dir = NULL` matched nothing — i.e. the
    // "main" default — which the explicit guard reproduces.
    let defaultBranch = "main";
    if (art.git_dir) {
      const repoRow = await prisma.client.repo.findFirst({
        where: { gitDir: art.git_dir },
        select: { defaultBranch: true },
      });
      defaultBranch = repoRow?.defaultBranch ?? "main";
    }

    const gitResult = await enrichBranchViaGit(
      gitPath,
      cwd,
      art.branch_name,
      defaultBranch
    );
    if (gitResult) {
      return gitResult;
    }
  }

  if (ghReady && isGitHubRepoFullName(art.repo_full_name)) {
    await ghThrottle();
    const prs = await ghListPrForBranch(
      ghPath,
      art.repo_full_name,
      art.branch_name
    );
    if (prs && prs.length > 0) {
      const pr = prs[0]!;
      const isFinal =
        pr.state === PrState.Merged || pr.state === PrState.Closed;

      await linkBranchSessionsToPr(
        prisma,
        art,
        pr.prNumber,
        art.repo_full_name!
      );

      return {
        stats: {
          linesAdded: pr.additions,
          linesRemoved: pr.deletions,
          filesChanged: 0,
        },
        state: isFinal ? EnrichmentState.Final : EnrichmentState.Provisional,
        source: EnrichmentSource.GhPrList,
      };
    }
  }

  if (!(cwd || isGitHubRepoFullName(art.repo_full_name))) {
    return NOT_ENRICHABLE;
  }

  return null;
}

async function enrichPullRequest(
  prisma: DesktopPrisma,
  art: ArtifactRow,
  gitPath: string,
  ghPath: string,
  ghReady: boolean,
  ghThrottle: () => Promise<void>,
  cwd: string | null
): Promise<EnrichmentResult | NotEnrichable | null> {
  if (!(art.pr_number && art.repo_full_name)) {
    return NOT_ENRICHABLE;
  }

  if (
    !(isGitHubRepoFullName(art.repo_full_name) || (cwd && art.merge_commit_sha))
  ) {
    return NOT_ENRICHABLE;
  }

  if (ghReady && isGitHubRepoFullName(art.repo_full_name)) {
    await ghThrottle();
    const prMeta = await ghGetPrMetadata(
      ghPath,
      art.repo_full_name,
      art.pr_number
    );
    if (prMeta) {
      return enrichFromPrMeta(prisma, art, gitPath, cwd, prMeta);
    }
  }

  if (cwd && art.merge_commit_sha) {
    const mergeResult = await enrichMergeCommitForBranch(
      gitPath,
      cwd,
      art.merge_commit_sha
    );
    if (mergeResult) {
      return mergeResult;
    }
  }

  return null;
}

async function enrichFromPrMeta(
  prisma: DesktopPrisma,
  art: ArtifactRow,
  gitPath: string,
  cwd: string | null,
  prMeta: PrMetadata
): Promise<EnrichmentResult> {
  // RAW (named blocker: COALESCE-preserve write): branch_name must be set ONLY
  // when headRefName is non-null — Prisma's typed update has no COALESCE form.
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `UPDATE artifacts SET
         pr_state = $1, merge_commit_sha = $2, base_ref = $3,
         branch_name = COALESCE($4, branch_name)
       WHERE id = $5`,
      prMeta.prState,
      prMeta.mergeCommitSha,
      prMeta.baseRefName,
      prMeta.headRefName,
      art.id
    )
  );

  await syncPullRequestLifecycle(prisma, art, prMeta);

  if (prMeta.mergeCommitSha && cwd) {
    const mergeCommitResult = await enrichFromMergeCommit(
      gitPath,
      cwd,
      prMeta.mergeCommitSha
    );
    if (mergeCommitResult) {
      return mergeCommitResult;
    }
  }

  const isFinal =
    prMeta.prState === PrState.Merged || prMeta.prState === PrState.Closed;
  return {
    stats: {
      linesAdded: prMeta.additions,
      linesRemoved: prMeta.deletions,
      filesChanged: prMeta.changedFiles,
    },
    state: isFinal ? EnrichmentState.Final : EnrichmentState.Provisional,
    source: EnrichmentSource.GhPrView,
  };
}

/**
 * Mirror the PR lifecycle metadata onto `pull_requests`, the PR detail store
 * other consumers (FEA-1859/FEA-1869) read. Enrichment writes lifecycle onto
 * `artifacts`; without this the `pull_requests` row keeps the stale `state` it
 * had at capture time. Matched on (repo_full_name, pr_number); terminal states
 * stamp merged_at/closed_at via COALESCE so an existing timestamp is preserved.
 *
 * The merge/close timestamps are the AUTHORITATIVE values GitHub reported via
 * `ghGetPrMetadata` — never the enrichment wall-clock time. A null `mergedAt`/
 * `closedAt` writes null (a no-op under COALESCE): we record the new `state` so
 * the PR still reads as merged/closed, but we never invent a lifecycle instant.
 * Synthesizing `now` here back-dated a branch's "last active" to whenever the
 * post-import enrichment sweep happened to run, even for a PR merged long ago
 * (the branch list reads merged_at/closed_at as a genuine-activity signal).
 */
export async function syncPullRequestLifecycle(
  prisma: DesktopPrisma,
  art: Pick<ArtifactRow, "pr_number" | "repo_full_name">,
  prMeta: PrMetadata
): Promise<void> {
  if (!(art.pr_number && art.repo_full_name)) {
    return;
  }
  // RAW (named blocker: COALESCE-preserve write): `branch_name`/`merged_at`/
  // `closed_at`/`opened_at` must be set ONLY when currently null — a per-column
  // `COALESCE(col, $val)` no typed `update` data clause can express — and the
  // match is on the non-unique (repo_full_name, pr_number) pair, so it's an
  // `updateMany`-shaped statement regardless. Runs on the one Prisma client via
  // `write` so it serializes through the shared queue.
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `UPDATE pull_requests SET
         state = $1,
         branch_name = COALESCE($2, branch_name),
         merged_at = COALESCE(merged_at, $3),
         closed_at = COALESCE(closed_at, $4),
         opened_at = COALESCE(opened_at, $5)
       WHERE repo_full_name = $6 AND pr_number = $7`,
      prMeta.prState,
      prMeta.headRefName,
      prMeta.mergedAt,
      prMeta.closedAt,
      prMeta.openedAt,
      art.repo_full_name,
      art.pr_number
    )
  );
}

async function enrichFromMergeCommit(
  gitPath: string,
  cwd: string,
  mergeCommitSha: string
): Promise<EnrichmentResult | null> {
  const squashResult = await enrichSquashCommit(gitPath, cwd, mergeCommitSha);
  if (squashResult) {
    return squashResult;
  }

  return enrichMergeCommitForBranch(gitPath, cwd, mergeCommitSha);
}

export async function tryAcquireLease(
  prisma: DesktopPrisma,
  artifactId: string,
  now: string
): Promise<boolean> {
  const staleThreshold = new Date(Date.now() - LEASE_STALE_MS).toISOString();
  // Atomic compare-and-swap: the conditional WHERE (unleased OR stale lease) is
  // applied inside the single UPDATE, so `count > 0` means this caller won the
  // lease — replacing the prior `RETURNING id` row-count check.
  const result = await prisma.write((client) =>
    client.artifact.updateMany({
      where: {
        id: artifactId,
        OR: [{ leaseAt: null }, { leaseAt: { lt: staleThreshold } }],
      },
      data: { leaseAt: now },
    })
  );
  return result.count > 0;
}

async function releaseLease(
  prisma: DesktopPrisma,
  artifactId: string
): Promise<void> {
  // `updateMany` (not `update`) so a row deleted mid-sweep is a no-op, matching
  // the prior unconditional UPDATE's no-match behavior.
  await prisma.write((client) =>
    client.artifact.updateMany({
      where: { id: artifactId },
      data: { leaseAt: null },
    })
  );
}

export async function applyEnrichmentResult(
  prisma: DesktopPrisma,
  artifactId: string,
  result: EnrichmentResult,
  now: string
): Promise<void> {
  await prisma.write(async (client) => {
    await client.artifact.updateMany({
      where: { id: artifactId },
      data: {
        linesAdded: result.stats?.linesAdded ?? null,
        linesRemoved: result.stats?.linesRemoved ?? null,
        filesChanged: result.stats?.filesChanged ?? null,
        enrichmentState: result.state,
        enrichmentSource: result.source,
        enrichedAt: now,
        enrichmentAttempts: 0,
      },
    });

    // Enrichment writes LOC onto the artifact, not the session, but the
    // incremental cloud sync cursor keys off sessions.updated_at. Touch every
    // session linked to this artifact so the sync picks up the new
    // gitDiffStats. The prior single `UPDATE … WHERE id IN (subquery)` becomes a
    // keyed read + `updateMany`: the link set for one artifact is tiny (no
    // result-set fan-out), and both run in this one `write` unit on the shared
    // queue.
    const links = await client.sessionArtifactLink.findMany({
      where: { artifactId },
      select: { sessionId: true },
    });
    if (links.length > 0) {
      await client.session.updateMany({
        where: { id: { in: links.map((link) => link.sessionId) } },
        data: { updatedAt: now },
      });
    }
  });
}

export async function incrementAttempts(
  prisma: DesktopPrisma,
  artifactId: string,
  _now: string
): Promise<void> {
  // Atomic `enrichment_attempts = enrichment_attempts + 1` via the typed
  // increment operator (no read-modify-write).
  await prisma.write((client) =>
    client.artifact.updateMany({
      where: { id: artifactId },
      data: { enrichmentAttempts: { increment: 1 } },
    })
  );
}

export async function markNotApplicable(
  prisma: DesktopPrisma,
  artifactId: string,
  now: string
): Promise<void> {
  await prisma.write((client) =>
    client.artifact.updateMany({
      where: { id: artifactId },
      data: {
        enrichmentState: EnrichmentState.NotApplicable,
        enrichedAt: now,
      },
    })
  );
}

export async function linkBranchSessionsToPr(
  prisma: DesktopPrisma,
  branchArt: Pick<ArtifactRow, "id" | "branch_name" | "git_dir">,
  prNumber: number,
  repoFullName: string
): Promise<void> {
  const identityKey = computeIdentityKey({
    kind: ArtifactKind.PullRequest,
    repoFullName,
    prNumber,
  });
  const artifactId = artifactIdFromIdentityKey(identityKey);
  const now = new Date().toISOString();

  // RAW (named blocker: conditional ON CONFLICT DO UPDATE): the upsert preserves
  // branch_name/git_dir via per-column COALESCE AND guards the update with
  // `WHERE artifacts.identity_key = EXCLUDED.identity_key` — neither a
  // COALESCE-of-existing-and-excluded nor a conditional DO-UPDATE predicate has
  // a typed Prisma `upsert` form. Runs on the one client via `write`.
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number, branch_name,
          git_dir, created_at, last_seen_at)
       VALUES ($1,$2,'pull_request',$3,$4,$5,$6,$7,$7)
       ON CONFLICT(id) DO UPDATE SET
         last_seen_at = EXCLUDED.last_seen_at,
         branch_name = COALESCE(artifacts.branch_name, EXCLUDED.branch_name),
         git_dir = COALESCE(artifacts.git_dir, EXCLUDED.git_dir)
       WHERE artifacts.identity_key = EXCLUDED.identity_key`,
      artifactId,
      identityKey,
      repoFullName,
      prNumber,
      branchArt.branch_name,
      branchArt.git_dir,
      now
    )
  );

  // Link every session on this branch to the PR (skip if already linked).
  // SQLite has no md5()/left(): resolve the branch's sessions first, then
  // insert one workspace link per session with a JS-computed deterministic id
  // (matching propagateBranchPrLinks). The per-session `upsert` with an empty
  // `update` reproduces `ON CONFLICT(session_id, artifact_id, relation) DO
  // NOTHING` — it de-dupes on the natural triple regardless of the id encoding.
  const branchSessions = await prisma.client.sessionArtifactLink.findMany({
    where: { artifactId: branchArt.id },
    select: { sessionId: true },
  });
  for (const { sessionId } of branchSessions) {
    const linkId = artifactLinkId(
      sessionId,
      ArtifactKind.PullRequest,
      identityKey,
      "workspace"
    );
    await prisma.write((client) =>
      client.sessionArtifactLink.upsert({
        where: {
          sessionId_artifactId_relation: {
            sessionId,
            artifactId,
            relation: "workspace",
          },
        },
        create: {
          id: linkId,
          sessionId,
          artifactId,
          relation: "workspace",
          method: "branch_pr_association",
          evidence: "{}",
          isPrimary: false,
          status: "candidate",
          extractorVersion: 1,
          observedAt: now,
          createdAt: now,
        },
        update: {},
      })
    );
  }
}

function pauseAfterArtifact(options: EnrichmentSweepOptions): Promise<void> {
  return (
    options.cooperativeDelay?.(ENRICHMENT_ARTIFACT_PAUSE_MS) ??
    Promise.resolve()
  );
}
