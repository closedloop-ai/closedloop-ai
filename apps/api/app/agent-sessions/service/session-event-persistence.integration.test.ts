/**
 * ISS-10168: a real-Postgres proof that one session's events persist past the
 * argument ceiling that used to kill this lane.
 *
 * The unit suites beside this file drive `persistSessionChildren` against a
 * mocked `$executeRawUnsafe`, so they observe the arguments the production code
 * BUILDS. They cannot observe the half that actually decided whether a large
 * session ingested: a mock accepts a spread of any width, while the real call
 * threw a synchronous `RangeError` once the flattened values crossed V8's
 * maximum argument count — at six per event, a 20,000-event session asked for
 * 120,000 arguments and died in ~50 ms before reaching the database.
 *
 * {@link EVENT_COUNT} is the reporting lane's measured failure point, not a
 * round number chosen for comfort: 10,000 events (60,000 arguments) still
 * succeeded, and 20,000 was the hard throw. A fixture below that is green
 * against the unfixed code and proves nothing.
 *
 * IDENTITY, NOT ONLY COUNT. A chunk loop can produce the right number of rows
 * and still be wrong in ways a count cannot see — a per-chunk placeholder offset
 * that does not reset writes every chunk's values against chunk 0's positions,
 * and a dropped final partial slice loses the tail. So every persisted row is
 * reconciled against the identity its own `externalEventId` implies, and the
 * rows sitting either side of each chunk boundary are named explicitly.
 */
import { randomUUID } from "node:crypto";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { desktopAgentSessionsPayloadObjectSchema } from "@/lib/desktop-agent-sessions-schema";
import { POSTGRES_MAX_ACCEPTED_VERBATIM_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";
import { agentSessionsService } from "../service";
import {
  AGENT_SESSION_EVENT_BIND_PARAMETERS_PER_ROW,
  AGENT_SESSION_EVENT_INSERT_CHUNK_SIZE,
} from "./session-event-persistence";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

/** The measured failure point: 20,000 events is 120,000 spread arguments. */
const EVENT_COUNT = 20_000;

const EXTERNAL_SESSION_ID = "iss10168-argument-ceiling-session";
const AGENT_EXTERNAL_ID = "iss10168-agent";
const STARTED_AT = "2026-09-14T12:00:00.000Z";
const UPDATED_AT = "2026-09-14T12:30:00.000Z";
const EVENT_EPOCH_MS = Date.parse(STARTED_AT);

/** One event's identity, derived from its index so a round-trip is checkable. */
function expectedEventAt(index: number): {
  agentExternalId: string;
  eventCreatedAt: Date;
  eventType: string;
  externalEventId: string;
  toolName: string | null;
} {
  const isToolUse = index % 2 === 1;
  return {
    agentExternalId: `${AGENT_EXTERNAL_ID}-${index % 3}`,
    // Distinct per event, so a row written against another row's placeholder
    // positions carries a timestamp that cannot be confused for its own.
    eventCreatedAt: new Date(EVENT_EPOCH_MS + index * 1000),
    eventType: isToolUse ? "tool_use" : "message",
    externalEventId: `${EXTERNAL_SESSION_ID}-event-${index}`,
    toolName: isToolUse ? `Tool-${index % 7}` : null,
  };
}

function buildEvents(): SyncedAgentSession["events"] {
  return Array.from({ length: EVENT_COUNT }, (_, index) => {
    const expected = expectedEventAt(index);
    return {
      agentExternalId: expected.agentExternalId,
      createdAt: expected.eventCreatedAt.toISOString(),
      eventType: expected.eventType,
      externalEventId: expected.externalEventId,
      toolName: expected.toolName,
    };
  });
}

function buildPayload(): DesktopAgentSessionsPayload {
  const session: SyncedAgentSession = {
    agents: [
      {
        externalAgentId: `${AGENT_EXTERNAL_ID}-0`,
        name: "Implementation worker",
        status: "completed",
        type: "main",
      },
    ],
    cwd: "/tmp/iss10168",
    endedAt: UPDATED_AT,
    events: buildEvents(),
    externalSessionId: EXTERNAL_SESSION_ID,
    harness: "claude",
    model: "claude-opus-5",
    name: "ISS-10168 argument ceiling",
    startedAt: STARTED_AT,
    status: "completed",
    tokenUsageByModel: [],
    updatedAt: UPDATED_AT,
  };
  const payload = {
    batchId: randomUUID(),
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    sessionCount: 1,
    sessions: [session],
    syncMode: AgentSessionSyncMode.Incremental,
  } satisfies DesktopAgentSessionsPayload;
  // A cardinality this large must be legal at the WIRE boundary too, not merely
  // accepted by the service: the events array is deliberately unbounded
  // (ISS-8051 — a Zod `.max()` rejects rather than truncates), so a re-introduced
  // cap would fail here rather than silently shrinking the fixture.
  const parsed = desktopAgentSessionsPayloadObjectSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `invalid ISS-10168 payload: ${JSON.stringify(parsed.error.issues)}`
    );
  }
  return payload;
}

function readPersistedEvents(computeTargetId: string) {
  return withDb(async (db) => {
    const sessionRows = await db.sessionDetail.findMany({
      select: { artifactId: true },
      where: { computeTargetId },
    });
    const events = await db.agentSessionEvent.findMany({
      select: {
        agentExternalId: true,
        eventCreatedAt: true,
        eventType: true,
        externalEventId: true,
        toolName: true,
      },
      where: {
        agentSessionId: { in: sessionRows.map((row) => row.artifactId) },
      },
    });
    return { events, sessionCount: sessionRows.length };
  });
}

async function cleanupOrganization(organizationId: string): Promise<void> {
  await withDb(async (db) => {
    const artifacts = await db.artifact.findMany({
      select: { id: true },
      where: { organizationId },
    });
    const artifactIds = artifacts.map((artifact) => artifact.id);
    await db.agentSessionEvent.deleteMany({
      where: { agentSessionId: { in: artifactIds } },
    });
    await db.agentSessionUsageRollup.deleteMany({
      where: { artifactId: { in: artifactIds } },
    });
    await db.sessionDetail.deleteMany({
      where: { artifactId: { in: artifactIds } },
    });
    await db.artifact.deleteMany({ where: { id: { in: artifactIds } } });
    await db.computeTarget.deleteMany({ where: { organizationId } });
    await db.user.deleteMany({ where: { organizationId } });
    await db.organization.deleteMany({ where: { id: organizationId } });
  });
}

describeIfDb("session event persistence past the argument ceiling", () => {
  let organizationId: string | null = null;

  afterEach(async () => {
    if (organizationId) {
      await cleanupOrganization(organizationId);
      organizationId = null;
    }
  });

  it("persists every event of a session past the ceiling, by identity", async () => {
    // The fixture must exceed the bound, or the assertions below pass against an
    // unchunked write too.
    expect(EVENT_COUNT).toBeGreaterThan(AGENT_SESSION_EVENT_INSERT_CHUNK_SIZE);

    organizationId = await createTestOrganization();
    const user = await createTestUser(organizationId);
    const computeTarget = await withDb((db) =>
      db.computeTarget.create({
        data: {
          machineName: "iss10168-argument-ceiling",
          organizationId: organizationId as string,
          platform: "darwin",
          userId: user.id,
        },
        select: { id: true },
      })
    );

    await agentSessionsService.upsertSessions(
      {
        computeTargetId: computeTarget.id,
        organizationId,
        userId: user.id,
      },
      buildPayload()
    );

    const persisted = await readPersistedEvents(computeTarget.id);
    expect(persisted.sessionCount).toBe(1);
    expect(persisted.events).toHaveLength(EVENT_COUNT);

    const byExternalId = new Map(
      persisted.events.map((event) => [event.externalEventId, event])
    );
    // Distinct ids, so the length above cannot be met by a duplicated row.
    expect(byExternalId.size).toBe(EVENT_COUNT);

    // Every row reconciled against the identity its own id implies. Collected
    // and asserted as a whole so a failure names the offending rows instead of
    // stopping at the first.
    const mismatched: string[] = [];
    for (let index = 0; index < EVENT_COUNT; index += 1) {
      const expected = expectedEventAt(index);
      const actual = byExternalId.get(expected.externalEventId);
      if (
        actual?.agentExternalId !== expected.agentExternalId ||
        actual?.eventType !== expected.eventType ||
        actual?.toolName !== expected.toolName ||
        actual?.eventCreatedAt.getTime() !== expected.eventCreatedAt.getTime()
      ) {
        mismatched.push(expected.externalEventId);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("re-syncing the same session stays idempotent across chunk boundaries", async () => {
    organizationId = await createTestOrganization();
    const user = await createTestUser(organizationId);
    const computeTarget = await withDb((db) =>
      db.computeTarget.create({
        data: {
          machineName: "iss10168-argument-ceiling-resync",
          organizationId: organizationId as string,
          platform: "darwin",
          userId: user.id,
        },
        select: { id: true },
      })
    );
    const context = {
      computeTargetId: computeTarget.id,
      organizationId,
      userId: user.id,
    };

    await agentSessionsService.upsertSessions(context, buildPayload());
    await agentSessionsService.upsertSessions(context, buildPayload());

    const persisted = await readPersistedEvents(computeTarget.id);
    // The ON CONFLICT target is (agent_session_id, external_event_id), which a
    // chunked write splits across several statements. A second delivery must
    // still collapse onto the same rows rather than duplicating the tail.
    expect(persisted.events).toHaveLength(EVENT_COUNT);

    const boundaryIndexes = [
      0,
      AGENT_SESSION_EVENT_INSERT_CHUNK_SIZE - 1,
      AGENT_SESSION_EVENT_INSERT_CHUNK_SIZE,
      EVENT_COUNT - 1,
    ];
    const byExternalId = new Map(
      persisted.events.map((event) => [event.externalEventId, event])
    );
    for (const index of boundaryIndexes) {
      const expected = expectedEventAt(index);
      expect(byExternalId.get(expected.externalEventId)).toMatchObject({
        agentExternalId: expected.agentExternalId,
        eventType: expected.eventType,
        toolName: expected.toolName,
      });
    }
  });
});

// Outside `describeIfDb` on purpose: this case is arithmetic over two exported
// constants and touches no database, so gating it on DATABASE_URL would leave
// the only guard on the chunk bound running nowhere in a DB-less run.
describe("session event INSERT chunk bound", () => {
  it("keeps one statement within the verbatim bind ceiling, and at least one row wide", () => {
    const widestStatementBindParameters =
      AGENT_SESSION_EVENT_INSERT_CHUNK_SIZE *
      AGENT_SESSION_EVENT_BIND_PARAMETERS_PER_ROW;
    // The VERBATIM member of the pair: `$executeRawUnsafe` passes the statement
    // through uninspected, so it meets the wire's limit, not Prisma's own
    // per-statement budget. The ACCEPTED member, because the question is how
    // wide a statement may be — the ISS-8185 fencepost.
    expect(widestStatementBindParameters).toBeLessThanOrEqual(
      POSTGRES_MAX_ACCEPTED_VERBATIM_BIND_PARAMETERS
    );
    // The argument count ISS-10168 overflowed is this plus the SQL string, so
    // bounding the parameters bounds the spread with it.
    expect(widestStatementBindParameters + 1).toBeLessThanOrEqual(
      POSTGRES_MAX_ACCEPTED_VERBATIM_BIND_PARAMETERS
    );
    // Floors at one row, so a row that somehow costs more than the whole budget
    // still makes progress rather than emitting empty statements forever.
    expect(AGENT_SESSION_EVENT_INSERT_CHUNK_SIZE).toBeGreaterThanOrEqual(1);
  });
});
