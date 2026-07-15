import { closeSync, openSync, readSync, statSync } from "node:fs";

import { asRecord } from "../../../shared/type-guards.js";
import { stringValue } from "../parsing/parser-utils.js";
import { sessionIdFromRolloutPath } from "./codex-home.js";

const MAX_CODEX_META_PREFIX_BYTES = 64 * 1024;
const CODEX_META_READ_CHUNK_BYTES = 4096;

export type CodexRolloutLinkage = {
  rolloutId: string;
  parentThreadId: string | null;
  depth: number | null;
  agentNickname: string | null;
  agentRole: string | null;
  forkedFromId: string | null;
  sourcePath: string;
};

/** Read bounded Codex rollout metadata without parsing the full transcript. */
export function readCodexRolloutLinkage(
  sourcePath: string
): CodexRolloutLinkage {
  const fallbackId = sessionIdFromRolloutPath(sourcePath);
  const firstMeta = readFirstSessionMetaPayload(sourcePath);
  return {
    rolloutId: stringValue(firstMeta?.id) ?? fallbackId,
    parentThreadId: extractParentThreadId(firstMeta),
    depth: numberValue(
      asRecord(asRecord(asRecord(firstMeta?.source)?.subagent)?.thread_spawn),
      "depth"
    ),
    agentNickname:
      stringValue(
        asRecord(asRecord(firstMeta?.source)?.subagent)?.agent_nickname
      ) ??
      stringValue(
        asRecord(asRecord(asRecord(firstMeta?.source)?.subagent)?.thread_spawn)
          ?.agent_nickname
      ),
    agentRole:
      stringValue(
        asRecord(asRecord(firstMeta?.source)?.subagent)?.agent_role
      ) ??
      stringValue(
        asRecord(asRecord(asRecord(firstMeta?.source)?.subagent)?.thread_spawn)
          ?.agent_role
      ),
    forkedFromId: stringValue(firstMeta?.forked_from_id),
    sourcePath,
  };
}

export function mapCodexRolloutsById(
  sources: readonly string[]
): Map<string, CodexRolloutLinkage> {
  const byId = new Map<string, CodexRolloutLinkage>();
  for (const source of sources) {
    const linkage = readCodexRolloutLinkage(source);
    if (!byId.has(linkage.rolloutId)) {
      byId.set(linkage.rolloutId, linkage);
    }
  }
  return byId;
}

// FEA-2264: one-time parent->children index over the rollout graph. Building it
// once (O(N)) lets findCodexDescendants visit only a root's actual descendants
// instead of re-scanning every rollout per call. The boot import calls
// findCodexDescendants once per source (via extraMtime), so the old per-call
// full scan was O(N^2) (~33s of pure CPU for ~8k codex rollouts); with this
// index the whole pass is O(N).
export function buildCodexChildrenById(
  byId: Map<string, CodexRolloutLinkage>
): Map<string, CodexRolloutLinkage[]> {
  const childrenById = new Map<string, CodexRolloutLinkage[]>();
  for (const linkage of byId.values()) {
    if (!linkage.parentThreadId) {
      continue;
    }
    const siblings = childrenById.get(linkage.parentThreadId);
    if (siblings) {
      siblings.push(linkage);
    } else {
      childrenById.set(linkage.parentThreadId, [linkage]);
    }
  }
  return childrenById;
}

export function findCodexDescendants(
  rootPath: string,
  sources: readonly string[],
  byId = mapCodexRolloutsById(sources),
  childrenById = buildCodexChildrenById(byId),
  rootLinkage: CodexRolloutLinkage = readCodexRolloutLinkage(rootPath)
): CodexRolloutLinkage[] {
  const rootId = rootLinkage.rolloutId;
  const descendants: CodexRolloutLinkage[] = [];
  const seen = new Set<string>([rootId]);
  // BFS over the prebuilt children index: visit only this root's descendants
  // (O(1) for the common leaf case) instead of a fixed-point scan of every
  // rollout on each call.
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (parentId === undefined) {
      break;
    }
    for (const child of childrenById.get(parentId) ?? []) {
      if (!seen.has(child.rolloutId)) {
        seen.add(child.rolloutId);
        descendants.push(child);
        queue.push(child.rolloutId);
      }
    }
  }
  descendants.sort((a, b) => (a.depth ?? 1) - (b.depth ?? 1));
  return descendants;
}

export function findCodexParentSource(
  childPath: string,
  sources: readonly string[],
  byId = mapCodexRolloutsById(sources),
  childLinkage: CodexRolloutLinkage = readCodexRolloutLinkage(childPath)
): string | null {
  if (!childLinkage.parentThreadId) {
    return null;
  }
  const parent = byId.get(childLinkage.parentThreadId);
  return parent?.sourcePath ?? null;
}

/**
 * Walk a rollout's parent chain to its root linkage, guarding against cycles.
 * Shared by {@link findCodexRootSource} (wants the root's path) and the
 * archive-lane discovery (wants the root's rollout id).
 */
export function walkCodexRootLinkage(
  start: CodexRolloutLinkage,
  byId: ReadonlyMap<string, CodexRolloutLinkage>
): CodexRolloutLinkage {
  let current = start;
  const seen = new Set<string>([current.rolloutId]);
  while (current.parentThreadId) {
    const parent = byId.get(current.parentThreadId);
    if (!parent || seen.has(parent.rolloutId)) {
      break;
    }
    seen.add(parent.rolloutId);
    current = parent;
  }
  return current;
}

export function findCodexRootSource(
  descendantPath: string,
  sources: readonly string[],
  byId = mapCodexRolloutsById(sources)
): string {
  return walkCodexRootLinkage(readCodexRolloutLinkage(descendantPath), byId)
    .sourcePath;
}

export function maxCodexDescendantMtime(
  rootPath: string,
  sources: readonly string[],
  byId = mapCodexRolloutsById(sources),
  childrenById = buildCodexChildrenById(byId),
  rootLinkage: CodexRolloutLinkage = readCodexRolloutLinkage(rootPath)
): number | null {
  let maxMtime: number | null = null;
  for (const descendant of findCodexDescendants(
    rootPath,
    sources,
    byId,
    childrenById,
    rootLinkage
  )) {
    try {
      const mtime = statSync(descendant.sourcePath).mtimeMs;
      maxMtime = maxMtime == null ? mtime : Math.max(maxMtime, mtime);
    } catch {
      /* race -- ignore */
    }
  }
  return maxMtime;
}

function readFirstSessionMetaPayload(
  sourcePath: string
): Record<string, unknown> | null {
  const line = readFirstNonEmptyLinePrefix(sourcePath);
  if (!line) {
    return null;
  }
  try {
    const record = asRecord(JSON.parse(line));
    const payload = asRecord(record?.payload) ?? record;
    if (record?.type === "session_meta" || payload?.id || payload?.source) {
      return payload;
    }
  } catch {
    return null;
  }
  return null;
}

function readFirstNonEmptyLinePrefix(sourcePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(sourcePath, "r");
    const buffer = Buffer.allocUnsafe(CODEX_META_READ_CHUNK_BYTES);
    let offset = 0;
    let pending = "";
    while (offset < MAX_CODEX_META_PREFIX_BYTES) {
      const bytesToRead = Math.min(
        CODEX_META_READ_CHUNK_BYTES,
        MAX_CODEX_META_PREFIX_BYTES - offset
      );
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, offset);
      if (bytesRead === 0) {
        const trimmed = pending.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
      offset += bytesRead;
      pending += buffer.toString("utf8", 0, bytesRead);
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex).trim();
        if (line.length > 0) {
          return line;
        }
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

function extractParentThreadId(
  payload: Record<string, unknown> | null
): string | null {
  const source = asRecord(payload?.source);
  const threadSpawn = asRecord(asRecord(source?.subagent)?.thread_spawn);
  return (
    stringValue(threadSpawn?.parent_thread_id) ??
    stringValue(payload?.parent_thread_id)
  );
}

function numberValue(
  record: Record<string, unknown> | null,
  key: string
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
