import { createHash } from "node:crypto";
import {
  BranchTraceCompletenessState,
  type BranchTraceResult,
  BranchTraceSessionHydrationState,
} from "@repo/api/src/types/branch-trace";
import type { QualifyingBranchTraceSession } from "../branch-trace-service";

type TraceSnapshot = { trace: BranchTraceResult; version: string };
type CacheEntry = TraceSnapshot & {
  revision: string;
  expiresAt: number;
  bytes: number;
};

const maxEntries = 32;
const maxBytes = 32 * 1024 * 1024;
const ttlMs = 60_000;
const entries = new Map<string, CacheEntry>();

/** ISS-12281: optional acceleration; every miss rebuilds from authorized inputs. */
export async function readCachedBranchTrace(
  organizationId: string,
  branchId: string,
  sessions: readonly QualifyingBranchTraceSession[],
  build: () => Promise<BranchTraceResult>,
  signal?: AbortSignal
): Promise<TraceSnapshot> {
  signal?.throwIfAborted();
  prune();
  const key = JSON.stringify([organizationId, branchId]);
  const revision = JSON.stringify(sessions);
  const cached = entries.get(key);
  if (cached?.revision === revision) {
    entries.delete(key);
    entries.set(key, cached);
    return cached;
  }
  // An older population must never be served after a failed rebuild.
  entries.delete(key);
  const trace = await build();
  signal?.throwIfAborted();
  const serialized = JSON.stringify(trace);
  const version = createHash("sha256")
    .update(key)
    .update(revision)
    .update(serialized)
    .digest("hex");
  const bytes = Buffer.byteLength(serialized);
  if (
    bytes <= maxBytes &&
    (trace.completeness.state === BranchTraceCompletenessState.Complete ||
      (trace.sessions.length > 0 &&
        trace.sessions.every(
          (session) => session.state === BranchTraceSessionHydrationState.Loaded
        )))
  ) {
    entries.set(key, {
      trace,
      version,
      revision,
      bytes,
      expiresAt: Date.now() + ttlMs,
    });
    prune();
  }
  return { trace, version };
}

export function clearBranchTraceCacheForTests(): void {
  entries.clear();
}

function prune(): void {
  let bytes = 0;
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key);
    } else {
      bytes += entry.bytes;
    }
  }
  for (const [key, entry] of entries) {
    if (entries.size <= maxEntries && bytes <= maxBytes) {
      break;
    }
    entries.delete(key);
    bytes -= entry.bytes;
  }
}
