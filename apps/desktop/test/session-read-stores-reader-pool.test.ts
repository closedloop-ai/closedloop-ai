import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { Harness } from "@repo/lib/harness/types";
import { DESKTOP_AGENT_STATUS } from "../src/main/database/db-constants.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  createSqliteAgentStore,
  createSqliteEventStore,
  createSqliteSessionStore,
  createSqliteTokenUsageStore,
} from "../src/main/database/read-stores.js";
import { openTestPrisma } from "./prisma-test-utils.js";

/**
 * ISS-6199 — the desktop Sessions read stores dispatch their reads through the
 * READER POOL, not the writer-bound `prisma.client`.
 *
 * The rows these methods return are unchanged by the routing (the sibling
 * `session-agent-store-contract` / `session-detail-reads-contract` /
 * `sqlite-agent-dashboard-database` suites already pin them), so this suite pins
 * the SEAM instead — the same shape as ISS-5938's
 * `local-insights-reader-pool.test.ts`.
 *
 * It pins the split in BOTH directions, because both halves are load-bearing and
 * neither is visible in a result assertion:
 *
 *  - Every renderer-facing read runs off `prisma.read`, so a regression back onto
 *    the PRIMARY connection (where they self-serialize behind each other and
 *    contend with first-launch backfill and live-import writes) fails here.
 *  - `sessions.handleSessionMutation` stays on the writer, because it reads right
 *    after a committed write to decide historical-cache invalidation — a genuine
 *    read-your-writes read. It is the only one: `getById` also serves the
 *    `desktop:db:get-session` renderer channel, so it is pooled.
 *  - `events.getCountByType` stays on the writer, because it is a model-delegate
 *    AGGREGATE and FEA-2211 (see `session-count.ts`) documents that such an
 *    aggregate returns 0 on the `query_only` reader connections in PACKAGED
 *    builds while returning the true value in a clean test env. A "finish the
 *    migration" edit would therefore pass every result assertion and zero the
 *    renderer in production; this suite is what refuses it.
 *
 * It also pins that each read takes its OWN `read()` dispatch rather than being
 * gathered onto one pooled connection, since that separation is what lets
 * independent reads fan out across connections instead of self-serializing the
 * way the writer did. That is a deliberate ceiling, not an accident: a future
 * change that genuinely wants ONE pooled snapshot for a method (a read
 * `$transaction`, e.g. to stop `getPage`'s total from skewing against its rows)
 * has to relax this expectation for that method and say why — which is the
 * point, since pinning a pooled reader for a whole method is exactly the shape
 * ISS-6199 ruled out by default.
 */

const SESSION_ID = "pool-session";
/** `getHistoricalWithDetails` filters `status IN TERMINAL_STATUSES`, so without a
 * terminal row its CTE returns nothing, `attachEstimatedCosts` short-circuits on
 * the empty array before either pooled read dispatches, and the case asserts its
 * dispatch-per-read equality over 1 === 1 instead of over the reads it names. */
const TERMINAL_SESSION_ID = "pool-session-terminal";
const AGENT_ID = "pool-agent";
const STARTED_AT = "2026-06-20T10:00:00.000Z";

/**
 * What one store method did with the connection topology.
 *
 * `poolDispatches` counts `read()` calls (how many pooled connections the method
 * can fan out across); `poolStatements` counts the reads actually issued on the
 * clients those dispatches handed back — raw `$queryRaw*` plus every typed
 * delegate read, including inside a read `$transaction`. Their equality is the
 * "one dispatch per read" contract in both directions: a gathered method issues
 * more statements than it dispatches, and a dispatch that issues nothing at all
 * dispatches more than it reads.
 *
 * `writerMembers` records which members of the writer facade the method touched,
 * so the two deliberate read-your-writes / FEA-2211 exceptions are asserted
 * positively instead of merely tolerated.
 */
type DispatchLog = {
  poolDispatches: number;
  poolStatements: number;
  writerMembers: string[];
};

/** The read methods a Prisma model delegate exposes on the read-only facade. */
const DELEGATE_READ_METHODS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "aggregate",
  "count",
  "groupBy",
]);

const RAW_READ_METHODS = new Set(["$queryRaw", "$queryRawUnsafe"]);

/**
 * A pooled read client that tallies every read run on it. Model delegates are
 * wrapped too (not just the raw hatch) because the migrated reads here are a mix
 * of raw aggregate-joins and typed row reads, and both have to be counted for the
 * dispatch-per-read equality to mean anything. `$transaction` is wrapped
 * recursively so a future "take one snapshot for the whole method" regression is
 * counted at the reads it runs, not at the one dispatch it would collapse to.
 */
function countingReader<T extends object>(reader: T, log: DispatchLog): T {
  // `target` is widened to `object` so the member lookups below resolve against
  // `Reflect.get`'s non-generic overload; keyed off `T` it yields a conditional
  // type that no call signature is assignable from.
  const handler: ProxyHandler<T> = {
    get(target: object, property) {
      const member = Reflect.get(target, property);
      if (typeof property !== "string") {
        return member;
      }
      if (RAW_READ_METHODS.has(property)) {
        const raw: (...args: unknown[]) => unknown = member;
        return (...args: unknown[]) => {
          log.poolStatements += 1;
          return raw.apply(target, args);
        };
      }
      if (property === "$transaction") {
        const transaction: (fn: (tx: object) => unknown) => unknown = member;
        return (fn: (tx: object) => unknown) =>
          transaction.call(target, (tx: object) => fn(countingReader(tx, log)));
      }
      if (property.startsWith("$") || member === null) {
        return member;
      }
      if (typeof member === "object") {
        return countingDelegate(member, log);
      }
      return member;
    },
  };
  return new Proxy(reader, handler);
}

/** Wrap one model delegate so each read method call is tallied. */
function countingDelegate<T extends object>(delegate: T, log: DispatchLog): T {
  const handler: ProxyHandler<T> = {
    get(target: object, property) {
      const member = Reflect.get(target, property);
      if (
        typeof property !== "string" ||
        !DELEGATE_READ_METHODS.has(property)
      ) {
        return member;
      }
      const read: (...args: unknown[]) => unknown = member;
      return (...args: unknown[]) => {
        log.poolStatements += 1;
        return read.apply(target, args);
      };
    },
  };
  return new Proxy(delegate, handler);
}

/**
 * `prisma` with the writer facade recorded and `read()` counted.
 *
 * The writer facade is a Proxy over the real writer client that records every
 * STRING member reached and forwards it, so the suite asserts exactly which
 * delegates still land there. Symbol keys are forwarded unrecorded — a
 * `Symbol.toStringTag`/`then` probe is not a read and must not pollute the
 * assertion. `write` throws: these are read paths, and `write()` would land a
 * read on the writer connection AND serialize it behind the write queue, which is
 * strictly worse than the regression this suite exists to prevent.
 */
function withInstrumentedPrisma(
  prisma: DesktopPrisma,
  log: DispatchLog
): DesktopPrisma {
  const writerFacade = new Proxy(prisma.client, {
    get(target, property) {
      if (typeof property === "string") {
        log.writerMembers.push(property);
      }
      return Reflect.get(target, property);
    },
  });
  return {
    ...prisma,
    client: writerFacade,
    write: () => {
      throw new Error(
        "ISS-6199: a store read reached prisma.write; route it through prisma.read"
      );
    },
    read: (fn) => {
      log.poolDispatches += 1;
      return prisma.read((client) => fn(countingReader(client, log)));
    },
  };
}

type Stores = {
  sessions: ReturnType<typeof createSqliteSessionStore>;
  agents: ReturnType<typeof createSqliteAgentStore>;
  events: ReturnType<typeof createSqliteEventStore>;
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>;
};

/**
 * One store method under test: how to drive it, and where its reads must land.
 *
 * There is deliberately no expected read COUNT — "one dispatch per read" is a
 * RELATIONSHIP, and a literal restates it as a snapshot that goes stale the
 * moment a method gains or loses a read. The suite derives it from the two
 * independently observed runtime quantities in {@link DispatchLog} instead:
 * adding a read moves both and stays green, while gathering reads onto one
 * pooled connection moves only one and fails.
 */
type MethodCase = {
  label: string;
  run: (stores: Stores) => Promise<unknown>;
  /** Writer-facade members this method may reach; empty ⇒ fully pooled. */
  writerMembers: readonly string[];
};

const METHOD_CASES: readonly MethodCase[] = [
  {
    label: "sessions.handleSessionMutation",
    run: (s) => s.sessions.handleSessionMutation(SESSION_ID),
    // Read-your-writes: it runs right after the write that emitted the mutation.
    writerMembers: ["session"],
  },
  {
    label: "events.getCountByType",
    run: (s) => s.events.getCountByType(),
    // FEA-2211: a model-delegate aggregate zeroes on the reader pool in
    // packaged builds.
    writerMembers: ["event"],
  },
  {
    label: "sessions.getById",
    run: (s) => s.sessions.getById(SESSION_ID),
    writerMembers: [],
  },
  {
    label: "sessions.count",
    run: (s) => s.sessions.count(),
    writerMembers: [],
  },
  {
    label: "sessions.getAll",
    run: (s) => s.sessions.getAll(),
    writerMembers: [],
  },
  {
    label: "sessions.getActive",
    run: (s) => s.sessions.getActive(),
    writerMembers: [],
  },
  {
    label: "sessions.getDetailsById",
    run: (s) => s.sessions.getDetailsById(SESSION_ID),
    writerMembers: [],
  },
  {
    label: "sessions.getActiveWithDetails",
    run: (s) => s.sessions.getActiveWithDetails(),
    writerMembers: [],
  },
  {
    label: "sessions.getHistoricalWithDetails",
    run: (s) => s.sessions.getHistoricalWithDetails(),
    writerMembers: [],
  },
  {
    label: "sessions.getPage",
    run: (s) => s.sessions.getPage({ limit: 10, offset: 0 }),
    writerMembers: [],
  },
  {
    label: "agents.getBySession",
    run: (s) => s.agents.getBySession(SESSION_ID),
    writerMembers: [],
  },
  {
    label: "agents.getBySessionWithChildren",
    run: (s) => s.agents.getBySessionWithChildren(SESSION_ID),
    writerMembers: [],
  },
  {
    label: "events.getBySession",
    run: (s) => s.events.getBySession(SESSION_ID),
    writerMembers: [],
  },
  {
    label: "events.getBySessionAndAgent",
    run: (s) => s.events.getBySessionAndAgent(SESSION_ID, AGENT_ID),
    writerMembers: [],
  },
  { label: "events.getAll", run: (s) => s.events.getAll(), writerMembers: [] },
  {
    label: "events.getWithSession",
    run: (s) => s.events.getWithSession(SESSION_ID),
    writerMembers: [],
  },
  {
    label: "tokenUsage.getBySession",
    run: (s) => s.tokenUsage.getBySession(SESSION_ID),
    writerMembers: [],
  },
];

// One migrated store fixture for the whole file: the cases only READ, so they
// cannot see each other, and re-migrating a temp database per case would dominate
// the runtime. Shared through the file-level hooks rather than a TestContext
// parameter, which would route this file onto the shrinking node:test lane
// (`scripts/node-test-census.mjs`).
const log: DispatchLog = {
  poolDispatches: 0,
  poolStatements: 0,
  writerMembers: [],
};
let closeFixture: (() => Promise<void>) | null = null;
let stores: Stores | null = null;

before(async () => {
  const { db, prisma, close } = await openTestPrisma();
  closeFixture = close;
  // An ACTIVE session with an agent, an event and a token row, plus a TERMINAL
  // twin below, so every method under test reads real rows rather than
  // exercising only its empty guard — the two status filters in this store
  // (`NOT IN` terminal for the active reads, `IN` terminal for the historical
  // one) are mutually exclusive, so one row cannot satisfy both — and so the
  // cost decoration's token fallback actually runs.
  await db.query(
    `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, 'Pool Session', $2, $3, $3, $4)`,
    [SESSION_ID, SESSION_STATUS.ACTIVE, STARTED_AT, Harness.Claude]
  );
  await db.query(
    "INSERT INTO agents (id, session_id, status, started_at) VALUES ($1, $2, $3, $4)",
    [AGENT_ID, SESSION_ID, DESKTOP_AGENT_STATUS.RUNNING, STARTED_AT]
  );
  await db.query(
    `INSERT INTO events (id, session_id, agent_id, event_type, created_at)
       VALUES ('pool-event', $1, $2, 'PreToolUse', $3)`,
    [SESSION_ID, AGENT_ID, STARTED_AT]
  );
  await db.query(
    `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, created_at)
       VALUES ($1, 'claude-sonnet-4-5', 300, 100, $2)`,
    [SESSION_ID, STARTED_AT]
  );
  // The terminal twin, with its own token row: the ACTIVE session above is
  // excluded by the historical read's terminal filter, so it is this row that
  // makes `sessions.getHistoricalWithDetails` reach `attachEstimatedCosts`.
  await db.query(
    `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, 'Pool Session (terminal)', $2, $3, $3, $4)`,
    [TERMINAL_SESSION_ID, SESSION_STATUS.INACTIVE, STARTED_AT, Harness.Claude]
  );
  await db.query(
    `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, created_at)
       VALUES ($1, 'claude-sonnet-4-5', 300, 100, $2)`,
    [TERMINAL_SESSION_ID, STARTED_AT]
  );
  const instrumented = withInstrumentedPrisma(prisma, log);
  const events = createSqliteEventStore(instrumented);
  stores = {
    sessions: createSqliteSessionStore(instrumented),
    agents: createSqliteAgentStore(instrumented, events),
    events,
    tokenUsage: createSqliteTokenUsageStore(instrumented),
  };
});

after(async () => {
  await closeFixture?.();
});

for (const method of METHOD_CASES) {
  test(`ISS-6199: ${method.label} reads on the expected connection`, async () => {
    assert.ok(stores, "fixture opened");
    log.poolDispatches = 0;
    log.poolStatements = 0;
    log.writerMembers.length = 0;

    await method.run(stores);

    assert.deepEqual(
      [...new Set(log.writerMembers)].sort(),
      [...method.writerMembers].sort(),
      `${method.label}: only the read-your-writes / FEA-2211 reads stay on the writer client`
    );
    if (method.writerMembers.length > 0) {
      // A writer-pinned read must not ALSO fan onto the pool: a split would mean
      // half of it no longer sees the snapshot it was pinned for.
      assert.equal(
        log.poolDispatches,
        0,
        `${method.label}: stays entirely on the writer connection`
      );
      return;
    }
    // Non-vacuity: `0 === 0` must not be able to satisfy the equality below.
    assert.ok(
      log.poolStatements > 0,
      `${method.label}: ran its reads on the pool`
    );
    assert.equal(
      log.poolDispatches,
      log.poolStatements,
      `${method.label}: every read takes its own pooled read() dispatch`
    );
  });
}
