/**
 * @file sync-attribution-resolution.ts
 * @description Per-session repository attribution for the SQLite sync/hydration
 * read, plus the durable `sessions.repo_full_name` write-back it produces.
 *
 * Extracted from `sync-source.ts` under ISS-5272 (that file is shrink-only
 * grandfathered and this is a self-contained responsibility: resolve a batch of
 * session rows to their repo identity, and persist what the resolution learned).
 *
 * Precedence is unchanged and deliberately LIVE-FIRST: the live cwd resolution
 * wins, the durable stored `repo_full_name` is the deleted-worktree fallback,
 * and ISS-4431 branch provenance is the last tier. What ISS-5272 changed is only
 * the COST of the live tier — `resolveSessionAttributionWithSourceAsync` now
 * falls through to a process-wide TTL memo instead of spawning `git remote
 * get-url origin` once per cwd per call site.
 */
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  type resolveSessionAttribution,
  resolveSessionAttributionWithSourceAsync,
  type SessionAttributionResolverCache,
} from "../agent-sync/agent-session-attribution.js";
import {
  ATTRIBUTION_SPAWN_CONCURRENCY,
  AttributionRepoSource,
  revalidateAttributionRepoFullName,
} from "../agent-sync/attribution-path-memo.js";
import type {
  SqliteArtifactLinkRow,
  SqliteSessionRow,
} from "./db-row-types.js";
import type { DesktopPrisma } from "./prisma-client.js";

export type ResolvedSyncAttribution = NonNullable<
  ReturnType<typeof resolveSessionAttribution>
>;

/** FEA-3555: durable repo-name write-back queued from a live resolution. */
export type RepoFullNameWriteBack = { id: string; repoFullName: string };

export type ResolvedSyncAttributions = {
  bySessionId: Map<string, ResolvedSyncAttribution | null>;
  /** Rows whose live-resolved repo name differs from the stored one. */
  writeBacks: RepoFullNameWriteBack[];
};

export async function resolveSyncAttributions(
  sessionRows: SqliteSessionRow[],
  cache: SessionAttributionResolverCache,
  artifactLinksBySessionId: Map<string, SqliteArtifactLinkRow[]>
): Promise<ResolvedSyncAttributions> {
  const uniqueCwds = [
    ...new Set(
      sessionRows.flatMap((row) => (row.cwd === null ? [] : [row.cwd]))
    ),
  ];
  const { liveByCwd, unprovenCwds } = await resolveLiveAttributionsByCwd(
    uniqueCwds,
    cache
  );
  await revalidateUnprovenWriteBackValues(
    sessionRows,
    liveByCwd,
    unprovenCwds,
    cache
  );

  // FEA-3555: derive a DURABLE per-session attribution from the live per-cwd
  // resolution plus the persisted `repo_full_name` cache.
  //
  // The live resolver runs `git remote get-url origin` in the session's
  // worktree; for an old completed session whose worktree was later deleted it
  // returns null, so the session used to lose its repo (and the repo-scoped
  // diff/lines) attribution on every sync. We fix that from two sides:
  //   - fallback: when the live attribution has no `repositoryFullName` but the
  //     row carries a stored one, project it onto the attribution so the repo
  //     identity survives worktree deletion.
  //   - write-back: when the resolution DOES yield a repo name that differs from
  //     what's stored, queue a durable upsert of that name onto the row (flushed
  //     by the caller outside the read). ISS-5272: that name can now come from
  //     the shared path memo rather than a spawn on this pass, so a differing
  //     memo-sourced name is revalidated live BEFORE it is queued.
  //
  // ISS-5271: the stored value is a TRUSTED PERSISTED PROJECTION, not an
  // exact-cwd proof. THIS lane's writes are live-or-revalidated resolutions of
  // the exact cwd, but the column has two other authors: the ISS-4431
  // branch-provenance third tier below (an artifact-link-derived repo, which
  // for a multi-repo session may not match the cwd's own remote) and the
  // ISS-5271 read-path fill-back (`applyRepoFullNameFillBacks`, live
  // resolutions only, filled only into null/blank rows). Stored-first READS
  // (the ruled ISS-5271 precedence) trust that projection; this lane stays
  // live-first and its live-differs-from-stored write-back above is what
  // supersedes a stale or branch-derived value once the cwd actually resolves.
  const bySessionId = new Map<string, ResolvedSyncAttribution | null>();
  const writeBacks: RepoFullNameWriteBack[] = [];
  for (const row of sessionRows) {
    const live = row.cwd ? (liveByCwd.get(row.cwd) ?? null) : null;
    const liveRepoFullName = live?.repositoryFullName ?? null;
    const storedRepoFullName = row.repo_full_name;

    if (liveRepoFullName) {
      bySessionId.set(row.id, live);
      if (liveRepoFullName !== storedRepoFullName) {
        writeBacks.push({ id: row.id, repoFullName: liveRepoFullName });
      }
      continue;
    }

    // Live resolution produced no repo (worktree gone / not a git repo). Fall
    // back to the durable stored repo name when we have one, keeping any other
    // live attribution fields (worktreePath, launch metadata) intact.
    if (storedRepoFullName) {
      bySessionId.set(
        row.id,
        applyStoredRepoFullName(live, storedRepoFullName)
      );
      continue;
    }

    // ISS-4431: third tier — resolve from branch-provenance in already-loaded
    // artifact link rows. A session with no live cwd and no stored repo may
    // still have session_artifact_links pointing to branch artifacts that carry
    // the real repo_full_name. The write-back makes this durable so subsequent
    // loads use the stored fallback path without re-resolving.
    const branchRepo = resolveBranchProvenanceRepo(
      artifactLinksBySessionId.get(row.id)
    );
    if (branchRepo) {
      bySessionId.set(row.id, applyStoredRepoFullName(live, branchRepo));
      writeBacks.push({ id: row.id, repoFullName: branchRepo });
      continue;
    }

    bySessionId.set(row.id, live);
  }

  return { bySessionId, writeBacks };
}

/**
 * FEA-3555: durably persist live-resolved repo full names onto their session
 * rows. Best-effort: a write failure must never fail the read/sync path (the
 * next successful sync re-attempts), so it is caught and swallowed. Serialized
 * through `prisma.write` like every other SQLite write.
 */
export async function persistResolvedRepoFullNames(
  prisma: DesktopPrisma,
  writeBacks: RepoFullNameWriteBack[]
): Promise<void> {
  if (writeBacks.length === 0) {
    return;
  }
  try {
    await prisma.write(async (client) => {
      for (const { id, repoFullName } of writeBacks) {
        try {
          // `updateMany` (not `update`) so a concurrently-deleted session is a
          // 0-row no-op instead of a P2025 throw that would abort the rest of
          // the batch. The per-row try/catch additionally isolates any other
          // failure: the repo name is a re-derivable cache, so a failed persist
          // just means we re-resolve (and re-attempt the write) on the next
          // sync — it must never fail the read/sync path.
          await client.session.updateMany({
            where: { id },
            data: { repoFullName },
          });
        } catch {
          // Non-fatal (see above): skip this row, keep persisting the rest.
        }
      }
    });
  } catch {
    // The write-back is a best-effort cache refresh. A failure of the
    // transaction wrapper itself (e.g. DB locked / connection unavailable) must
    // never propagate into the read/sync path — the repo name is re-derivable,
    // so we simply re-resolve and re-attempt the write on the next sync.
  }
}

/**
 * ISS-5272: resolve every distinct cwd in the chunk, in batches of
 * `ATTRIBUTION_SPAWN_CONCURRENCY` instead of one unbounded `Promise.all` over
 * up to `SYNCED_SESSION_HYDRATE_CHUNK_SIZE` (200) cwds.
 *
 * This batch width bounds the OUTER fan-out (200 simultaneous launch-metadata
 * walks and pending promises). The real spawn cap lives one layer down, on the
 * memo's dedicated gate, which wraps only the miss loader: a gate around this
 * call would take permits for per-call and memo hits, gating free work and
 * under-counting the actual process fan-out.
 *
 * `unprovenCwds` collects the cwds whose repo name did NOT come from a spawn on
 * this pass — a memo hit, or a hit on the caller's own per-call maps (which are
 * shared across chunks, so their provenance is unknown here). Those are the only
 * values a write-back must revalidate before persisting.
 */
async function resolveLiveAttributionsByCwd(
  uniqueCwds: string[],
  cache: SessionAttributionResolverCache
): Promise<{
  liveByCwd: Map<string, ResolvedSyncAttribution | null>;
  unprovenCwds: Set<string>;
}> {
  const liveByCwd = new Map<string, ResolvedSyncAttribution | null>();
  const unprovenCwds = new Set<string>();
  for (
    let start = 0;
    start < uniqueCwds.length;
    start += ATTRIBUTION_SPAWN_CONCURRENCY
  ) {
    const batch = uniqueCwds.slice(
      start,
      start + ATTRIBUTION_SPAWN_CONCURRENCY
    );
    const resolved = await Promise.all(
      batch.map((cwd) => resolveSessionAttributionWithSourceAsync(cwd, cache))
    );
    for (const [index, resolution] of resolved.entries()) {
      const cwd = batch[index];
      liveByCwd.set(cwd, resolution.attribution ?? null);
      if (resolution.repoSource !== AttributionRepoSource.Live) {
        unprovenCwds.add(cwd);
      }
    }
  }
  return { liveByCwd, unprovenCwds };
}

/**
 * ISS-5272 (C3): before a possibly-stale name is frozen into the durable column,
 * prove it live.
 *
 * A memo entry is a real resolution of that exact path, just up to one TTL old.
 * That is fine for a READ — the next miss corrects it — but a WRITE-BACK is
 * durable: if the remote changed inside the TTL and the worktree is deleted
 * before the TTL expires, live resolution returns null forever and the
 * stored-fallback branch trusts the stale name permanently. So a write-back
 * whose value is both unproven on this pass AND different from what is stored
 * forces one single-flight live resolution and adopts its answer, including a
 * null (the worktree really is gone → the row falls through to the stored
 * value/branch tier). It fires only on that rare disagreement, so steady state —
 * where live equals stored and nothing is queued — costs nothing.
 */
async function revalidateUnprovenWriteBackValues(
  sessionRows: SqliteSessionRow[],
  liveByCwd: Map<string, ResolvedSyncAttribution | null>,
  unprovenCwds: Set<string>,
  cache: SessionAttributionResolverCache
): Promise<void> {
  const needsRevalidation = new Set<string>();
  for (const row of sessionRows) {
    const cwd = row.cwd;
    if (cwd === null || !unprovenCwds.has(cwd)) {
      continue;
    }
    const liveRepoFullName = liveByCwd.get(cwd)?.repositoryFullName ?? null;
    if (liveRepoFullName !== null && liveRepoFullName !== row.repo_full_name) {
      needsRevalidation.add(cwd);
    }
  }
  for (const cwd of needsRevalidation) {
    const live = liveByCwd.get(cwd) ?? null;
    const lookupPath = live?.worktreePath ?? cwd;
    const revalidated = await revalidateAttributionRepoFullName(lookupPath);
    if (revalidated === (live?.repositoryFullName ?? null)) {
      continue;
    }
    const corrected = withRepositoryFullName(live, revalidated);
    liveByCwd.set(cwd, corrected);
    // Write THROUGH so later chunks sharing this cache see the corrected
    // identity rather than re-persisting the value we just disproved.
    cache.repoFullNameByPath.set(lookupPath, revalidated);
    cache.attributionByCwd.set(cwd, corrected);
  }
}

/**
 * ISS-4431: extract the best repository identity from a session's artifact link
 * rows. Prefers branches the session WROTE (relation=created); falls back to
 * any branch link with a non-null repo_full_name.
 */
function resolveBranchProvenanceRepo(
  links: SqliteArtifactLinkRow[] | undefined
): string | null {
  if (!links) {
    return null;
  }
  let best: string | null = null;
  for (const link of links) {
    if (link.target_kind !== "branch" || !link.repo_full_name) {
      continue;
    }
    if (link.relation === "created") {
      return normalizeRepoFullName(link.repo_full_name);
    }
    best ??= link.repo_full_name;
  }
  return best ? normalizeRepoFullName(best) : null;
}

/**
 * FEA-3555: project a durable stored repo full name onto a session's live
 * attribution. When the live attribution is null (no worktree fields at all),
 * synthesize a repo-only attribution so the session still carries its repo
 * identity for the diff/lines rollup. When live attribution exists but lost its
 * repo (worktree deleted), fill in the stored repo and keep the rest.
 */
function applyStoredRepoFullName(
  live: ResolvedSyncAttribution | null,
  storedRepoFullName: string
): ResolvedSyncAttribution {
  if (live) {
    return { ...live, repositoryFullName: storedRepoFullName };
  }
  return {
    repositoryFullName: storedRepoFullName,
    worktreePath: null,
    sourceArtifactId: null,
    sourceLoopId: null,
    baseBranch: null,
  };
}

/**
 * Replace a live attribution's repo identity with a revalidated one, which may
 * be null when the revalidation proved the remote is gone. A null identity with
 * no other live fields is no attribution at all.
 */
function withRepositoryFullName(
  live: ResolvedSyncAttribution | null,
  repositoryFullName: string | null
): ResolvedSyncAttribution | null {
  if (live) {
    return { ...live, repositoryFullName };
  }
  if (repositoryFullName === null) {
    return null;
  }
  return applyStoredRepoFullName(null, repositoryFullName);
}
