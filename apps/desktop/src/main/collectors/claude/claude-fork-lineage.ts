/**
 * ISS-12552 (AC-020): find the history a headless Claude fork copied.
 *
 * `claude --resume <id> --fork-session` writes a new transcript that starts
 * with the parent's whole history, every entry keeping its uuid and
 * timestamp with only `sessionId` (and `promptId`) rewritten, and carries no
 * `forkedFrom` stamp. Nothing inside the file marks the copy (measured on the
 * golden corpus: older-than-head timestamps, enqueue/prompt structure and
 * shared prompt ids all occur in ordinary sessions too), so the copy is found
 * the way the Codex collector finds a fork's parent rollout: by reading the
 * sibling transcript it came from.
 *
 * Two transcripts in one project directory that share entry uuids share
 * history. The copy is the one whose own first timestamped record was written
 * after every shared entry: a fork can only start once the history it copies
 * exists, while the original's first record precedes its history.
 */
import { createReadStream, type Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { BoundedMap } from "@repo/lib/bounded-map";
import type { ClaudeLineageReplay } from "@repo/lib/harness/claude/fork-replay";
import { z } from "zod";
import { TRANSCRIPT_MAX_READ_BYTES } from "../parsing/transcript-read-limit.js";

type TranscriptHead = {
  mtimeMs: number;
  size: number;
  /** The first user or assistant entry's uuid; null while the file has none. */
  firstEntryUuid: string | null;
  /** The first timestamped record's time, in file order. */
  headMs: number | null;
};

type DirectoryIndex = {
  dirMtimeMs: number;
  heads: Map<string, TranscriptHead>;
};

const ENTRY_TYPES: ReadonlySet<string> = new Set(["user", "assistant"]);
/** A head this many lines in with no entry is not a transcript worth pairing. */
const MAX_HEAD_LINES = 200;
/** Directories whose index is kept; the oldest is dropped past this. */
const MAX_INDEXED_DIRECTORIES = 256;

const recordSchema = z
  .object({
    type: z.string().optional(),
    uuid: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .loose();

/** Files whose lineage result is kept for reuse. */
const MAX_MEMOIZED_LINEAGES = 1024;
/** Transcripts whose entry times are kept; a fork reads its parent's each time. */
const MAX_CACHED_ENTRY_TIMES = 64;

const directoryIndexes = new Map<string, DirectoryIndex>();

/**
 * The last result per file, reused while the inputs it was read from are
 * unchanged, so a caller keyed on the replayed set's identity (the transcript
 * token cache) keeps hitting. A fork's copied history is written when the fork
 * starts, before any of its own turns, so the fork's own growth cannot change
 * which entries are copies: the key is its head plus each sibling's state.
 */
const lineageMemo = new BoundedMap<
  string,
  { key: string; result: ClaudeLineageReplay | undefined }
>(MAX_MEMOIZED_LINEAGES);

const entryTimesCache = new BoundedMap<
  string,
  { mtimeMs: number; size: number; entries: Map<string, number> }
>(MAX_CACHED_ENTRY_TIMES);

/**
 * The entries `filePath` copied from a sibling transcript, or undefined when
 * it copied none. The parent is named only when the sibling it shares the
 * most history with is not itself a copy.
 */
export async function resolveClaudeForkLineage(
  filePath: string
): Promise<ClaudeLineageReplay | undefined> {
  const index = await directoryIndexFor(path.dirname(filePath));
  const own = index.heads.get(filePath);
  if (!own?.firstEntryUuid || own.headMs === null) {
    return undefined;
  }
  const siblings = await currentSiblings(index, filePath, own.firstEntryUuid);
  if (siblings.length === 0) {
    return undefined;
  }
  const key = [
    `${own.firstEntryUuid}@${own.headMs}`,
    ...siblings.map((s) => `${s.file}:${s.mtimeMs}:${s.size}`),
  ].join("\n");
  const memo = lineageMemo.get(filePath);
  if (memo?.key === key) {
    return memo.result;
  }
  const result = await computeLineage(filePath, own.headMs, siblings);
  lineageMemo.set(filePath, { key, result });
  return result;
}

type Sibling = {
  file: string;
  mtimeMs: number;
  size: number;
  headMs: number | null;
};

/** Siblings sharing the file's first entry, freshly stat'ed and within the read cap. */
async function currentSiblings(
  index: DirectoryIndex,
  filePath: string,
  firstEntryUuid: string
): Promise<Sibling[]> {
  const siblings: Sibling[] = [];
  for (const [file, head] of [...index.heads].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (file === filePath || head.firstEntryUuid !== firstEntryUuid) {
      continue;
    }
    const fileStats = await stat(file).catch(() => null);
    if (fileStats && fileStats.size <= TRANSCRIPT_MAX_READ_BYTES) {
      siblings.push({
        file,
        mtimeMs: fileStats.mtimeMs,
        size: fileStats.size,
        headMs: head.headMs,
      });
    }
  }
  return siblings;
}

async function computeLineage(
  filePath: string,
  ownHeadMs: number,
  siblings: readonly Sibling[]
): Promise<ClaudeLineageReplay | undefined> {
  const ownStats = await stat(filePath).catch(() => null);
  if (!ownStats || ownStats.size > TRANSCRIPT_MAX_READ_BYTES) {
    return undefined;
  }
  const ownEntries = await readEntryTimes(filePath, ownStats);
  const replayed = new Set<string>();
  let parent: { sessionId: string; shared: number } | null = null;
  for (const sibling of siblings) {
    const shared = sharedEntries(
      ownEntries,
      await readEntryTimes(sibling.file, sibling)
    );
    if (shared.uuids.length === 0 || ownHeadMs <= shared.latestMs) {
      continue;
    }
    for (const uuid of shared.uuids) {
      replayed.add(uuid);
    }
    const siblingIsCopy =
      sibling.headMs !== null && sibling.headMs > shared.latestMs;
    if (
      !siblingIsCopy &&
      (parent === null || shared.uuids.length > parent.shared)
    ) {
      parent = {
        sessionId: path.basename(sibling.file, ".jsonl"),
        shared: shared.uuids.length,
      };
    }
  }
  return replayed.size === 0
    ? undefined
    : { parentSessionId: parent?.sessionId ?? null, entryUuids: replayed };
}

/** Test seam: forget every directory index. */
export function clearClaudeForkLineageCache(): void {
  directoryIndexes.clear();
  lineageMemo.clear();
  entryTimesCache.clear();
}

async function directoryIndexFor(directory: string): Promise<DirectoryIndex> {
  const dirStats = await stat(directory);
  let index = directoryIndexes.get(directory);
  if (!index || index.dirMtimeMs !== dirStats.mtimeMs) {
    index = await rebuildIndex(directory, dirStats, index);
  } else {
    await refreshEmptyHeads(index);
  }
  directoryIndexes.delete(directory);
  directoryIndexes.set(directory, index);
  if (directoryIndexes.size > MAX_INDEXED_DIRECTORIES) {
    const oldest = directoryIndexes.keys().next().value;
    if (oldest !== undefined) {
      directoryIndexes.delete(oldest);
    }
  }
  return index;
}

async function rebuildIndex(
  directory: string,
  dirStats: Stats,
  previous: DirectoryIndex | undefined
): Promise<DirectoryIndex> {
  const heads = new Map<string, TranscriptHead>();
  const names = await readdir(directory);
  for (const name of names) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const file = path.join(directory, name);
    const prior = previous?.heads.get(file);
    const head = await currentHead(file, prior);
    if (head) {
      heads.set(file, head);
    }
  }
  return { dirMtimeMs: dirStats.mtimeMs, heads };
}

/** A file indexed before its first entry was written is read again. */
async function refreshEmptyHeads(index: DirectoryIndex): Promise<void> {
  for (const [file, head] of index.heads) {
    if (head.firstEntryUuid === null || head.headMs === null) {
      const fresh = await currentHead(file, head);
      if (fresh) {
        index.heads.set(file, fresh);
      } else {
        index.heads.delete(file);
      }
    }
  }
}

async function currentHead(
  file: string,
  prior: TranscriptHead | undefined
): Promise<TranscriptHead | null> {
  let fileStats: Stats;
  try {
    fileStats = await stat(file);
  } catch {
    return null;
  }
  if (
    prior &&
    prior.mtimeMs === fileStats.mtimeMs &&
    prior.size === fileStats.size
  ) {
    return prior;
  }
  return {
    mtimeMs: fileStats.mtimeMs,
    size: fileStats.size,
    ...(await readHead(file)),
  };
}

async function readHead(
  file: string
): Promise<Pick<TranscriptHead, "firstEntryUuid" | "headMs">> {
  let firstEntryUuid: string | null = null;
  let headMs: number | null = null;
  let lines = 0;
  for await (const record of transcriptRecords(file)) {
    lines += 1;
    if (headMs === null && record.timestamp !== undefined) {
      headMs = parseMs(record.timestamp);
    }
    if (record.uuid && record.type && ENTRY_TYPES.has(record.type)) {
      firstEntryUuid = record.uuid;
    }
    if (
      (firstEntryUuid !== null && headMs !== null) ||
      lines >= MAX_HEAD_LINES
    ) {
      break;
    }
  }
  return { firstEntryUuid, headMs };
}

async function readEntryTimes(
  file: string,
  current: { mtimeMs: number; size: number }
): Promise<Map<string, number>> {
  const cached = entryTimesCache.get(file);
  if (
    cached &&
    cached.mtimeMs === current.mtimeMs &&
    cached.size === current.size
  ) {
    return cached.entries;
  }
  const entries = new Map<string, number>();
  for await (const record of transcriptRecords(file)) {
    const at = record.timestamp ? parseMs(record.timestamp) : null;
    if (record.uuid && at !== null && !entries.has(record.uuid)) {
      entries.set(record.uuid, at);
    }
  }
  entryTimesCache.set(file, { ...current, entries });
  return entries;
}

function sharedEntries(
  own: ReadonlyMap<string, number>,
  sibling: ReadonlyMap<string, number>
): { uuids: string[]; latestMs: number } {
  const uuids: string[] = [];
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const [uuid, at] of own) {
    if (sibling.has(uuid)) {
      uuids.push(uuid);
      latestMs = Math.max(latestMs, at);
    }
  }
  return { uuids, latestMs };
}

async function* transcriptRecords(
  file: string
): AsyncGenerator<z.infer<typeof recordSchema>> {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({
    input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of lines) {
      const parsed = recordSchema.safeParse(parseJsonLine(line));
      if (parsed.success) {
        yield parsed.data;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function parseJsonLine(line: string): unknown {
  if (line.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
