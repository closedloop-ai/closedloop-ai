/**
 * Resolve a session's repository/worktree attribution from its `cwd`.
 *
 * Walks up from the session's working directory to the nearest
 * `.closedloop-ai/work/launch-metadata.json` root, reads that launch metadata,
 * and resolves the git remote for the same path — memoizing every step in a
 * caller-owned {@link SessionAttributionResolverCache} so one hydration pass pays
 * each filesystem/git lookup once. The sync and async resolvers are behaviorally
 * identical; the async one exists so the hydration walk stays off the Electron
 * main thread.
 *
 * ISS-5272: the ASYNC resolver's git-remote step additionally falls through to
 * the process-wide `attribution-path-memo`, so the same path costs one spawn per
 * TTL window across the ~14 call sites that each build a fresh cache. A memo hit
 * is written THROUGH into the per-call `repoFullNameByPath`, so a TTL expiry
 * mid-fold cannot resolve one cwd to two identities. The launch-metadata walk
 * and `attributionByCwd` stay per-call and unshared.
 *
 * Extracted verbatim from `agent-session-sync-service.ts` (ISS-4676).
 */
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { resolveRepoFullName } from "../../server/operations/git-helpers.js";
import {
  type LaunchMetadata,
  readLaunchMetadata,
  readLaunchMetadataAsync,
} from "../../server/operations/symphony-utils.js";
import type { SyncedAgentSessionAttribution } from "./agent-session-sync-contract.js";
import {
  type AttributionRepoSource,
  resolveAttributionRepoFullName,
} from "./attribution-path-memo.js";

export type SessionAttributionResolverCache = {
  attributionByCwd: Map<string, SyncedAgentSessionAttribution | null>;
  launchMetadataRootByCwd: Map<string, string | null>;
  repoFullNameByPath: Map<string, string | null>;
};

export function resolveSessionAttribution(
  cwd: string | null,
  cache: SessionAttributionResolverCache
): SyncedAgentSessionAttribution | undefined {
  if (!cwd) {
    return undefined;
  }

  const cached = cache.attributionByCwd.get(cwd);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const worktreePath =
    findLaunchMetadataRoot(cwd, cache.launchMetadataRootByCwd) ?? cwd;
  const launchMetadata = readLaunchMetadata(worktreePath);
  const repoLookupPath = worktreePath;
  let repositoryFullName = cache.repoFullNameByPath.get(repoLookupPath);
  if (repositoryFullName === undefined) {
    repositoryFullName = resolveRepoFullName(repoLookupPath);
    cache.repoFullNameByPath.set(repoLookupPath, repositoryFullName);
  }

  const attribution = buildAttribution(
    worktreePath,
    repositoryFullName ?? null,
    launchMetadata
  );
  cache.attributionByCwd.set(cwd, attribution ?? null);
  return attribution ?? undefined;
}

/**
 * Async attribution resolver for sync hydration. It preserves
 * `resolveSessionAttribution` output and cache semantics while moving launch
 * metadata reads and git remote lookup off the Electron main thread.
 */
export async function resolveSessionAttributionAsync(
  cwd: string | null,
  cache: SessionAttributionResolverCache
): Promise<SyncedAgentSessionAttribution | undefined> {
  return (await resolveSessionAttributionWithSourceAsync(cwd, cache))
    .attribution;
}

function buildAttribution(
  worktreePath: string,
  repositoryFullName: string | null,
  launchMetadata: LaunchMetadata | null
): SyncedAgentSessionAttribution | null {
  const attribution: SyncedAgentSessionAttribution = {
    repositoryFullName,
    worktreePath,
    sourceArtifactId: launchMetadata?.artifactId ?? null,
    sourceLoopId: launchMetadata?.loopId ?? null,
    baseBranch: launchMetadata?.baseBranch ?? null,
  };

  return Object.values(attribution).some((value) => value) ? attribution : null;
}

function findLaunchMetadataRoot(
  startDir: string,
  cache: Map<string, string | null>
): string | null {
  const cached = cache.get(startDir);
  if (cached !== undefined) {
    return cached;
  }

  let currentDir = startDir;
  while (true) {
    const metadataPath = path.join(
      currentDir,
      ".closedloop-ai",
      "work",
      "launch-metadata.json"
    );
    if (existsSync(metadataPath)) {
      cache.set(startDir, currentDir);
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      cache.set(startDir, null);
      return null;
    }
    currentDir = parentDir;
  }
}

async function findLaunchMetadataRootAsync(
  startDir: string,
  cache: Map<string, string | null>
): Promise<string | null> {
  const cached = cache.get(startDir);
  if (cached !== undefined) {
    return cached;
  }

  let currentDir = startDir;
  while (true) {
    const metadataPath = path.join(
      currentDir,
      ".closedloop-ai",
      "work",
      "launch-metadata.json"
    );
    if (await fileExists(metadataPath)) {
      cache.set(startDir, currentDir);
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      cache.set(startDir, null);
      return null;
    }
    currentDir = parentDir;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * ISS-5272: one async attribution resolution plus the provenance of its repo
 * identity. `repoSource` is `null` when the repo name came from the caller's own
 * per-call maps (`attributionByCwd` or `repoFullNameByPath`) and therefore
 * carries no fresh evidence about this pass — a caller that must not persist a
 * possibly-stale name treats `null` the same as {@link AttributionRepoSource.Memo}.
 */
export type ResolvedSessionAttributionWithSource = {
  attribution: SyncedAgentSessionAttribution | undefined;
  repoSource: AttributionRepoSource | null;
};

/**
 * ISS-5272: the provenance-reporting form of {@link resolveSessionAttributionAsync}.
 * Provenance is observability only — it NEVER suppresses a durable write-back
 * (the FEA-3555 backfill fires per row whenever live differs from stored, and
 * gating it on a live spawn would stop the backfill entirely once the memo, or
 * even the pre-existing per-call cache, is warm).
 */
export async function resolveSessionAttributionWithSourceAsync(
  cwd: string | null,
  cache: SessionAttributionResolverCache
): Promise<ResolvedSessionAttributionWithSource> {
  if (!cwd) {
    return { attribution: undefined, repoSource: null };
  }

  const cached = cache.attributionByCwd.get(cwd);
  if (cached !== undefined) {
    return { attribution: cached ?? undefined, repoSource: null };
  }

  const worktreePath =
    (await findLaunchMetadataRootAsync(cwd, cache.launchMetadataRootByCwd)) ??
    cwd;
  const launchMetadata = await readLaunchMetadataAsync(worktreePath);
  const repoLookupPath = worktreePath;
  let repositoryFullName = cache.repoFullNameByPath.get(repoLookupPath);
  let repoSource: AttributionRepoSource | null = null;
  if (repositoryFullName === undefined) {
    const resolved = await resolveAttributionRepoFullName(repoLookupPath);
    repositoryFullName = resolved.repositoryFullName;
    repoSource = resolved.source;
    // Write THROUGH: the per-call map now owns this identity for the rest of the
    // pass, so a TTL expiry mid-fold cannot split one cwd into two repos.
    cache.repoFullNameByPath.set(repoLookupPath, repositoryFullName);
  }

  const attribution = buildAttribution(
    worktreePath,
    repositoryFullName ?? null,
    launchMetadata
  );
  cache.attributionByCwd.set(cwd, attribution ?? null);
  return { attribution: attribution ?? undefined, repoSource };
}
