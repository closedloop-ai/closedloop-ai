/**
 * Shared integration-test fixtures for the chunked agent-session sync suites
 * (`__tests__/integration/chunked-sync-repair.integration.test.ts` and
 * `chunked-sync-atomic-apply.integration.test.ts`). Both drive the REAL cloud
 * ingress contract (`parseDesktopAgentSessionsPayload` +
 * `agentSessionsService.upsertSessions`) against Postgres and read the persisted
 * `agent_session_events` + revision/marker columns back directly, so atomicity
 * and repair are proven by the STORE, not by logs.
 *
 * Parameterized by external session id / display name / batch id so each suite
 * keeps its own identity while sharing the chunk builder, ingress helper,
 * compute-target factory, and persisted-state reader.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { parseDesktopAgentSessionsPayload } from "@/lib/desktop-agent-sessions-schema";

export type ChunkMeta = { index: number; total: number };

export type ChunkSyncContext = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
};

export type PersistedChunkState = {
  eventIds: string[];
  dataRevision: number | null;
  pendingChunkRevision: number | null;
  pendingChunkTotal: number | null;
  pendingChunkReceived: number | null;
};

/** Build `evt-0 … evt-(count-1)` external event ids. */
export function buildEventIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `evt-${i}`);
}

/**
 * Build one chunk of an oversized session. Every chunk replicates the session
 * metadata + revision (as the desktop chunker does) and carries a disjoint slice
 * of the event ids plus its `{ index, total }` marker.
 *
 * ISS-8131 made `chunk` and `dataRevision` optional so the same builder can
 * express the UNCHUNKED, revision-less whole-session payload an older desktop
 * sends. Both are omitted from the built object when absent, never emitted as
 * `undefined`.
 */
export function buildSessionChunk(params: {
  externalSessionId: string;
  name: string;
  eventIds: string[];
  /** Omit for an UNCHUNKED whole-session payload (ISS-8131). */
  chunk?: ChunkMeta | null;
  /**
   * Omit for a payload that carries NO `dataRevision` — the `.nullish()` wire
   * shape an older desktop sends (ISS-8131). The key is left off the built
   * object entirely rather than set to `undefined`, so the payload is a genuine
   * omission on the wire.
   *
   * Passing `null` MEANS omit and builds the same object — this helper cannot
   * express an explicit `"dataRevision": null` on the wire, which `.nullish()`
   * also accepts. No behavioural gap today (every consumer tests `== null`),
   * but do not read a null-passing case as coverage of the explicit-null shape.
   */
  dataRevision?: number | null;
  /**
   * ISS-10259: the tiling stream, paginated independently of the events one.
   * OMITTED when absent, because an absent key and an explicit `[]` mean
   * different things to the receiver — the first leaves the stored tiling
   * alone, the second is the clear `createChunkBuilders.baseFor` stamps on
   * every non-tiling chunk of a paginated tiling. A caller that wants the clear
   * must pass `[]` explicitly.
   */
  activitySegmentRows?: readonly Record<string, unknown>[];
}): Record<string, unknown> {
  return {
    externalSessionId: params.externalSessionId,
    name: params.name,
    status: "active",
    harness: "claude",
    cwd: "/tmp/wt",
    model: "claude-opus-4",
    startedAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    ...(params.dataRevision == null
      ? {}
      : { dataRevision: params.dataRevision }),
    ...(params.chunk == null ? {} : { chunk: params.chunk }),
    ...(params.activitySegmentRows === undefined
      ? {}
      : { activitySegmentRows: params.activitySegmentRows }),
    agents: [],
    events: params.eventIds.map((externalEventId) => ({
      externalEventId,
      eventType: "ToolUse",
      toolName: "Read",
      createdAt: "2026-06-10T10:30:00.000Z",
    })),
    tokenUsageByModel: [],
  };
}

/**
 * Push one built chunk through the real cloud ingress contract and apply it. A
 * fixture build error (payload rejected by the parser) is a thrown Error, not a
 * product assertion, so this helper does no `expect` — the suites own the
 * behavioural assertions.
 *
 * Resolves to the batch's `persistedSessionIds` — the SERVER-TRUTH ack echo the
 * desktop outbox clears its row on. A chunk the gate skipped as foreign reports
 * `persisted: false` and is withheld from that list, so a suite can assert the
 * outbox actually drains rather than inferring it from the stored rows.
 */
export async function ingestChunk(
  context: ChunkSyncContext,
  batchId: string,
  chunk: Record<string, unknown>,
  // ISS-4754: both envelope fields this helper used to hardcode are now
  // overridable, because the golden corpus declares different ones — its frozen
  // fixtures carry their own `schemaVersion` and are ingested as `Backfill`,
  // whereas the synthetic chunk suites are v-current `Incremental`. Additive and
  // defaulted, so every existing caller keeps its exact previous wire shape.
  envelope: {
    schemaVersion?: number;
    syncMode?: AgentSessionSyncMode;
    /**
     * ISS-8131: opt into the row-level ack (build #4862 and newer). OMITTED by
     * default, which is the pre-#4862 shape every caller before this parameter
     * existed was sending — so existing suites keep their exact wire payload.
     *
     * It changes behaviour, not just the echo: a HOLD is only expressible to a
     * client that echoes accepted ids, so the cloud's held arms are reachable
     * ONLY with this set. A suite that leaves it off is testing the legacy
     * client, whatever else it asserts.
     */
    wantsAcceptedSessionIds?: boolean;
  } = {}
): Promise<string[]> {
  const parsed = parseDesktopAgentSessionsPayload({
    schemaVersion: envelope.schemaVersion ?? AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId,
    syncMode: envelope.syncMode ?? AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    ...(envelope.wantsAcceptedSessionIds === undefined
      ? {}
      : { wantsAcceptedSessionIds: envelope.wantsAcceptedSessionIds }),
    sessions: [chunk],
  });
  if (!parsed.ok) {
    throw new Error(
      `payload failed the cloud ingress contract: ${parsed.reason}`
    );
  }
  const { persistedSessionIds } = await agentSessionsService.upsertSessions(
    context,
    parsed.payload
  );
  return persistedSessionIds;
}

/** Create a compute target for the org/user under test. */
export async function createComputeTarget(
  organizationId: string,
  userId: string,
  machineName: string
): Promise<string> {
  const target = await withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName,
        platform: "darwin",
      },
      select: { id: true },
    })
  );
  return target.id;
}

/**
 * Read the persisted event ids + committed revision + staged chunk-sequence
 * marker for a session. Returns `null` when no SessionDetail row exists (e.g. a
 * foreign lone chunk that was skipped before any row was created).
 */
export async function readPersistedChunkState(
  computeTargetId: string,
  externalSessionId: string
): Promise<PersistedChunkState | null> {
  const detail = await withDb((db) =>
    db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: {
        artifactId: true,
        dataRevision: true,
        pendingChunkRevision: true,
        pendingChunkTotal: true,
        pendingChunkReceived: true,
      },
    })
  );
  if (!detail) {
    return null;
  }
  const events = await withDb((db) =>
    db.agentSessionEvent.findMany({
      where: { agentSessionId: detail.artifactId },
      select: { externalEventId: true },
    })
  );
  return {
    eventIds: events.map((e) => e.externalEventId).sort(),
    dataRevision: detail.dataRevision,
    pendingChunkRevision: detail.pendingChunkRevision,
    pendingChunkTotal: detail.pendingChunkTotal,
    pendingChunkReceived: detail.pendingChunkReceived,
  };
}

/**
 * ISS-10259: the stored tiling's `startMs` values for a session, ascending.
 *
 * Resolved through `(computeTargetId, externalSessionId)` rather than a held
 * artifact id ON PURPOSE — the ISS-8604 create-arm race replaces the artifact
 * mid-sequence, and a reader pinned to the pre-sweep id would report the swept
 * row's tiling (i.e. nothing) whatever the new row holds.
 *
 * `null` when the session has no SessionDetail row at all, so an absent row and
 * a stored-but-empty tiling stay distinguishable.
 */
export async function readPersistedTilingStartsMs(
  computeTargetId: string,
  externalSessionId: string
): Promise<number[] | null> {
  const detail = await withDb((db) =>
    db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: { artifactId: true },
    })
  );
  if (!detail) {
    return null;
  }
  const segments = await withDb((db) =>
    db.agentSessionActivitySegment.findMany({
      where: { agentSessionId: detail.artifactId },
      orderBy: { startMs: "asc" },
      select: { startMs: true },
    })
  );
  return segments.map((segment) => Number(segment.startMs));
}
