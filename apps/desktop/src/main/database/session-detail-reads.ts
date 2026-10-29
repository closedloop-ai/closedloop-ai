/**
 * @file session-detail-reads.ts
 * @description The session-detail reads the bounded hydration cannot answer:
 * the WHOLE-RUN event counts (ISS-5407), the per-event token cost points the
 * detail attributes to its turns, and the session's agent-component invocation
 * tree (ISS-10737).
 *
 * Split out of `sync-source.ts` (a grandfathered over-ceiling module) by
 * ISS-9857, which composed a third session-scoped read
 * (`session-event-page-read.ts`) into that source. Same composition pattern as
 * `createSessionDetailLinkReaders`: the wiring stays in `sync-source.ts`, the
 * reads live here.
 *
 * ISS-10737 renamed this from `session-detail-event-reads.ts` when it composed
 * the invocation-tree read in: the module composes session-detail reads, and
 * `event` in the name had stopped being true. Composing here rather than adding
 * a second spread in `sync-source.ts` is also what keeps that grandfathered file
 * shrink-only.
 */

import type { TokenEventCostPoint } from "@repo/api/src/types/agent-session";
import type { SessionEventCounts } from "../agent-sync/agent-session-sync-source.js";
import type { DesktopPrisma } from "./prisma-client.js";
import {
  createSessionInvocationTreeReader,
  type SessionInvocationTreeRequest,
  type SessionInvocationTreeRows,
} from "./session-invocation-tree-read.js";
import { selectSessionEventCounts } from "./sync-source-bounded-reads.js";

export function createSessionDetailReaders(prisma: DesktopPrisma): {
  loadSessionEventCounts: (
    ids: string[]
  ) => Promise<Map<string, SessionEventCounts>>;
  loadSessionTokenEvents: (sessionId: string) => Promise<TokenEventCostPoint[]>;
  loadSessionInvocationTree: (
    input: SessionInvocationTreeRequest
  ) => Promise<SessionInvocationTreeRows | null>;
} {
  return {
    loadSessionEventCounts: (ids: string[]) =>
      prisma.read((reader) => selectSessionEventCounts(reader, ids)),
    loadSessionTokenEvents: (sessionId: string) =>
      readSessionTokenCostPoints(prisma, sessionId),
    ...createSessionInvocationTreeReader(prisma),
  };
}

/**
 * One session's token events as cost points, oldest first. A row whose
 * `created_at` does not parse is dropped rather than plotted at `NaN`.
 */
async function readSessionTokenCostPoints(
  prisma: DesktopPrisma,
  sessionId: string
): Promise<TokenEventCostPoint[]> {
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<
      { created_at: string; cost_usd_estimated: number | null }[]
    >(
      "SELECT created_at, cost_usd_estimated FROM token_events WHERE session_id = ? ORDER BY created_at",
      sessionId
    )
  );
  const result: TokenEventCostPoint[] = [];
  for (const row of rows) {
    const tMs = Date.parse(row.created_at);
    if (!Number.isFinite(tMs)) {
      continue;
    }
    result.push({ tMs, costUsd: row.cost_usd_estimated ?? 0 });
  }
  return result;
}
