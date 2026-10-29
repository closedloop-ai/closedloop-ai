/**
 * @file codex-collector.ts
 * @description The per-harness collector descriptor for OpenAI Codex (FEA-1503).
 * The generic boot importer and the generic watcher drive Codex through this
 * uniform `HarnessCollector` shape: path/env resolution lives in `codex-home`,
 * format → NormalizedSession in `codex-parser`, and this descriptor wires them
 * together for the collector manager.
 */
import { statSync } from "node:fs";
import path from "node:path";
import type { NormalizedParseQuality } from "@repo/lib/harness/parse-quality";
import { yieldToEventLoop } from "../engine/cooperative-yield.js";
import type {
  IngestStorePort,
  IngestStoreSnapshot,
} from "../engine/ingest-store-port.js";
import { mergeTokensByModel } from "../engine/merge-tokens-by-model.js";
import { corruptLineCount } from "../engine/parse-quality-scan.js";
import { findWorkflowJournals } from "../parsing/codex-workflow-scanner.js";
import { collectArtifacts } from "../parsing/parser-utils.js";
import type {
  FileHarnessCollector,
  NormalizedSession,
  NormalizedSubagent,
} from "../types.js";
import {
  getCodexArchivedDir,
  getCodexSessionsDir,
  listAllRolloutFiles,
  sessionIdFromRolloutPath,
} from "./codex-home.js";
import {
  codexZeroSessionParseKey,
  collectRolloutUsageSnapshotIdentities,
  parseRolloutFile,
} from "./codex-parser.js";
import {
  buildCodexChildrenById,
  type CodexRolloutLinkage,
  effectiveParentId,
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
   * FEA-2264: durable port for the persisted rollout-linkage cache. When set,
   * the boot-time rollout-graph build re-reads only files changed since the last
   * launch instead of all of them. ISS-9838 moved the backing store from a JSON
   * file to a SQLite row behind this injected port (ISS-9837 R2).
   */
  linkageStore?: IngestStorePort;
};

export function createCodexCollector(
  options: CreateCodexCollectorOptions = {}
): FileHarnessCollector {
  // ISS-7625: the last parse's unreadable-rollout quality, awaiting a drain by
  // `takeUnreadableParseQuality`. Per collector INSTANCE, as the Claude one is.
  let unreadableParseQuality: NormalizedParseQuality | undefined;
  const sessionsDir = options.sessionsDir ?? getCodexSessionsDir();
  const archivedDir = options.archivedDir ?? getCodexArchivedDir();
  const listSources = options.listSources ?? listAllRolloutFiles;
  const rolloutGraph = createRolloutGraphCache(
    listSources,
    options.linkageStore
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
      // ISS-7625: cleared before the parse so a prior source's report can never
      // be drained as this one's.
      unreadableParseQuality = undefined;
      const allSources = rolloutGraph.prepare(listSources());
      const byId = rolloutGraph.byId();
      const parent = findCodexParentSource(filePath, allSources, byId);
      if (parent) {
        // A child rollout with a present parent is a HEALTHY zero: its content is
        // imported under the parent, so it must report no ingest failure. The
        // early return keeps the parser — and therefore the sink — out of it
        // entirely, which is why `sessions.length === 0` was never a usable proxy.
        return [];
      }
      const s = await parseRolloutFile(filePath, {
        onUnreadableParse: (quality) => {
          unreadableParseQuality = quality;
        },
      });
      if (!s) {
        return [];
      }
      await foldCodexDescendants(s, filePath, allSources, byId);
      return [s];
    },
    takeUnreadableParseQuality: (): NormalizedParseQuality | undefined => {
      const quality = unreadableParseQuality;
      unreadableParseQuality = undefined;
      return quality;
    },
    sessionIdForSource(source: string): string | null {
      return sessionIdFromRolloutPath(source);
    },
    zeroSessionParseKey: codexZeroSessionParseKey,
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

// FEA-2264: persisted rollout-linkage cache. ISS-9837 R3: this discriminates
// the whole store's FORMAT, so a snapshot at another version is discarded whole.
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

// ISS-9837 R1: `hydrated` was resolved before the collector was constructed, so
// this stays synchronous the way `listSources()` requires.
function loadPersistedLinkage(
  store: IngestStorePort | undefined
): Map<string, PersistedLinkageEntry> {
  const hydrated = store?.hydrated;
  if (!hydrated || hydrated.version !== LINKAGE_CACHE_VERSION) {
    return new Map();
  }
  const valid = new Map<string, PersistedLinkageEntry>();
  for (const [key, entry] of Object.entries(hydrated.entries)) {
    if (isValidPersistedLinkageEntry(entry, key)) {
      valid.set(key, entry);
    }
  }
  return valid;
}

function savePersistedLinkage(
  store: IngestStorePort | undefined,
  cache: Map<string, PersistedLinkageEntry>
): void {
  if (!store) {
    return;
  }
  const snapshot: IngestStoreSnapshot = {
    version: LINKAGE_CACHE_VERSION,
    entries: Object.fromEntries(cache),
  };
  try {
    // Best-effort and not retried: an unaccepted write just means the next
    // launch rebuilds the linkage from the rollout files, which is what a cold
    // cache already does. The port logs the failure.
    store.save(snapshot).catch(() => {
      // The port contract says `save` never rejects; terminating the chain
      // keeps a port that breaks it from becoming an unhandled rejection.
    });
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
  linkageStore?: IngestStorePort
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
  const persistedLinkage = loadPersistedLinkage(linkageStore);

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
      savePersistedLinkage(linkageStore, persistedLinkage);
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

function buildCodexChildMeta(
  child: CodexRolloutLinkage
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    codexDepth: child.depth,
    codexParentThreadId: child.parentThreadId,
  };
  if (child.forkedFromId && !child.parentThreadId) {
    meta.codexForkedFromId = child.forkedFromId;
  }
  return meta;
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
  const seenCompactionTimestamps = new Set(
    asCompactions(root)
      .map((c) => c.timestamp)
      .filter((t): t is string => t != null)
  );
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
    // FEA-3597: stamp round-trip provenance BEFORE this child's series is both
    // assigned to its subagent row and spread into the root below. Codex
    // children come from `parseRolloutFile`, which never goes through
    // `extractDedupedUsage`, so this is the codex lane's single stamp site.
    // Mutating in place is intentional: the same objects back both views, so a
    // subagent's own `tokenSeries` stays self-describing and consistent with
    // the root copy. Nested descendants are enumerated separately and each gets
    // its OWN rolloutId, so no record is stamped twice.
    for (const record of parsedChild.tokenSeries) {
      record.subagentId = subagentId;
    }
    const effectiveParent = effectiveParentId(child);
    const parentId = effectiveParent
      ? normalizedIdByRolloutId.get(effectiveParent)
      : null;
    const ownedToolUses = parsedChild.toolUses.map((toolUse) => ({
      ...toolUse,
      subagentId: toolUse.subagentId ?? subagentId,
    }));
    const childMeta = buildCodexChildMeta(child);
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
      metadata: childMeta,
    });
    foldedToolUses.push(...ownedToolUses);
    foldChildMcpCallEvidence(root, parsedChild, subagentId);
    mergeTokensByModel(root.tokensByModel, parsedChild.tokensByModel);
    root.tokenSeries.push(...parsedChild.tokenSeries);
    // FEA-3526: only the root is imported (child sources return [] from the
    // collector), so a child rollout's authoritative per-turn `last_token_usage`
    // snapshots must fold into the root alongside its `tokenSeries` — otherwise
    // the captured snapshots would cover only root turns while the canonical
    // token totals already include child turns. Pure metadata (never alters
    // token math); appended verbatim so each snapshot keeps its own model +
    // timestamp. Root may not carry the field yet (optional), so seed it.
    if (parsedChild.codexLastTokenUsage?.length) {
      root.codexLastTokenUsage = [
        ...(root.codexLastTokenUsage ?? []),
        ...parsedChild.codexLastTokenUsage,
      ];
    }
    // FEA-3527: fold the child's reasoning-output subdivision alongside its token
    // totals so the root's metadata tracks the canonical totals (which now include
    // child spend). Each child was parsed with `replayedUsageIdentities`, so its
    // `reasoning_output_tokens` already excludes the replayed parent prefix —
    // summing root + children therefore does NOT double-count the parent's
    // portion (mirrors the token-total dedup). A non-additive subset of output,
    // never added to any token grand total.
    root.usageExtras.reasoning_output_tokens +=
      parsedChild.usageExtras.reasoning_output_tokens;
    // FEA-2907: the folded child's transcript lines are part of the parent's
    // derived data, so its parse-quality signal must fold in too. Line counts
    // are additive (total corruption/attempted across parent+children). Without
    // this the parent under-reports malformed lines. `truncatedFinalLine` does
    // NOT fold — see `mergeParseQuality`, where ISS-6336 took the OR back out.
    root.parseQuality = mergeParseQuality(
      root.parseQuality,
      parsedChild.parseQuality
    );
    foldChildCompactions(root, parsedChild, seenCompactionTimestamps);
  }
  root.toolUses = foldedToolUses;
  root.artifacts = collectArtifacts(root.toolUses, root.cwd);
  root.subagents = subagents;
}

// NormalizedSession types `compactions` as unknown[]; both parsers emit this
// entry shape (see write-core's Compaction event consumer).
function asCompactions(
  session: NormalizedSession
): Array<{ uuid: string | null; timestamp: string | null }> {
  return session.compactions as Array<{
    uuid: string | null;
    timestamp: string | null;
  }>;
}

/**
 * FEA-3127: only the root is imported (child sources return [] from the
 * collector), so a compaction recorded in a child rollout must fold into the
 * root's `compactions` to reach write-core — the Claude parser's
 * common-metadata pass counts sidechain compact summaries into the root the
 * same way. Forked rollouts replay the source rollout's history, `compacted`
 * records included, so a timestamp already in `seenTimestamps` (the root's or
 * an earlier child's) is a replay, not a second compaction.
 */
function foldChildCompactions(
  root: NormalizedSession,
  child: NormalizedSession,
  seenTimestamps: Set<string>
): void {
  for (const compaction of asCompactions(child)) {
    if (compaction.timestamp && seenTimestamps.has(compaction.timestamp)) {
      continue;
    }
    if (compaction.timestamp) {
      seenTimestamps.add(compaction.timestamp);
    }
    root.compactions.push(compaction);
  }
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
  // ISS-6336 (whitlockk review): the child's OWN trailing truncation is discounted
  // here, and the discount is tallied, exactly as `foldChildParseQuality` does
  // for a Claude sidecar. This re-derived the fold and got it wrong on both
  // halves: summing `malformedLines` raw counted every descendant's benign
  // live-write truncation as corruption — a healthy multi-rollout session
  // emitted `session_parse_degraded` — and OR-ing `truncatedFinalLine` let the
  // parent claim a trailing truncation it does not have, which discounts a
  // genuinely corrupt parent line instead. `truncatedFinalLine` is a property of
  // the ROOT rollout's own file; the `NormalizedParseQuality` contract says so.
  const childTruncatedFinalLines =
    (target.childTruncatedFinalLines ?? 0) +
    (source.childTruncatedFinalLines ?? 0) +
    (source.truncatedFinalLine ? 1 : 0);
  // ISS-12036: the descendant's share of the merged `malformedLines`, so a
  // degraded multi-rollout Codex session says WHICH writer lost the lines rather
  // than only that some were lost. The descendant's own folded-child share
  // (its workflow journals) stays in that bucket and is carried across, so the
  // three shares still sum back to `corruptLineCount`.
  const descendantCorrupt = corruptLineCount(source);
  const foldedDescendantMalformedLines =
    (target.foldedDescendantMalformedLines ?? 0) +
    (source.foldedDescendantMalformedLines ?? 0) +
    Math.max(0, descendantCorrupt - (source.foldedChildMalformedLines ?? 0));
  const foldedChildMalformedLines =
    (target.foldedChildMalformedLines ?? 0) +
    (source.foldedChildMalformedLines ?? 0);
  return {
    totalLines: target.totalLines + source.totalLines,
    malformedLines: target.malformedLines + descendantCorrupt,
    truncatedFinalLine: target.truncatedFinalLine,
    ...(childTruncatedFinalLines > 0 ? { childTruncatedFinalLines } : {}),
    ...sumAdditiveParseCounters(target, source),
    ...(foldedChildMalformedLines > 0 ? { foldedChildMalformedLines } : {}),
    ...(foldedDescendantMalformedLines > 0
      ? { foldedDescendantMalformedLines }
      : {}),
  };
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

/**
 * The plainly-additive optional counters a Codex descendant fold sums, in the
 * order {@link mergeParseQuality} emits them.
 *
 * Each is a diagnostic a CHILD rollout can carry as readily as the root, and
 * folding only the base line counts dropped the child's share on a multi-rollout
 * session:
 *   - `malformedRateLimits` (FEA-3702) — a present-but-malformed `rate_limits`
 *     block, otherwise silently lost when the main rollout folds with its
 *     workflow-journal companion;
 *   - `unknownRecords` (FEA-3713) — records the classifier could not route;
 *   - `orphanedToolOutputs` / `ambiguousToolOutputs` (FEA-3701) — MCP/tool-output
 *     correlation diagnostics.
 *
 * A list rather than four near-identical statements (ISS-12036 pushed the
 * function past the cognitive-complexity ceiling), and the summing rule they
 * share is the whole reason they can share one: `a + b`, omitted when zero.
 * {@link NormalizedParseQuality}'s other optional counters are deliberately NOT
 * here — each carries an extra term and keeps its own statement.
 */
const ADDITIVE_PARSE_COUNTERS = [
  "malformedRateLimits",
  "unknownRecords",
  "orphanedToolOutputs",
  "ambiguousToolOutputs",
] as const satisfies readonly (keyof NormalizedParseQuality)[];

type AdditiveParseCounter = (typeof ADDITIVE_PARSE_COUNTERS)[number];

/**
 * Sum {@link ADDITIVE_PARSE_COUNTERS} across one fold, omitting every key that
 * came out zero so a fully-clean merge round-trips byte-identically against a
 * frozen `normalized.json`.
 */
function sumAdditiveParseCounters(
  target: NormalizedParseQuality,
  source: NormalizedParseQuality
): Partial<Record<AdditiveParseCounter, number>> {
  const summed: Partial<Record<AdditiveParseCounter, number>> = {};
  for (const key of ADDITIVE_PARSE_COUNTERS) {
    const total = (target[key] ?? 0) + (source[key] ?? 0);
    if (total > 0) {
      summed[key] = total;
    }
  }
  return summed;
}

/**
 * ISS-12552: a child's code-mode MCP calls are evidence of the subagent that
 * made them, owned the same way as its tool uses.
 */
function foldChildMcpCallEvidence(
  root: NormalizedSession,
  child: NormalizedSession,
  subagentId: string
): void {
  if (!child.mcpCallEvidence?.length) {
    return;
  }
  root.mcpCallEvidence = [
    ...(root.mcpCallEvidence ?? []),
    ...child.mcpCallEvidence.map((call) => ({
      ...call,
      subagentId: call.subagentId ?? subagentId,
    })),
  ];
}
