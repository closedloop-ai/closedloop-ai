/**
 * @file session-list-trace-projection.ts
 * @description Revisioned Desktop-local cache for the compact trace facts used
 * by the Sessions list. Source-table triggers invalidate rows transactionally;
 * repair derives and promotes one session inside one writer transaction.
 */

import {
  REPOSITORY_FULL_NAME_MAX_LENGTH,
  SessionPrRelationType,
  SYNCED_PR_URL_MAX_LENGTH,
  syncedBranchLifecycleEventSchema,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { AUTONOMY_FORMULA_VERSION } from "@repo/lib/session-trace/autonomy";
import { z } from "zod";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type { DesktopPrisma, DesktopPrismaReader } from "./prisma-client.js";
import { selectRowsByIds } from "./session-detail-mappers.js";

// Bump when canonical trace or list-field derivation changes persisted output.
// 3: ISS-12709 stopped emitting gitDiffStats/branchDiffStats. DROP COLUMN fires
// no invalidation trigger, so without this bump an upgraded store keeps serving
// the old diff stats out of cached rows until each session is next touched.
const SESSION_LIST_TRACE_ALGORITHM_VERSION = 3;
export const SESSION_LIST_TRACE_PROJECTION_REVISION =
  SESSION_LIST_TRACE_ALGORITHM_VERSION * 1000 + AUTONOMY_FORMULA_VERSION;

const diffStatsSchema = z.object({
  filesChanged: z.number(),
  linesAdded: z.number(),
  linesRemoved: z.number(),
  source: z.string(),
});
const sessionPrSchema = z.object({
  num: z.union([z.number(), z.string()]),
  status: z.string(),
  title: z.string(),
});
const markerSchema = z.object({
  illustrative: z.boolean().optional(),
  kind: z.enum(["commit", "pr", "fail", "frust", "prompt"]),
  label: z.string(),
  t: z.string(),
  tl: z.number(),
  x: z.number(),
});
const activityBucketSchema = z.object({
  binEndMs: z.number().optional(),
  binStartMs: z.number().optional(),
  byModel: z.record(
    z.string(),
    z.object({ cCache: z.number(), cIn: z.number(), cOut: z.number() })
  ),
  cCache: z.number(),
  cIn: z.number(),
  cOut: z.number(),
  key: z.string().optional(),
  label: z.string(),
  tl0: z.number().nullable(),
  toolStart: z.number(),
  total: z.number(),
});
const sessionPrRefSchema = z.object({
  branchLifecycleEvents: z.array(syncedBranchLifecycleEventSchema).optional(),
  prNumber: z.number(),
  prUrl: z.string().min(1).max(SYNCED_PR_URL_MAX_LENGTH).optional(),
  relationType: z.enum([
    SessionPrRelationType.Created,
    SessionPrRelationType.Referenced,
    SessionPrRelationType.Reviewed,
  ]),
  repositoryFullName: z.string().min(1).max(REPOSITORY_FULL_NAME_MAX_LENGTH),
});
const fieldsSchema = z.object({
  activeAgent: z.string().nullable().optional(),
  activityBuckets: z.array(activityBucketSchema).nullable().optional(),
  autonomy: z.number().nullable().optional(),
  branch: z.string().nullable().optional(),
  branchDiffStats: diffStatsSchema.nullable().optional(),
  filesChanged: z.number().nullable().optional(),
  gitDiffStats: diffStatsSchema.nullable().optional(),
  linesAdded: z.number().nullable().optional(),
  linesRemoved: z.number().nullable().optional(),
  markers: z.array(markerSchema).nullable().optional(),
  phaseIterations: z.record(z.string(), z.number()).nullable().optional(),
  phaseLoopbacks: z
    .array(
      z.object({
        depth: z.number(),
        from: z.string(),
        label: z.string(),
        to: z.string(),
      })
    )
    .nullable()
    .optional(),
  phases: z
    .array(
      z.object({
        cCache: z.number(),
        cIn: z.number(),
        cOut: z.number(),
        cost: z.string(),
        dur: z.string(),
        key: z.string(),
        label: z.string(),
      })
    )
    .nullable()
    .optional(),
  prRefs: z.array(sessionPrRefSchema).optional(),
  prs: z.array(sessionPrSchema).nullable().optional(),
  span: z
    .object({
      endMs: z.number().optional(),
      first: z.string(),
      last: z.string(),
      startMs: z.number().optional(),
    })
    .nullable()
    .optional(),
  steeringEpisodes: z.number().nullable().optional(),
  throttles: z
    .array(
      z.object({
        durMin: z.number(),
        t0: z.string(),
        t1: z.string(),
        tl: z.number(),
        x0: z.number(),
      })
    )
    .nullable()
    .optional(),
  turns: z.number().nullable().optional(),
  waitingUser: z.string().nullable().optional(),
  wallClock: z.string().nullable().optional(),
});

const storedProjectionSchema = z.object({
  agentCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  fields: fieldsSchema,
  lastActivityAt: z.string().nullable(),
  toolUseCount: z.number().int().nonnegative(),
});

export type SessionListTraceProjection = {
  agentCount: number;
  errorCount: number;
  fields: Pick<
    SyncedAgentSession,
    | "activeAgent"
    | "activityBuckets"
    | "autonomy"
    | "branch"
    | "branchDiffStats"
    | "filesChanged"
    | "gitDiffStats"
    | "linesAdded"
    | "linesRemoved"
    | "markers"
    | "phaseIterations"
    | "phaseLoopbacks"
    | "phases"
    | "prRefs"
    | "prs"
    | "span"
    | "steeringEpisodes"
    | "throttles"
    | "turns"
    | "waitingUser"
    | "wallClock"
  >;
  lastActivityAt: SyncedAgentSession["lastActivityAt"];
  toolUseCount: number;
};

type StoredProjectionRow = {
  session_id: string;
  revision: number;
  payload: string;
};

type BuildProjection = (
  reader: DesktopPrismaReader,
  sessionId: string
) => Promise<SessionListTraceProjection | null>;

/** Read only current, validated projection rows for the requested sessions. */
export async function readSessionListTraceProjections(
  reader: DesktopPrismaReader,
  ids: string[]
): Promise<Map<string, SessionListTraceProjection>> {
  const rows = await selectRowsByIds<StoredProjectionRow>(
    reader,
    `SELECT session_id, revision, json(payload) AS payload
       FROM session_list_trace_projection
      WHERE session_id IN (__IDS__)`,
    ids
  );
  const projections = new Map<string, SessionListTraceProjection>();
  for (const row of rows) {
    if (row.revision !== SESSION_LIST_TRACE_PROJECTION_REVISION) {
      continue;
    }
    const parsed = parseStoredProjection(row.payload);
    if (parsed) {
      projections.set(row.session_id, parsed);
    }
  }
  return projections;
}

/**
 * Repair missing/stale rows one session per transaction. Source mutations use
 * the same serialized writer and invalidate through triggers, so each promoted
 * payload describes exactly the source snapshot committed with it.
 */
export async function ensureSessionListTraceProjections(
  prisma: DesktopPrisma,
  ids: string[],
  buildProjection: BuildProjection,
  now: () => string = () => new Date().toISOString()
): Promise<void> {
  const current = await prisma.read((reader) =>
    readSessionListTraceProjections(reader, ids)
  );
  for (const sessionId of ids) {
    if (current.has(sessionId)) {
      continue;
    }
    await prisma.write((writer) =>
      writer.$transaction(async (tx) => {
        const statusRows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
          "SELECT status FROM sessions WHERE id = $1",
          sessionId
        );
        if (statusRows[0]?.status === SESSION_STATUS.ACTIVE) {
          return;
        }
        const rechecked = await readSessionListTraceProjections(tx, [
          sessionId,
        ]);
        if (rechecked.has(sessionId)) {
          return;
        }
        const projection = await buildProjection(tx, sessionId);
        if (!projection) {
          return;
        }
        await tx.$executeRawUnsafe(
          `INSERT INTO session_list_trace_projection
             (session_id, revision, payload, updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT(session_id) DO UPDATE SET
             revision = excluded.revision,
             payload = excluded.payload,
             updated_at = excluded.updated_at`,
          sessionId,
          SESSION_LIST_TRACE_PROJECTION_REVISION,
          JSON.stringify(projection),
          now()
        );
      })
    );
  }
}

function parseStoredProjection(
  payload: string
): SessionListTraceProjection | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = storedProjectionSchema.safeParse(decoded);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}
