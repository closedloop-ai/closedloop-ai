/**
 * @file session-list-trace-maintenance.ts
 * @description Bounded, resumable repair of the Desktop Sessions-list trace
 * projection. A page holds only session ids; each missing revision is rebuilt
 * and committed independently before the cursor advances.
 */

import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { DesktopPrisma, DesktopPrismaReader } from "./prisma-client.js";
import { buildSessionListTraceProjection } from "./session-list-trace-builder.js";
import type { SessionListTraceBackfillResult } from "./session-list-trace-maintenance-contract.js";
import {
  ensureSessionListTraceProjections,
  readSessionListTraceProjections,
  type SessionListTraceProjection,
} from "./session-list-trace-projection.js";

const DEFAULT_BACKFILL_PAGE_SIZE = 8;

type BuildProjection = (
  reader: DesktopPrismaReader,
  sessionId: string
) => Promise<SessionListTraceProjection | null>;

export type SessionListTraceRepairPage = {
  done: boolean;
  failed: number;
  nextCursor: string | null;
  repaired: number;
  scanned: number;
};

/** Repair one keyset page, committing each derived row as its resume marker. */
export async function repairSessionListTraceProjectionPage(
  prisma: DesktopPrisma,
  afterSessionId: string | null,
  options: {
    buildProjection?: BuildProjection;
    log?: (message: string) => void;
    pageSize?: number;
  } = {}
): Promise<SessionListTraceRepairPage> {
  const pageSize = Math.max(
    1,
    Math.floor(options.pageSize ?? DEFAULT_BACKFILL_PAGE_SIZE)
  );
  const rows = await prisma.read((reader) => {
    if (afterSessionId === null) {
      return reader.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM sessions
          WHERE status <> $1
          ORDER BY id ASC
          LIMIT $2`,
        SESSION_STATUS.ACTIVE,
        pageSize
      );
    }
    return reader.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM sessions
        WHERE status <> $1 AND id > $2
        ORDER BY id ASC
        LIMIT $3`,
      SESSION_STATUS.ACTIVE,
      afterSessionId,
      pageSize
    );
  });
  const ids = rows.map((row) => row.id);
  const current = await prisma.read((reader) =>
    readSessionListTraceProjections(reader, ids)
  );
  let repaired = 0;
  let failed = 0;
  for (const sessionId of ids) {
    if (current.has(sessionId)) {
      continue;
    }
    try {
      await ensureSessionListTraceProjections(
        prisma,
        [sessionId],
        options.buildProjection ?? buildSessionListTraceProjection
      );
      const promoted = await prisma.read((reader) =>
        readSessionListTraceProjections(reader, [sessionId])
      );
      if (promoted.has(sessionId)) {
        repaired += 1;
      }
    } catch (error) {
      failed += 1;
      options.log?.(
        `session-list trace repair failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return {
    scanned: ids.length,
    repaired,
    failed,
    nextCursor: ids.at(-1) ?? afterSessionId,
    done: ids.length < pageSize,
  };
}

/** Drain the corpus in bounded keyset pages without retaining prior ids. */
export async function backfillSessionListTraceProjections(
  prisma: DesktopPrisma,
  options: {
    cooperativeDelay?: () => Promise<void>;
    log?: (message: string) => void;
    pageSize?: number;
  } = {}
): Promise<SessionListTraceBackfillResult> {
  const total: SessionListTraceBackfillResult = {
    scanned: 0,
    repaired: 0,
    failed: 0,
  };
  let cursor: string | null = null;
  while (true) {
    const page = await repairSessionListTraceProjectionPage(prisma, cursor, {
      log: options.log,
      pageSize: options.pageSize,
    });
    total.scanned += page.scanned;
    total.repaired += page.repaired;
    total.failed += page.failed;
    if (page.done) {
      break;
    }
    cursor = page.nextCursor;
    await options.cooperativeDelay?.();
  }
  if (total.repaired > 0 || total.failed > 0) {
    options.log?.(
      `session-list trace repair complete: ${total.repaired} repaired, ${total.failed} failed, ${total.scanned} scanned`
    );
  }
  return total;
}
