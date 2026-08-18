/**
 * ISS-4976 (@thadeusb review): regression cover for the invocation-outbox
 * READY-PARTS read and its quarantine.
 *
 * The module had no test at all, which is how it kept a single-scalar version
 * check (`protocolVersion !== AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION`)
 * after the producer started declaring v2 on telemetry-carrying parts. Every one
 * of those parts parsed as `null` on the way back out of the local outbox and
 * was dead-lettered as `invalid_persisted_payload` — a generation lost on the
 * machine that captured it, before the wire, with no peer and no version skew
 * involved.
 *
 * These tests pin BOTH directions, because a loader that accepts everything is
 * as wrong as one that accepts one version: a part this build can produce must
 * survive the round trip, and a version this build cannot interpret must still
 * be quarantined.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS,
  AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
} from "@repo/api/src/types/agent-component-invocation";
import { AgentComponentInvocationSyncLocalError } from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import {
  loadReadyInvocationSyncOutboxParts,
  parseInvocationSyncPart,
} from "../src/main/database/invocation-sync-outbox-parts.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";

const SOURCE_KEY = "agent_sessions:target-1";
const NOW = "2026-08-03T18:00:00.000Z";
/** One past every version this build knows — the "a FUTURE build wrote it" row. */
const UNSUPPORTED_VERSION =
  Math.max(...AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS) + 1;

type OutboxRow = {
  sourceKey: string;
  externalSessionId: string;
  externalGenerationId: string;
  partIndex: number;
  payload: unknown;
  attemptCount: number;
  /** ISS-5973: the ordering key the fairness reservation is measured against. */
  createdAt?: string;
};

type DeadLetterUpdate = {
  status: unknown;
  lastError: unknown;
  partIndexes: number[];
};

describe("invocation sync outbox ready-parts read", () => {
  it("returns a telemetry-carrying part instead of dead-lettering it", async () => {
    // The exact row the producer writes once any item carries telemetry. Before
    // the fix this row never left the machine.
    const harness = outboxHarness([
      outboxRow(
        0,
        part(AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION)
      ),
    ]);

    const entries = await loadReadyInvocationSyncOutboxParts(
      harness.prisma,
      SOURCE_KEY,
      NOW,
      10
    );

    assert.equal(entries.length, 1);
    assert.equal(
      entries[0].part.protocolVersion,
      AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION
    );
    assert.deepEqual(harness.deadLetters, []);
  });

  it("returns a telemetry-free part alongside a telemetry-carrying one", async () => {
    // A drain mixes both versions, because the version is chosen PER PART from
    // its own items. Neither may cost the other its place in the batch.
    const harness = outboxHarness([
      outboxRow(0, part(AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION)),
      outboxRow(
        1,
        part(AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION)
      ),
    ]);

    const entries = await loadReadyInvocationSyncOutboxParts(
      harness.prisma,
      SOURCE_KEY,
      NOW,
      10
    );

    assert.deepEqual(
      entries.map((entry) => entry.part.protocolVersion),
      [
        AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
      ]
    );
    assert.deepEqual(harness.deadLetters, []);
  });

  it("still quarantines a version this build cannot interpret", async () => {
    // The quarantine exists for a reason: a row a FUTURE build wrote in a shape
    // this one does not understand must not be shipped as if it were understood,
    // and must not spin forever either.
    const harness = outboxHarness([outboxRow(0, part(UNSUPPORTED_VERSION))]);

    const entries = await loadReadyInvocationSyncOutboxParts(
      harness.prisma,
      SOURCE_KEY,
      NOW,
      10
    );

    assert.deepEqual(entries, []);
    assert.equal(harness.deadLetters.length, 1);
    assert.deepEqual(harness.deadLetters[0].partIndexes, [0]);
    assert.equal(
      harness.deadLetters[0].lastError,
      AgentComponentInvocationSyncLocalError.InvalidPersistedPayload
    );
  });

  it("still quarantines a structurally corrupt row", async () => {
    const harness = outboxHarness([
      outboxRow(0, {
        ...part(AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION),
        items: "not-an-array",
      }),
    ]);

    const entries = await loadReadyInvocationSyncOutboxParts(
      harness.prisma,
      SOURCE_KEY,
      NOW,
      10
    );

    assert.deepEqual(entries, []);
    assert.deepEqual(harness.deadLetters[0].partIndexes, [0]);
  });

  it("quarantines only the unreadable row in a mixed batch", async () => {
    const harness = outboxHarness([
      outboxRow(
        0,
        part(AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION)
      ),
      outboxRow(1, part(UNSUPPORTED_VERSION)),
      outboxRow(2, part(AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION)),
    ]);

    const entries = await loadReadyInvocationSyncOutboxParts(
      harness.prisma,
      SOURCE_KEY,
      NOW,
      10
    );

    assert.deepEqual(
      entries.map((entry) => entry.part.partIndex),
      [0, 2]
    );
    // One batched write for the whole invalid set, never one per row.
    assert.equal(harness.deadLetters.length, 1);
    assert.deepEqual(harness.deadLetters[0].partIndexes, [1]);
  });
});

describe("parseInvocationSyncPart", () => {
  it("accepts every protocol version this build can produce", () => {
    for (const version of AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS) {
      assert.equal(
        parseInvocationSyncPart(part(version))?.protocolVersion,
        version,
        `version ${version}`
      );
    }
  });

  it("rejects an unsupported, missing, or non-numeric version", () => {
    assert.equal(parseInvocationSyncPart(part(UNSUPPORTED_VERSION)), null);
    assert.equal(parseInvocationSyncPart(part(0)), null);
    assert.equal(
      parseInvocationSyncPart(
        part(String(AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION))
      ),
      null
    );
    assert.equal(parseInvocationSyncPart(part(undefined)), null);
  });

  it("rejects a non-object payload", () => {
    assert.equal(parseInvocationSyncPart(null), null);
    assert.equal(parseInvocationSyncPart([]), null);
    assert.equal(parseInvocationSyncPart("{}"), null);
  });
});

function part(protocolVersion: unknown): Record<string, unknown> {
  return {
    protocolVersion,
    externalSessionId: "session-1",
    externalGenerationId: "generation-1",
    sourceUpdatedAt: "2026-08-03T17:00:00.000Z",
    dataRevision: 1,
    sourceSequence: 1,
    partIndex: 0,
    partCount: 1,
    partHash: "a".repeat(64),
    items: [],
  };
}

function outboxRow(partIndex: number, payload: unknown): OutboxRow {
  return {
    sourceKey: SOURCE_KEY,
    externalSessionId: "session-1",
    externalGenerationId: "generation-1",
    partIndex,
    payload: { ...(payload as Record<string, unknown>), partIndex },
    attemptCount: 0,
  };
}

/**
 * A stand-in for the reader/writer split the loader depends on: `read` serves
 * the pending rows, `write` captures the batched quarantine `updateMany` so a
 * test can assert exactly which rows were dead-lettered and under what error.
 */
function outboxHarness(rows: OutboxRow[]): {
  prisma: Pick<DesktopPrisma, "read" | "write">;
  deadLetters: DeadLetterUpdate[];
} {
  const deadLetters: DeadLetterUpdate[] = [];
  const client = {
    agentComponentInvocationSyncOutbox: {
      findMany: () => Promise.resolve(rows),
      updateMany: (args: {
        where: { OR: { partIndex: number }[] };
        data: { status: unknown; lastError: unknown };
      }) => {
        deadLetters.push({
          status: args.data.status,
          lastError: args.data.lastError,
          partIndexes: args.where.OR.map((row) => row.partIndex),
        });
        return Promise.resolve({ count: args.where.OR.length });
      },
    },
  };
  const prisma: Pick<DesktopPrisma, "read" | "write"> = {
    read: <T>(fn: (readClient: never) => Promise<T>): Promise<T> =>
      fn(client as never),
    write: <T>(fn: (writeClient: never) => Promise<T>): Promise<T> =>
      fn(client as never),
  };
  return { prisma, deadLetters };
}

/**
 * ISS-5973: the drain must reserve part of every tick for never-attempted rows.
 *
 * The fixture carries the STALLING condition measured on the live install, not a
 * healthy queue: more ready rows than one tick's budget, where the OLDEST rows are
 * all rows that have already been attempted many times and keep failing, and the
 * never-attempted rows are strictly younger.
 *
 * Under the plain `ORDER BY created_at ASC, part_index ASC LIMIT 10` this read
 * used before ISS-5973, every tick returned the same ten already-attempted rows
 * and the younger ones were never selected — which is exactly what the live data
 * showed: 71 rows sat at `attempt_count = 0` for days at ranks 15-85, while the
 * ten rows the drain kept picking carried attempt counts of 4 to 61.
 */
describe("ISS-5973 ready-parts fairness", () => {
  const LIMIT = 10;
  const OLD_CREATED_AT = "2026-08-09T23:56:23.000Z";
  const NEW_CREATED_AT = "2026-08-11T01:02:39.000Z";

  /** A poisoned cluster that fills the whole window, plus younger fresh work. */
  function starvedQueue(): OutboxRow[] {
    const rows: OutboxRow[] = [];
    for (let index = 0; index < LIMIT + 2; index += 1) {
      rows.push({
        ...outboxRow(
          index,
          part(AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION)
        ),
        externalSessionId: "poisoned-session",
        attemptCount: 7,
        createdAt: OLD_CREATED_AT,
      });
    }
    for (let index = 0; index < LIMIT; index += 1) {
      rows.push({
        ...outboxRow(
          index,
          part(AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION)
        ),
        externalSessionId: "never-attempted-session",
        attemptCount: 0,
        createdAt: NEW_CREATED_AT,
      });
    }
    return rows;
  }

  it("selects never-attempted rows even when older retrying rows fill the window", async () => {
    const harness = queryingOutboxHarness(starvedQueue());

    const entries = await loadReadyInvocationSyncOutboxParts(
      harness.prisma,
      SOURCE_KEY,
      NOW,
      LIMIT
    );

    assert.equal(entries.length, LIMIT);
    const fresh = entries.filter((entry) => entry.attemptCount === 0);
    assert.ok(
      fresh.length > 0,
      "a never-attempted row was never selected — the older retrying cluster holds the whole window, which is the ISS-5973 stall"
    );
    // The retrying rows must keep their share too: starving THEM would stop them
    // ever reaching the terminal state invariant 5 requires.
    assert.ok(
      entries.some((entry) => entry.attemptCount > 0),
      "the retrying rows lost their share of the window"
    );
  });

  it("returns each row at most once when the two reads overlap", async () => {
    // Every row is never-attempted here, so the FIFO half and the fairness half
    // select the SAME rows. Without dedupe the tick would send parts twice.
    const rows: OutboxRow[] = [];
    for (let index = 0; index < LIMIT; index += 1) {
      rows.push({
        ...outboxRow(
          index,
          part(AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION)
        ),
        attemptCount: 0,
        createdAt: NEW_CREATED_AT,
      });
    }
    const harness = queryingOutboxHarness(rows);

    const entries = await loadReadyInvocationSyncOutboxParts(
      harness.prisma,
      SOURCE_KEY,
      NOW,
      LIMIT
    );

    const identities = entries.map(
      (entry) => `${entry.part.externalGenerationId}#${entry.part.partIndex}`
    );
    assert.equal(
      new Set(identities).size,
      identities.length,
      "the same outbox row was returned twice in one tick"
    );
    assert.equal(entries.length, LIMIT);
  });

  it("never exceeds the caller's budget", async () => {
    const harness = queryingOutboxHarness(starvedQueue());

    const entries = await loadReadyInvocationSyncOutboxParts(
      harness.prisma,
      SOURCE_KEY,
      NOW,
      4
    );

    assert.equal(entries.length, 4);
  });

  it("fills the whole window from the FIFO head when nothing is never-attempted", async () => {
    // The ORDINARY steady state once a backlog has been worked through once:
    // every ready row carries `attempt_count > 0`, so the fairness half selects
    // nothing at all. The reservation is a floor on fairness, not a ceiling on
    // throughput — an unspent reservation has to go back to the FIFO half, or a
    // budget of ten quietly becomes a budget of five and a handful of
    // permanently-ready transient failures hold every later row out of the
    // window indefinitely.
    const rows: OutboxRow[] = [];
    for (let index = 0; index < LIMIT + 5; index += 1) {
      rows.push({
        ...outboxRow(
          index,
          part(AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION)
        ),
        attemptCount: 3,
        createdAt: OLD_CREATED_AT,
      });
    }
    const harness = queryingOutboxHarness(rows);

    const entries = await loadReadyInvocationSyncOutboxParts(
      harness.prisma,
      SOURCE_KEY,
      NOW,
      LIMIT
    );

    assert.equal(
      entries.length,
      LIMIT,
      "the unused fairness reservation was not handed back to the FIFO half — steady-state retry throughput is halved"
    );
  });
});

/**
 * A harness whose `findMany` actually HONOURS `where.attemptCount`, `orderBy`,
 * and `take`.
 *
 * The older {@link outboxHarness} returns its rows verbatim and ignores the
 * query, which is fine for the parse/quarantine cases it was written for but
 * cannot express selection at all — under it a starved queue and a healthy one
 * are indistinguishable, so a fairness test would pass without the fix.
 */
function queryingOutboxHarness(rows: OutboxRow[]): {
  prisma: Pick<DesktopPrisma, "read" | "write">;
  deadLetters: DeadLetterUpdate[];
} {
  const deadLetters: DeadLetterUpdate[] = [];
  const client = {
    agentComponentInvocationSyncOutbox: {
      findMany: (args: {
        where?: { attemptCount?: number };
        take?: number;
      }) => {
        const wanted =
          args.where?.attemptCount === undefined
            ? rows
            : rows.filter(
                (row) => row.attemptCount === args.where?.attemptCount
              );
        const ordered = [...wanted].sort((left, right) => {
          const byCreatedAt = String(left.createdAt).localeCompare(
            String(right.createdAt)
          );
          if (byCreatedAt !== 0) {
            return byCreatedAt;
          }
          return left.partIndex - right.partIndex;
        });
        return Promise.resolve(ordered.slice(0, args.take ?? ordered.length));
      },
      updateMany: (args: {
        where: { OR: { partIndex: number }[] };
        data: { status: unknown; lastError: unknown };
      }) => {
        deadLetters.push({
          status: args.data.status,
          lastError: args.data.lastError,
          partIndexes: args.where.OR.map((row) => row.partIndex),
        });
        return Promise.resolve({ count: args.where.OR.length });
      },
    },
  };
  const prisma: Pick<DesktopPrisma, "read" | "write"> = {
    read: <T>(fn: (readClient: never) => Promise<T>): Promise<T> =>
      fn(client as never),
    write: <T>(fn: (writeClient: never) => Promise<T>): Promise<T> =>
      fn(client as never),
  };
  return { prisma, deadLetters };
}
