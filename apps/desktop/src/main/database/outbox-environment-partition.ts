/**
 * @file outbox-environment-partition.ts
 * @description ISS-7096: hydration-time maintenance that keeps a
 * multi-environment device's session outbox partitioned by owning environment
 * (successor to ISS-7007's adoption pass). The oracle is the SESSION's stamped
 * identity pair — row ownership proves where a ROW may sync, never which
 * environment a KEY belongs to (pre-M3 pollution makes a key's rows a mixed
 * population). One pass, three moves, nothing hard-dropped: owned rows ADOPT
 * onto the live key (budget restarts), foreign-owned rows PARK under
 * `<lanePrefix>:parked:<owner org>` (inert until their owner signs in),
 * NULL-owner/absent rows are LEFT for the ISS-6168 boot claim. A parked key
 * parses with `:parked` folded into its lane prefix, which keeps it out of the
 * retired-key walk; only the M5 legacy sweep strips the segment so a revision
 * bump re-dispositions old parked partitions instead of stranding them.
 */
import { OutboxStatus } from "../../shared/sync-lane-contract.js";
import type { AgentSessionOutboxAdoption } from "../agent-sync/agent-session-sync-source.js";
import { splitAgentSessionSyncSourceKey } from "../agent-sync/agent-session-sync-source.js";
import {
  isForeignOwnedSession,
  type SignedInUserIdentity,
} from "../util/user-identity.js";
import { recordComputeTargetEnvironment } from "./compute-target-environment-store.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { WriteQueueClass } from "./write-queue.js";

/** The key segment that marks a parked partition. */
export const PARKED_OUTBOX_KEY_SEGMENT = "parked" as const;

/** The parked partition for one owning org under one lane prefix. */
export function buildParkedOutboxKey(
  lanePrefix: string,
  organizationId: string
): string {
  return `${lanePrefix}:${PARKED_OUTBOX_KEY_SEGMENT}:${organizationId}`;
}

/** The lane-prefix suffix a parked key parses with (the split folds `:parked` in). */
const PARKED_LANE_PREFIX_SUFFIX = `:${PARKED_OUTBOX_KEY_SEGMENT}`;

type OutboxRowRef = {
  sourceKey: string;
  externalSessionId: string;
  syncClass: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  /**
   * ISS-7730: the lane-wide stall clock. Carried because PARKING is storage,
   * not a verdict — a row mid-stall that is re-keyed must not restart the only
   * bound its lane-wide failures have, or a repartition silently doubles the
   * effective ceiling. Adoption deliberately does NOT carry it: that path is a
   * full budget reset, so a fresh clock is the correct answer there.
   */
  laneStalledSince: string | null;
  pendingSince: string | null;
  createdAt: string;
};

type SessionOwnerRow = {
  id: string;
  userId: string | null;
  organizationId: string | null;
};

/**
 * The one hydration-time maintenance entry point for the session lane's durable
 * outbox. See the file doc for the three moves. `environmentKey` is the
 * normalized apiOrigin of the ACTIVE saved config (null when unknown — nothing
 * is recorded, everything else still runs).
 *
 * Never throws through to the caller's hydration — the renderer-side
 * orchestrator (`adopt-stranded-outbox-rows.ts`) wraps it — but it also never
 * swallows internally: a failed write aborts the pass with rows still owed, and
 * the next hydration re-attempts.
 */
export async function sqliteMaintainOutboxEnvironmentPartition(
  prisma: DesktopPrisma,
  sourceKey: string,
  identity: SignedInUserIdentity,
  environmentKey: string | null
): Promise<AgentSessionOutboxAdoption> {
  const empty: AgentSessionOutboxAdoption = {
    adoptedIds: [],
    declined: 0,
    skippedAlreadyLive: 0,
    retiredSourceKeys: 0,
    parkedRows: 0,
  };
  const lane = splitAgentSessionSyncSourceKey(sourceKey);
  if (!lane) {
    return empty;
  }
  if (environmentKey) {
    await recordComputeTargetEnvironment(
      prisma,
      lane.computeTargetId,
      environmentKey
    );
  }
  const parkedKey = buildParkedOutboxKey(
    lane.lanePrefix,
    identity.organizationId
  );
  // cr-81036: ONE distinct-key scan feeds both classifications below — the
  // retired and legacy walks used to issue the identical query back to back.
  const nonLiveKeys = await readNonLivePendingSourceKeys(prisma, sourceKey);
  const retiredKeys = filterRetiredSourceKeys(nonLiveKeys, lane);
  // ISS-7096 M5: keys of a SUPERSEDED payload revision — the active lane
  // prefix extends theirs (`agent_sessions` →
  // `agent_sessions:monitored_activity_v2`). Their pending rows predate the
  // revision bump; the first-capable-connection replay re-covers the same
  // sessions, so a row whose session already has ANY row in the active
  // revision's keyspace is a superseded duplicate to delete, and the rest
  // disposition exactly like retired-key rows (the payload is rebuilt from
  // source at send time, so an adopted legacy enqueue is still deliverable).
  const legacyKeys = filterLegacyRevisionKeys(nonLiveKeys, lane);
  const candidateKeys = [...retiredKeys, ...legacyKeys, parkedKey, sourceKey];
  const candidates = await prisma.client.agentSessionSyncOutbox.findMany({
    where: { sourceKey: { in: candidateKeys }, status: OutboxStatus.Pending },
    select: {
      sourceKey: true,
      externalSessionId: true,
      syncClass: true,
      attemptCount: true,
      nextAttemptAt: true,
      lastError: true,
      laneStalledSince: true,
      pendingSince: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  if (candidates.length === 0) {
    return { ...empty, retiredSourceKeys: retiredKeys.length };
  }
  const owners = await readSessionOwners(
    prisma,
    candidates.map((row) => row.externalSessionId)
  );
  const legacyKeySet = new Set(legacyKeys);
  const legacyCandidates = candidates.filter((row) =>
    legacyKeySet.has(row.sourceKey)
  );
  const supersededIds = await readActiveRevisionCoverage(
    prisma,
    lane.lanePrefix,
    legacyCandidates.map((row) => row.externalSessionId)
  );

  const { adoptable, parkable, superseded, declined } = partitionCandidateRows({
    candidates,
    owners,
    identity,
    sourceKey,
    lanePrefix: lane.lanePrefix,
    legacyKeySet,
    supersededIds,
  });

  const adoptedIds = await adoptRows(prisma, sourceKey, adoptable, [
    ...retiredKeys,
    ...legacyKeys,
    parkedKey,
  ]);
  const parkedRows = await parkRows(prisma, parkable);
  await deleteSupersededRows(prisma, superseded);
  return {
    adoptedIds,
    declined,
    skippedAlreadyLive:
      dedupeOldestPerSession(adoptable).size - adoptedIds.length,
    retiredSourceKeys: retiredKeys.length,
    parkedRows,
  };
}

/**
 * The one classification pass: every candidate row lands in exactly one of
 * adopt / park / superseded-delete / leave. See the file doc for the rules.
 */
function partitionCandidateRows(input: {
  candidates: OutboxRowRef[];
  owners: Map<string, SessionOwnerRow>;
  identity: SignedInUserIdentity;
  sourceKey: string;
  lanePrefix: string;
  legacyKeySet: Set<string>;
  supersededIds: Set<string>;
}): {
  adoptable: OutboxRowRef[];
  parkable: Map<string, OutboxRowRef[]>;
  superseded: OutboxRowRef[];
  declined: number;
} {
  const adoptable: OutboxRowRef[] = [];
  const parkable = new Map<string, OutboxRowRef[]>();
  const superseded: OutboxRowRef[] = [];
  let declined = 0;
  for (const row of input.candidates) {
    if (
      input.legacyKeySet.has(row.sourceKey) &&
      input.supersededIds.has(row.externalSessionId)
    ) {
      // The active revision already accounts for this session — whatever its
      // verdict there (pending, parked, dead-lettered, or acked-and-cleared
      // covered by a newer row), the legacy copy is a duplicate, not owed work.
      superseded.push(row);
      continue;
    }
    const owner = input.owners.get(row.externalSessionId);
    const ownedBySignedIn =
      owner !== undefined &&
      owner.userId === input.identity.userId &&
      owner.organizationId === input.identity.organizationId;
    if (ownedBySignedIn) {
      if (row.sourceKey !== input.sourceKey) {
        adoptable.push(row);
      }
      // Owned rows already under the live key are the lane's normal work.
      continue;
    }
    if (isForeignOwnedSession(owner, input.identity)) {
      const destination = buildParkedOutboxKey(
        input.lanePrefix,
        owner.organizationId
      );
      if (row.sourceKey !== destination) {
        const group = parkable.get(destination) ?? [];
        group.push(row);
        parkable.set(destination, group);
      }
      continue;
    }
    // Locally-absent session or NULL-owner pair: leave in place. Only rows
    // OUTSIDE the live key are "owed but unmovable" — the live key's own
    // unstamped rows are normal work, not a decline.
    if (row.sourceKey !== input.sourceKey) {
      declined += 1;
    }
  }
  return { adoptable, parkable, superseded, declined };
}

/**
 * Session-lane keys for a device/registration that is no longer the live one.
 * Parked keys never match: their parsed lane prefix carries the `:parked`
 * segment, so the equality below excludes them by construction.
 */
function filterRetiredSourceKeys(
  keys: readonly string[],
  lane: { lanePrefix: string; computeTargetId: string }
): string[] {
  return keys.filter((candidate) => {
    const parsed = splitAgentSessionSyncSourceKey(candidate);
    return (
      parsed !== null &&
      parsed.lanePrefix === lane.lanePrefix &&
      parsed.computeTargetId !== lane.computeTargetId
    );
  });
}

/**
 * cr-81036: the single distinct-key scan behind both key classifications —
 * every OTHER source key that still holds pending rows.
 */
async function readNonLivePendingSourceKeys(
  prisma: DesktopPrisma,
  sourceKey: string
): Promise<string[]> {
  const rows = await prisma.client.agentSessionSyncOutbox.findMany({
    where: { status: OutboxStatus.Pending, sourceKey: { not: sourceKey } },
    select: { sourceKey: true },
    distinct: ["sourceKey"],
  });
  return rows.map((row) => row.sourceKey);
}

/**
 * ISS-7096 M5: keys whose lane prefix the ACTIVE lane prefix properly extends
 * — a superseded payload revision of the same source kind. A parked key
 * parses with `:parked` folded into its lane prefix, so the comparison strips
 * that segment first: a superseded revision's parked partition is swept
 * forward on the revision bump — adopted, re-parked under the active prefix,
 * or deleted as superseded — rather than stranded forever (cr-81036). A
 * CURRENT-revision parked key strips back to the active prefix itself and
 * stays excluded. When the active lane IS the base revision there is nothing
 * to match.
 */
function filterLegacyRevisionKeys(
  keys: readonly string[],
  lane: { lanePrefix: string; computeTargetId: string }
): string[] {
  return keys.filter((candidate) => {
    const parsed = splitAgentSessionSyncSourceKey(candidate);
    if (parsed === null) {
      return false;
    }
    const revisionPrefix = parsed.lanePrefix.endsWith(PARKED_LANE_PREFIX_SUFFIX)
      ? parsed.lanePrefix.slice(0, -PARKED_LANE_PREFIX_SUFFIX.length)
      : parsed.lanePrefix;
    return (
      revisionPrefix !== lane.lanePrefix &&
      lane.lanePrefix.startsWith(`${revisionPrefix}:`)
    );
  });
}

/**
 * Which of `sessionIds` already have ANY outbox row (any status) in the ACTIVE
 * revision's keyspace — a live/retired target key or a parked partition, all of
 * which start with the active lane prefix.
 */
async function readActiveRevisionCoverage(
  prisma: DesktopPrisma,
  activeLanePrefix: string,
  sessionIds: string[]
): Promise<Set<string>> {
  const covered = new Set<string>();
  for (const chunk of chunkForBind(sessionIds)) {
    const rows = await prisma.client.agentSessionSyncOutbox.findMany({
      where: { externalSessionId: { in: chunk } },
      select: { sourceKey: true, externalSessionId: true },
    });
    for (const row of rows) {
      if (row.sourceKey.startsWith(`${activeLanePrefix}:`)) {
        covered.add(row.externalSessionId);
      }
    }
  }
  return covered;
}

/**
 * ISS-7096 M5: the one deliberate deletion this module performs, scoped to the
 * exact `(key, id)` pairs proved superseded, `pending` only. Everything else
 * in this module re-keys; nothing is ever deleted without active-revision
 * coverage standing in for it.
 */
async function deleteSupersededRows(
  prisma: DesktopPrisma,
  superseded: OutboxRowRef[]
): Promise<void> {
  if (superseded.length === 0) {
    return;
  }
  const idsByKey = new Map<string, string[]>();
  for (const row of superseded) {
    const ids = idsByKey.get(row.sourceKey) ?? [];
    ids.push(row.externalSessionId);
    idsByKey.set(row.sourceKey, ids);
  }
  await prisma.write(
    async (client) => {
      for (const [key, ids] of idsByKey) {
        for (const chunk of chunkForBind(ids)) {
          await client.agentSessionSyncOutbox.deleteMany({
            where: {
              sourceKey: key,
              externalSessionId: { in: chunk },
              status: OutboxStatus.Pending,
            },
          });
        }
      }
    },
    undefined,
    { class: WriteQueueClass.Bulk }
  );
}

/**
 * cr-81036: every unbounded id list that reaches an `IN (...)` in this module
 * is chunked — a first-launch backfill can put thousands of pending rows under
 * the live key, and an unchunked list risks libSQL's bind-variable ceiling.
 * The pass degrades to more queries, never to a bind-parameter error.
 */
const ID_CHUNK_SIZE = 400;

/** The serialized-write-turn client `DesktopPrisma.write` hands its callback. */
type OutboxWriteClient = Parameters<Parameters<DesktopPrisma["write"]>[0]>[0];

/**
 * Delete every source copy of every parked id — batched per origin key,
 * `pending` only, so an in-flight transition or a dead-letter verdict is
 * never swept.
 */
async function deletePendingSourceCopies(
  client: OutboxWriteClient,
  rows: OutboxRowRef[]
): Promise<void> {
  const idsByOriginKey = new Map<string, string[]>();
  for (const row of rows) {
    const originIds = idsByOriginKey.get(row.sourceKey) ?? [];
    originIds.push(row.externalSessionId);
    idsByOriginKey.set(row.sourceKey, originIds);
  }
  for (const [originKey, originIds] of idsByOriginKey) {
    for (const chunk of chunkForBind(originIds)) {
      await client.agentSessionSyncOutbox.deleteMany({
        where: {
          sourceKey: originKey,
          externalSessionId: { in: chunk },
          status: OutboxStatus.Pending,
        },
      });
    }
  }
}

function chunkForBind<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += ID_CHUNK_SIZE) {
    chunks.push(items.slice(index, index + ID_CHUNK_SIZE));
  }
  return chunks;
}

/** Owner pairs for `ids`; an absent session simply has no entry. */
async function readSessionOwners(
  prisma: DesktopPrisma,
  ids: string[]
): Promise<Map<string, SessionOwnerRow>> {
  const owners = new Map<string, SessionOwnerRow>();
  for (const chunk of chunkForBind(ids)) {
    const rows = await prisma.client.session.findMany({
      where: { id: { in: chunk } },
      select: { id: true, userId: true, organizationId: true },
    });
    for (const row of rows) {
      owners.set(row.id, row);
    }
  }
  return owners;
}

/** ONE row per session id, oldest `createdAt` first — ISS-7007's tie-break. */
function dedupeOldestPerSession(
  rows: OutboxRowRef[]
): Map<string, OutboxRowRef> {
  const byId = new Map<string, OutboxRowRef>();
  for (const row of rows) {
    if (!byId.has(row.externalSessionId)) {
      byId.set(row.externalSessionId, row);
    }
  }
  return byId;
}

/**
 * ISS-7007's adoption write, verbatim in shape: read the live key INSIDE the
 * serialized write callback, insert only ids it does not already know (a
 * dead-letter there stays decided), then delete every source copy — including
 * the `alreadyLive` duplicates, whose retired copy duplicates a decision the
 * live lane already made. Budget restarts on adoption.
 */
async function adoptRows(
  prisma: DesktopPrisma,
  sourceKey: string,
  adoptable: OutboxRowRef[],
  deletableKeys: string[]
): Promise<string[]> {
  if (adoptable.length === 0) {
    return [];
  }
  const byId = dedupeOldestPerSession(adoptable);
  const adoptableIds = [...byId.keys()];
  const now = new Date().toISOString();
  let adoptedIds: string[] = [];
  await prisma.write(
    async (client) => {
      const alreadyLive = new Set<string>();
      for (const chunk of chunkForBind(adoptableIds)) {
        const existing = await client.agentSessionSyncOutbox.findMany({
          where: { sourceKey, externalSessionId: { in: chunk } },
          select: { externalSessionId: true },
        });
        for (const row of existing) {
          alreadyLive.add(row.externalSessionId);
        }
      }
      const inserts = [...byId.values()].filter(
        (row) => !alreadyLive.has(row.externalSessionId)
      );
      for (const insertChunk of chunkForBind(inserts)) {
        await client.agentSessionSyncOutbox.createMany({
          data: insertChunk.map((row) => ({
            sourceKey,
            externalSessionId: row.externalSessionId,
            status: OutboxStatus.Pending,
            syncClass: row.syncClass,
            attemptCount: 0,
            nextAttemptAt: null,
            lastError: null,
            pendingSince: now,
            createdAt: now,
            updatedAt: now,
          })),
        });
      }
      for (const chunk of chunkForBind(adoptableIds)) {
        await client.agentSessionSyncOutbox.deleteMany({
          where: {
            sourceKey: { in: deletableKeys },
            externalSessionId: { in: chunk },
            status: OutboxStatus.Pending,
          },
        });
      }
      // After BOTH statements: a throw above must report nothing rather than a
      // move that did not happen.
      adoptedIds = inserts.map((row) => row.externalSessionId);
    },
    undefined,
    { class: WriteQueueClass.Bulk }
  );
  return adoptedIds;
}

/**
 * Re-key foreign-owned rows into their owning org's parked partition. Same
 * insert-then-delete crash discipline as adoption; a crash between the two
 * leaves a duplicate the NEXT pass deletes at its `alreadyParked` skip. The
 * row's budget and history travel with it — parking is storage, not a verdict.
 */
async function parkRows(
  prisma: DesktopPrisma,
  parkable: Map<string, OutboxRowRef[]>
): Promise<number> {
  let parked = 0;
  for (const [destination, rows] of parkable) {
    const byId = dedupeOldestPerSession(rows);
    const ids = [...byId.keys()];
    const now = new Date().toISOString();
    await prisma.write(
      async (client) => {
        const alreadyParked = new Set<string>();
        for (const chunk of chunkForBind(ids)) {
          const existing = await client.agentSessionSyncOutbox.findMany({
            where: {
              sourceKey: destination,
              externalSessionId: { in: chunk },
            },
            select: { externalSessionId: true },
          });
          for (const row of existing) {
            alreadyParked.add(row.externalSessionId);
          }
        }
        const inserts = [...byId.values()].filter(
          (row) => !alreadyParked.has(row.externalSessionId)
        );
        for (const insertChunk of chunkForBind(inserts)) {
          await client.agentSessionSyncOutbox.createMany({
            data: insertChunk.map((row) => ({
              sourceKey: destination,
              externalSessionId: row.externalSessionId,
              status: OutboxStatus.Pending,
              syncClass: row.syncClass,
              attemptCount: row.attemptCount,
              nextAttemptAt: row.nextAttemptAt,
              lastError: row.lastError,
              // ISS-7730: history travels with the row, per this function's
              // contract; dropping it would hand the parked copy a fresh 24h
              // ceiling it has not earned.
              laneStalledSince: row.laneStalledSince,
              pendingSince: row.pendingSince,
              createdAt: row.createdAt,
              updatedAt: now,
            })),
          });
        }
        await deletePendingSourceCopies(client, rows);
        parked += inserts.length;
      },
      undefined,
      { class: WriteQueueClass.Bulk }
    );
  }
  return parked;
}
