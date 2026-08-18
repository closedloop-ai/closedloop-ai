/**
 * @file retention-sweep-chunking.test.ts
 * @description ISS-5492: the retention sweep's chunk loop. `sweepExpiredSessions`
 * used to delete every child row of every expired session in ONE statement per
 * table, binding one parameter per id — including a raw
 * `DELETE FROM token_events WHERE session_id IN ($1…$N)` — while the stale sweep
 * beside it in the same file already chunked to `SWEEP_ID_CHUNK`. A focused
 * sibling suite rather than another cluster in `maintenance-write-txs.test.ts`
 * (which owns the standalone maintenance transactions), per `test/AGENTS.md`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { EVENT_INSERT_PARAM_CAP } from "../src/main/database/db-constants.js";
import type {
  Prisma,
  PrismaClient,
} from "../src/main/database/generated/client.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  SWEEP_ID_CHUNK,
  sweepExpiredSessions,
} from "../src/main/database/session-maintenance.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import {
  NOW,
  recordBoundParams,
  type SeedEventRow,
  type SeedSessionRow,
  type SeedTokenEventRow,
  type Store,
  seedEvents,
  seedSessions,
  seedTokenEvents,
} from "./session-sweep-fixtures.js";

// Default retention window is 90 days, so anchor activity relative to NOW to
// land clearly outside (expired) / inside (retained) it.
const EXPIRED_ACTIVITY = "2026-01-01T00:00:00.000Z"; // ~176d before NOW
const RECENT_ACTIVITY = "2026-06-20T00:00:00.000Z"; // ~6d before NOW
const MODEL = "claude-opus-4-8";

/*
 * ISS-5492: the SECOND and FINAL-PARTIAL iterations of the retention purge.
 *
 * The steady state hides this bug: on a live install each boot purges only the
 * sessions that crossed the window since the last one, so the loop never
 * iterates. The failing case is the FIRST sweep on an install older than the
 * 90-day window, which purges the entire backlog in one transaction — a
 * corpus-sized id list, not a day's worth. Every delete shares that transaction,
 * so a parameter-limit failure rolled back the whole purge and recurred
 * identically on the next boot: it never converged.
 *
 * `SWEEP_ID_CHUNK + 3` expired sessions makes chunk 1 full and chunk 2 a 3-row
 * partial, plus a retained session whose rows must survive the loop.
 */
test("ISS-5492: an expired set larger than SWEEP_ID_CHUNK is purged across chunks, inside the bound-parameter cap", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const TOTAL = SWEEP_ID_CHUNK + 3;
    const sessions: SeedSessionRow[] = [];
    const events: SeedEventRow[] = [];
    const tokenEvents: SeedTokenEventRow[] = [];
    for (let index = 0; index < TOTAL; index += 1) {
      const id = `s${String(index).padStart(4, "0")}`;
      sessions.push({
        id,
        status: SESSION_STATUS.INACTIVE,
        updatedAt: EXPIRED_ACTIVITY,
        lastActivityAt: EXPIRED_ACTIVITY,
        startedAt: EXPIRED_ACTIVITY,
        endsWithError: null,
      });
      // One TYPED child row (events) and one RAW-deleted child row
      // (token_events) per expired session, so a first-chunk-only purge leaves
      // orphans on both delete shapes.
      events.push({
        id: `${id}-ev`,
        sessionId: id,
        eventType: "UserPromptSubmit",
        createdAt: EXPIRED_ACTIVITY,
      });
      tokenEvents.push({
        sessionId: id,
        model: MODEL,
        createdAt: EXPIRED_ACTIVITY,
      });
    }
    // Terminal but inside the window: the chunk loop must not widen the set.
    sessions.push({
      id: "retained",
      status: SESSION_STATUS.INACTIVE,
      updatedAt: RECENT_ACTIVITY,
      lastActivityAt: RECENT_ACTIVITY,
      startedAt: RECENT_ACTIVITY,
      endsWithError: null,
    });
    events.push({
      id: "retained-ev",
      sessionId: "retained",
      eventType: "UserPromptSubmit",
      createdAt: RECENT_ACTIVITY,
    });
    tokenEvents.push({
      sessionId: "retained",
      model: MODEL,
      createdAt: RECENT_ACTIVITY,
    });
    await seedSessions(store, sessions);
    await seedEvents(store, events);
    await seedTokenEvents(store, tokenEvents);

    // The id-list length of every statement the purge actually issued — the raw
    // `token_events` delete by its bound-parameter count, each typed `deleteMany`
    // by the `in` list in its filter. Recorded through a pass-through proxy over
    // the real transaction client, so the deletes still hit the real DB.
    const idListLengths: number[] = [];
    const { purged } = await sweepExpiredSessions(
      recordSweepIdListLengths(prisma, idListLengths),
      NOW
    );
    assert.equal(purged, TOTAL, "every expired session is purged, not chunk 1");

    // The bound-parameter cap is why the loop exists. It cannot be observed as a
    // failure here — this libSQL build's SQLITE_MAX_VARIABLE_NUMBER is 32766, so
    // an unchunked 900+ id list would execute fine — but the OLD builds the cap
    // is conservative for would reject it, so assert the budget directly. Same
    // shape as the ISS-5182 assertion on the stale sweep.
    //
    // Every delete is asserted, not just the raw one: chunking ONLY the raw
    // `token_events` statement and leaving the 18 typed `deleteMany` calls on the
    // whole id list would be the same bug with 18 sites left, and a raw-only
    // assertion would stay green on it.
    assert.ok(
      idListLengths.length > 0,
      "the purge issued at least one id-bound statement"
    );
    assert.ok(
      Math.max(...idListLengths) <= EVENT_INSERT_PARAM_CAP,
      `no statement may bind more than ${EVENT_INSERT_PARAM_CAP} ids, saw ${Math.max(...idListLengths)}`
    );
    // Every statement ran exactly twice — once on the full chunk, once on the
    // 3-row partial — rather than once on the whole 902-id list. Asserted as a
    // partition instead of an exact statement count so adding a session-keyed
    // child table does not need this number edited.
    const onFullChunk = idListLengths.filter(
      (length) => length === SWEEP_ID_CHUNK
    ).length;
    const onPartialChunk = idListLengths.filter(
      (length) => length === TOTAL - SWEEP_ID_CHUNK
    ).length;
    assert.equal(
      onFullChunk + onPartialChunk,
      idListLengths.length,
      "no statement ran on an unchunked id list"
    );
    assert.equal(
      onFullChunk,
      onPartialChunk,
      "every id-bound statement ran once per chunk, not just the raw one"
    );

    // Nothing session-attributable survives, on either delete shape, in either
    // chunk — a retention purge has no reimport to rebuild derived state from.
    assert.equal(await countRows(store, "sessions"), 1);
    assert.equal(await countRows(store, "events"), 1);
    assert.equal(await countRows(store, "token_events"), 1);
    assert.equal(await countBySession(store, "events", "retained"), 1);
    assert.equal(await countBySession(store, "token_events", "retained"), 1);
  } finally {
    await close();
  }
});

async function countRows(store: Store, table: string): Promise<number> {
  const result = await store.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table}`
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function countBySession(
  store: Store,
  table: string,
  sessionId: string
): Promise<number> {
  const result = await store.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE session_id = $1`,
    [sessionId]
  );
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * `sweepExpiredSessions` opens its OWN write transaction, so the recording proxy
 * has to be threaded in one level higher than the ISS-5182 stale-sweep test does:
 * wrap `prisma.write` so the client it hands the sweep yields a recording
 * transaction client from `$transaction`. Everything else forwards to the real
 * client and the deletes land in the real database.
 */
function recordSweepIdListLengths(
  prisma: DesktopPrisma,
  lengths: number[]
): DesktopPrisma {
  return {
    ...prisma,
    write: (fn, token, opts) =>
      prisma.write(
        (client) => fn(withRecordingTransaction(client, lengths)),
        token,
        opts
      ),
  };
}

function withRecordingTransaction(
  client: PrismaClient,
  lengths: number[]
): PrismaClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === "$transaction") {
        return (body: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction((tx) =>
            // Composed, not re-implemented: the shared `recordBoundParams` counts
            // the RAW statement's bound parameters, and the delegate wrapper adds
            // the typed `deleteMany` filters, into the same array.
            body(withDelegateRecording(recordBoundParams(tx, lengths), lengths))
          );
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Records the `in`-list length of every typed `deleteMany` the code under test
 * issues, so the 18 typed child deletes are held to the same bound as the one raw
 * statement. Without this, chunking only the raw `token_events` delete would keep
 * the suite green.
 */
function withDelegateRecording(
  tx: Prisma.TransactionClient,
  lengths: number[]
): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (isDeleteManyDelegate(value)) {
        return new Proxy(value, {
          get(delegate, delegateProperty) {
            if (delegateProperty === "deleteMany") {
              return (args: DeleteManyArgs) => {
                const ids = args.where?.sessionId?.in ?? args.where?.id?.in;
                if (ids) {
                  lengths.push(ids.length);
                }
                return delegate.deleteMany(args);
              };
            }
            const delegateValue = Reflect.get(delegate, delegateProperty);
            return typeof delegateValue === "function"
              ? delegateValue.bind(delegate)
              : delegateValue;
          },
        });
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function isDeleteManyDelegate(value: unknown): value is DeleteManyDelegate {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { deleteMany?: unknown }).deleteMany === "function"
  );
}

type IdFilter = { in?: readonly string[] };
type DeleteManyArgs = { where?: { id?: IdFilter; sessionId?: IdFilter } };
type DeleteManyDelegate = {
  deleteMany: (args: DeleteManyArgs) => Promise<unknown>;
};
