/**
 * @file codex-collector.ts
 * @description The per-harness collector descriptor for OpenAI Codex (FEA-1503).
 * The generic boot importer and the generic watcher drive Codex through this
 * uniform `HarnessCollector` shape: path/env resolution lives in `codex-home`,
 * format → NormalizedSession in `codex-parser`, and this descriptor wires them
 * together for the collector manager.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { yieldToEventLoop } from "../engine/cooperative-yield.js";
import { findWorkflowJournals } from "../parsing/codex-workflow-scanner.js";
import { collectArtifacts } from "../parsing/parser-utils.js";
import type {
  FileHarnessCollector,
  NormalizedParseQuality,
  NormalizedSession,
  NormalizedSubagent,
  NormalizedTokenCounts,
} from "../types.js";
import {
  getCodexArchivedDir,
  getCodexSessionsDir,
  listAllRolloutFiles,
  sessionIdFromRolloutPath,
} from "./codex-home.js";
import {
  collectRolloutUsageSnapshotIdentities,
  parseRolloutFile,
} from "./codex-parser.js";
import {
  buildCodexChildrenById,
  findCodexDescendants,
  findCodexParentSource,
  findCodexRootSource,
  mapCodexRolloutsById,
  maxCodexDescendantMtime,
  readCodexRolloutLinkage,
} from "./codex-subagent-rollouts.js";

export type CreateCodexCollectorOptions = {
  sessionsDir?: string;
  archivedDir?: string;
  listSources?: () => string[];
  /**
   * FEA-2264: path to the persisted rollout-linkage cache. When set, the
   * boot-time rollout-graph build re-reads only files changed since the last
   * launch instead of all of them.
   */
  linkageCachePath?: string;
};

export function createCodexCollector(
  options: CreateCodexCollectorOptions = {}
): FileHarnessCollector {
  const sessionsDir = options.sessionsDir ?? getCodexSessionsDir();
  const archivedDir = options.archivedDir ?? getCodexArchivedDir();
  const listSources = options.listSources ?? listAllRolloutFiles;
  const rolloutGraph = createRolloutGraphCache(
    listSources,
    options.linkageCachePath
  );
  // FEA-2264: maxWorkflowJournalMtime(source) depends only on dirname(source)
  // (it readdir-scans that directory for workflow journals), so memoize it by
  // directory. The boot import called it once per source, re-listing each
  // day-dir N times (a 291-session day = 291 redundant readdirSync calls).
  // Cleared per scan in prepareSourceBatch so newly added journals are still
  // picked up on the next pass.
  const workflowMtimeByDir = new Map<string, number | null>();
  const memoizedWorkflowJournalMtime = (source: string): number | null => {
    const dir = path.dirname(source);
    const cached = workflowMtimeByDir.get(dir);
    if (cached !== undefined) {
      return cached;
    }
    const mtime = maxWorkflowJournalMtime(source);
    workflowMtimeByDir.set(dir, mtime);
    return mtime;
  };
  return {
    key: "codex",
    cacheName: "codex",
    watchRoots(): string[] {
      // Recursive watch handled by the caller; Codex nests by date under here.
      return [sessionsDir];
    },
    sourceRoots(): string[] {
      return [sessionsDir, archivedDir];
    },
    watchMatch(filename: string): boolean {
      return filename.endsWith(".jsonl");
    },
    sourcePathsForWatchEvent(root: string, filename: string): string[] {
      const source = path.join(root, filename);
      return [findCodexRootSource(source, listSources())];
    },
    listSources(): string[] {
      return listSources();
    },
    async prepareSourceBatch(sources: readonly string[]): Promise<void> {
      workflowMtimeByDir.clear();
      // FEA-2264: build the rollout-linkage graph cooperatively. On a cold or
      // invalidated cache this reads the session_meta off every changed rollout
      // (thousands on first launch); yielding here keeps that off the main
      // thread instead of freezing the app before collectPendingSources starts
      // its own per-source yields.
      await rolloutGraph.prepareAsync(sources);
    },
    extraMtime: (source: string): number | null => {
      const workflowMtime = memoizedWorkflowJournalMtime(source);
      const descendantMtime = maxCodexDescendantMtime(
        source,
        rolloutGraph.sources(),
        rolloutGraph.byId(),
        rolloutGraph.childrenById(),
        rolloutGraph.linkageForSource(source)
      );
      return maxNullableMtime(workflowMtime, descendantMtime);
    },
    async parse(filePath: string): Promise<NormalizedSession[]> {
      const allSources = rolloutGraph.prepare(listSources());
      const byId = rolloutGraph.byId();
      const parent = findCodexParentSource(filePath, allSources, byId);
      if (parent) {
        return [];
      }
      const s = await parseRolloutFile(filePath);
      if (!s) {
        return [];
      }
      await foldCodexDescendants(s, filePath, allSources, byId);
      return [s];
    },
    sessionIdForSource(source: string): string | null {
      return sessionIdFromRolloutPath(source);
    },
    isBurstArtifactSource(source: string): boolean {
      return (
        findCodexParentSource(
          source,
          rolloutGraph.sources(),
          rolloutGraph.byId(),
          rolloutGraph.linkageForSource(source)
        ) !== null
      );
    },
  };
}

type CodexRolloutGraphCache = {
  prepare(sources: readonly string[]): readonly string[];
  /**
   * Cooperative variant of {@link prepare} that yields to the event loop while
   * stat/reading the rollout sources, so a cold-cache boot build does not block
   * the main thread. Used by the boot scan (prepareSourceBatch); the synchronous
   * `prepare` then hits the populated cache for the per-source lazy reads.
   */
  prepareAsync(sources: readonly string[]): Promise<readonly string[]>;
  sources(): readonly string[];
  byId(): ReturnType<typeof mapCodexRolloutsById>;
  childrenById(): ReturnType<typeof buildCodexChildrenById>;
  linkageForSource(
    source: string
  ): ReturnType<typeof readCodexRolloutLinkage> | undefined;
};

// FEA-2264: persisted rollout-linkage cache (see ingestCodexLinkageCachePath).
const LINKAGE_CACHE_VERSION = 1;
// Non-path delimiter for the in-memory rollout-graph staleness key.
const ROLLOUT_GRAPH_KEY_DELIM = String.fromCharCode(0);

type PersistedLinkageEntry = {
  mtimeMs: number;
  size: number;
  linkage: ReturnType<typeof readCodexRolloutLinkage>;
};

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isNumberOrNull(value: unknown): boolean {
  return value === null || typeof value === "number";
}

// FEA-2264: validate a persisted cache entry against its key before trusting it
// as graph truth. The on-disk JSON can be stale, corrupt, or hand-edited, and
// the linkage's `sourcePath` later steers descendant-graph lookups and parsing.
// An entry whose linkage points at a different path than its admitted key, or
// whose shape is malformed, is dropped (rebuilt from disk on the cold path)
// rather than crashing the build or aiming graph work outside the admitted
// source.
function isValidPersistedLinkageEntry(
  value: unknown,
  key: string
): value is PersistedLinkageEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.mtimeMs !== "number" || typeof entry.size !== "number") {
    return false;
  }
  const linkage = entry.linkage;
  if (typeof linkage !== "object" || linkage === null) {
    return false;
  }
  const fields = linkage as Record<string, unknown>;
  // The linkage must describe the same path it is filed under; a mismatch is the
  // poisoned/wrong-path case the descendant graph must never follow.
  if (fields.sourcePath !== key) {
    return false;
  }
  if (typeof fields.rolloutId !== "string" || fields.rolloutId.length === 0) {
    return false;
  }
  return (
    isStringOrNull(fields.parentThreadId) &&
    isNumberOrNull(fields.depth) &&
    isStringOrNull(fields.agentNickname) &&
    isStringOrNull(fields.agentRole) &&
    isStringOrNull(fields.forkedFromId)
  );
}

function loadPersistedLinkage(
  cachePath: string | undefined
): Map<string, PersistedLinkageEntry> {
  if (!cachePath) {
    return new Map();
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
      version?: number;
      entries?: Record<string, unknown>;
    };
    if (parsed.version !== LINKAGE_CACHE_VERSION || !parsed.entries) {
      return new Map();
    }
    const valid = new Map<string, PersistedLinkageEntry>();
    for (const [key, entry] of Object.entries(parsed.entries)) {
      if (isValidPersistedLinkageEntry(entry, key)) {
        valid.set(key, entry);
      }
    }
    return valid;
  } catch {
    return new Map();
  }
}

function savePersistedLinkage(
  cachePath: string | undefined,
  cache: Map<string, PersistedLinkageEntry>
): void {
  if (!cachePath) {
    return;
  }
  try {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: LINKAGE_CACHE_VERSION,
        entries: Object.fromEntries(cache),
      })
    );
  } catch {
    // Best-effort: a failed write just means the next launch rebuilds.
  }
}

type RolloutLinkage = ReturnType<typeof readCodexRolloutLinkage>;
type RolloutStat = { mtimeMs: number; size: number };

// FEA-2264: yield cadence for the cooperative cold-cache graph build, matching
// the source-scan cadence in collector-manager. 256 keeps the added macrotask
// turns negligible over a multi-thousand-rollout history while bounding any
// single synchronous stat/read run to a small slice.
const GRAPH_PREP_YIELD_EVERY = 256;

// FEA-2264: stat one source into the shared maps + key parts. Shared by the
// synchronous and cooperative stat passes so they cannot drift.
function statOneRolloutSource(
  source: string,
  statBySource: Map<string, RolloutStat>,
  keyParts: string[]
): void {
  try {
    const stat = statSync(source);
    statBySource.set(source, { mtimeMs: stat.mtimeMs, size: stat.size });
    keyParts.push(
      `${source}${ROLLOUT_GRAPH_KEY_DELIM}${stat.mtimeMs}${ROLLOUT_GRAPH_KEY_DELIM}${stat.size}`
    );
  } catch {
    keyParts.push(`${source}${ROLLOUT_GRAPH_KEY_DELIM}missing`);
  }
}

// FEA-2264: stat every source once and derive the rollout-graph staleness key
// from the same stats (so we never stat twice).
function statRolloutSources(sources: readonly string[]): {
  statBySource: Map<string, RolloutStat>;
  key: string;
} {
  const statBySource = new Map<string, RolloutStat>();
  const keyParts: string[] = [];
  for (const source of sources) {
    statOneRolloutSource(source, statBySource, keyParts);
  }
  return { statBySource, key: keyParts.join(ROLLOUT_GRAPH_KEY_DELIM) };
}

// Cooperative variant of statRolloutSources: yields every GRAPH_PREP_YIELD_EVERY
// sources so a cold-cache boot stat run does not block the main thread.
async function statRolloutSourcesAsync(sources: readonly string[]): Promise<{
  statBySource: Map<string, RolloutStat>;
  key: string;
}> {
  const statBySource = new Map<string, RolloutStat>();
  const keyParts: string[] = [];
  let sinceYield = 0;
  for (const source of sources) {
    if (++sinceYield >= GRAPH_PREP_YIELD_EVERY) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
    statOneRolloutSource(source, statBySource, keyParts);
  }
  return { statBySource, key: keyParts.join(ROLLOUT_GRAPH_KEY_DELIM) };
}

// FEA-2264: resolve one source's linkage from the persisted cache or, on a
// miss/change, read its session_meta. Returns whether the cache was mutated.
// Shared by the synchronous and cooperative builds so they cannot drift.
function resolveRolloutLinkage(
  source: string,
  statBySource: Map<string, RolloutStat>,
  persistedLinkage: Map<string, PersistedLinkageEntry>
): { linkage: RolloutLinkage; dirty: boolean } {
  const stat = statBySource.get(source);
  const cached = stat ? persistedLinkage.get(source) : undefined;
  if (cached && cached.mtimeMs === stat?.mtimeMs && cached.size === stat.size) {
    return { linkage: cached.linkage, dirty: false };
  }
  // New, changed, or unstattable files are read + parsed. Only stattable files
  // are cached (mtime/size is the freshness key); an unstattable one still gets
  // its path-derived fallback linkage, matching the previous mapCodexRolloutsById
  // behavior.
  const linkage = readCodexRolloutLinkage(source);
  if (stat) {
    persistedLinkage.set(source, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      linkage,
    });
    return { linkage, dirty: true };
  }
  return { linkage, dirty: false };
}

// Drop persisted entries for sources that no longer exist on disk. Returns
// whether anything was removed.
function pruneMissingPersistedLinkage(
  persistedLinkage: Map<string, PersistedLinkageEntry>,
  statBySource: Map<string, RolloutStat>
): boolean {
  if (persistedLinkage.size <= statBySource.size) {
    return false;
  }
  let removed = false;
  for (const cachedSource of persistedLinkage.keys()) {
    if (!statBySource.has(cachedSource)) {
      persistedLinkage.delete(cachedSource);
      removed = true;
    }
  }
  return removed;
}

// FEA-2264: build the rollout id -> linkage map, reading the session_meta of only
// the files whose mtime/size changed since the persisted cache was written.
function buildRolloutByIdWithCache(
  sources: readonly string[],
  statBySource: Map<string, RolloutStat>,
  persistedLinkage: Map<string, PersistedLinkageEntry>
): { byId: Map<string, RolloutLinkage>; cacheDirty: boolean } {
  const byId = new Map<string, RolloutLinkage>();
  let cacheDirty = false;
  for (const source of sources) {
    const { linkage, dirty } = resolveRolloutLinkage(
      source,
      statBySource,
      persistedLinkage
    );
    if (dirty) {
      cacheDirty = true;
    }
    if (!byId.has(linkage.rolloutId)) {
      byId.set(linkage.rolloutId, linkage);
    }
  }
  if (pruneMissingPersistedLinkage(persistedLinkage, statBySource)) {
    cacheDirty = true;
  }
  return { byId, cacheDirty };
}

// Cooperative variant of buildRolloutByIdWithCache: yields every
// GRAPH_PREP_YIELD_EVERY sources so a cold-cache boot build (a session_meta read
// per changed rollout, thousands on first launch) does not block the main
// thread before the per-source scan even starts.
async function buildRolloutByIdWithCacheAsync(
  sources: readonly string[],
  statBySource: Map<string, RolloutStat>,
  persistedLinkage: Map<string, PersistedLinkageEntry>
): Promise<{ byId: Map<string, RolloutLinkage>; cacheDirty: boolean }> {
  const byId = new Map<string, RolloutLinkage>();
  let cacheDirty = false;
  let sinceYield = 0;
  for (const source of sources) {
    if (++sinceYield >= GRAPH_PREP_YIELD_EVERY) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
    const { linkage, dirty } = resolveRolloutLinkage(
      source,
      statBySource,
      persistedLinkage
    );
    if (dirty) {
      cacheDirty = true;
    }
    if (!byId.has(linkage.rolloutId)) {
      byId.set(linkage.rolloutId, linkage);
    }
  }
  if (pruneMissingPersistedLinkage(persistedLinkage, statBySource)) {
    cacheDirty = true;
  }
  return { byId, cacheDirty };
}

function createRolloutGraphCache(
  listSources: () => string[],
  linkageCachePath?: string
): CodexRolloutGraphCache {
  let cachedKey = "";
  let cachedSources: readonly string[] = [];
  let cachedById = new Map<
    string,
    ReturnType<typeof readCodexRolloutLinkage>
  >();
  let cachedChildrenById: ReturnType<typeof buildCodexChildrenById> = new Map();
  let cachedBySourcePath = new Map<
    string,
    ReturnType<typeof readCodexRolloutLinkage>
  >();
  // FEA-2264: session_meta linkage persisted across launches, keyed by source
  // path + mtime + size. The boot-time rollout-graph build re-reads only files
  // that changed since the last launch instead of all ~8k every time.
  const persistedLinkage = loadPersistedLinkage(linkageCachePath);

  // Commit a freshly built graph into the cache fields. Shared by the sync and
  // cooperative prepares so they update identical state.
  const applyBuild = (
    sources: readonly string[],
    key: string,
    byId: Map<string, RolloutLinkage>,
    cacheDirty: boolean
  ): void => {
    cachedKey = key;
    cachedSources = [...sources];
    cachedById = byId;
    cachedChildrenById = buildCodexChildrenById(byId);
    // Index linkage by source path so findCodexDescendants / findCodexParentSource
    // look it up instead of re-reading each file per source.
    cachedBySourcePath = new Map();
    for (const linkage of byId.values()) {
      cachedBySourcePath.set(linkage.sourcePath, linkage);
    }
    if (cacheDirty) {
      savePersistedLinkage(linkageCachePath, persistedLinkage);
    }
  };

  const prepare = (sources: readonly string[]): readonly string[] => {
    const { statBySource, key } = statRolloutSources(sources);
    if (key === cachedKey) {
      return cachedSources;
    }
    const { byId, cacheDirty } = buildRolloutByIdWithCache(
      sources,
      statBySource,
      persistedLinkage
    );
    applyBuild(sources, key, byId, cacheDirty);
    return cachedSources;
  };

  const prepareAsync = async (
    sources: readonly string[]
  ): Promise<readonly string[]> => {
    const { statBySource, key } = await statRolloutSourcesAsync(sources);
    if (key === cachedKey) {
      return cachedSources;
    }
    const { byId, cacheDirty } = await buildRolloutByIdWithCacheAsync(
      sources,
      statBySource,
      persistedLinkage
    );
    applyBuild(sources, key, byId, cacheDirty);
    return cachedSources;
  };

  return {
    prepare,
    prepareAsync,
    sources: () =>
      cachedSources.length > 0 ? cachedSources : prepare(listSources()),
    byId: () => {
      if (cachedSources.length === 0) {
        prepare(listSources());
      }
      return cachedById;
    },
    childrenById: () => {
      if (cachedSources.length === 0) {
        prepare(listSources());
      }
      return cachedChildrenById;
    },
    linkageForSource: (source: string) => {
      if (cachedSources.length === 0) {
        prepare(listSources());
      }
      return cachedBySourcePath.get(source);
    },
  };
}

// Exported for the FEA-2646 Layer 1 golden runner, which must exercise the
// SAME descendant fold production uses (parse-only replication would let the
// golden suite pass without testing this path).
export async function foldCodexDescendants(
  root: NormalizedSession,
  rootPath: string,
  allSources: readonly string[],
  sourcesByRolloutId = mapCodexRolloutsById(allSources)
): Promise<void> {
  const rootLinkage = readCodexRolloutLinkage(rootPath);
  const normalizedIdByRolloutId = new Map<string, string>([
    [rootLinkage.rolloutId, ""],
  ]);
  const subagents: NormalizedSubagent[] = [...(root.subagents ?? [])];
  const foldedToolUses = [...root.toolUses];
  const replayedUsageIdentitiesBySource = new Map<string, Set<string>>();
  for (const child of findCodexDescendants(
    rootPath,
    allSources,
    sourcesByRolloutId
  )) {
    const forkedFromSource = child.forkedFromId
      ? sourcesByRolloutId.get(child.forkedFromId)?.sourcePath
      : null;
    let replayedUsageIdentities: Set<string> | undefined;
    if (forkedFromSource) {
      replayedUsageIdentities =
        replayedUsageIdentitiesBySource.get(forkedFromSource);
      if (!replayedUsageIdentities) {
        replayedUsageIdentities =
          await collectRolloutUsageSnapshotIdentities(forkedFromSource);
        replayedUsageIdentitiesBySource.set(
          forkedFromSource,
          replayedUsageIdentities
        );
      }
    }
    const parsedChild = await parseRolloutFile(child.sourcePath, {
      mergeWorkflowJournalTokens: false,
      replayedUsageIdentities,
    });
    if (!parsedChild) {
      continue;
    }
    const subagentId = child.rolloutId;
    normalizedIdByRolloutId.set(child.rolloutId, subagentId);
    const parentId = child.parentThreadId
      ? normalizedIdByRolloutId.get(child.parentThreadId)
      : null;
    const ownedToolUses = parsedChild.toolUses.map((toolUse) => ({
      ...toolUse,
      subagentId: toolUse.subagentId ?? subagentId,
    }));
    subagents.push({
      id: subagentId,
      parentId: parentId || null,
      name:
        child.agentNickname ??
        child.agentRole ??
        parsedChild.name ??
        `Codex subagent ${child.rolloutId.slice(0, 8)}`,
      type: child.agentRole,
      task: parsedChild.name,
      startedAt: parsedChild.startedAt,
      endedAt: parsedChild.endedAt,
      status: "completed",
      nativeSubagentId: child.rolloutId,
      toolUses: ownedToolUses,
      tokensByModel: parsedChild.tokensByModel,
      tokenSeries: parsedChild.tokenSeries,
      metadata: {
        codexDepth: child.depth,
        codexParentThreadId: child.parentThreadId,
      },
    });
    foldedToolUses.push(...ownedToolUses);
    mergeTokensByModel(root.tokensByModel, parsedChild.tokensByModel);
    root.tokenSeries.push(...parsedChild.tokenSeries);
    // FEA-2907: the folded child's transcript lines are part of the parent's
    // derived data, so its parse-quality signal must fold in too. Line counts
    // are additive (total corruption/attempted across parent+children) and
    // truncatedFinalLine ORs (any child truncated ⇒ the merged data has a
    // truncation drop). Without this the parent under-reports malformed lines.
    root.parseQuality = mergeParseQuality(
      root.parseQuality,
      parsedChild.parseQuality
    );
  }
  root.toolUses = foldedToolUses;
  root.artifacts = collectArtifacts(root.toolUses, root.cwd);
  root.subagents = subagents;
}

function mergeParseQuality(
  target: NormalizedParseQuality | undefined,
  source: NormalizedParseQuality | undefined
): NormalizedParseQuality | undefined {
  if (!source) {
    return target;
  }
  if (!target) {
    return { ...source };
  }
  return {
    totalLines: target.totalLines + source.totalLines,
    malformedLines: target.malformedLines + source.malformedLines,
    truncatedFinalLine: target.truncatedFinalLine || source.truncatedFinalLine,
  };
}

function mergeTokensByModel(
  target: Record<string, NormalizedTokenCounts>,
  source: Record<string, NormalizedTokenCounts>
): void {
  for (const [model, counts] of Object.entries(source)) {
    const existing = target[model];
    target[model] = {
      input: (existing?.input ?? 0) + counts.input,
      output: (existing?.output ?? 0) + counts.output,
      cacheRead: (existing?.cacheRead ?? 0) + counts.cacheRead,
      cacheWrite: (existing?.cacheWrite ?? 0) + counts.cacheWrite,
      ...(existing?.inferred || counts.inferred ? { inferred: true } : {}),
    };
  }
}

function maxNullableMtime(
  first: number | null,
  second: number | null
): number | null {
  if (first == null) {
    return second;
  }
  if (second == null) {
    return first;
  }
  return Math.max(first, second);
}

function maxWorkflowJournalMtime(source: string): number | null {
  let maxMtime: number | null = null;
  for (const journal of findWorkflowJournals(path.dirname(source))) {
    try {
      const mtime = statSync(journal).mtimeMs;
      maxMtime = maxMtime == null ? mtime : Math.max(maxMtime, mtime);
    } catch {
      /* race — ignore */
    }
  }
  return maxMtime;
}
