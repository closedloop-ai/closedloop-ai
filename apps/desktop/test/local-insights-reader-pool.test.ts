import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, test } from "node:test";
import {
  InsightsPeriod,
  InsightsSection,
} from "@closedloop-ai/loops-api/insights";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { TOOL_INVOCATION_EVENT_TYPE } from "../src/main/database/dashboard-queries.js";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openInsightsDb } from "./local-insights-test-helpers.js";

/**
 * ISS-5938 — every RAW Insights aggregate is dispatched through the READER
 * POOL, and never through the writer-bound `prisma.client`.
 *
 * The numbers these sections emit are unchanged by the routing (the sibling
 * contract/coverage suites already pin them), so this suite pins the SEAM
 * instead: it hands `computeLocalInsights` a `DesktopPrisma` whose `client`
 * facade throws on any `$`-prefixed (raw) access, so a read that regresses back
 * onto the writer connection fails here instead of silently queueing behind the
 * first-launch backfill again.
 *
 * The facade does NOT ban the writer outright, because the TYPED delegate reads
 * are required to stay there: FEA-2211 (see session-count.ts) documents that the
 * libSQL community adapter zeroes a model-delegate aggregate on the `query_only`
 * reader connections in packaged builds. So the suite pins the split in both
 * directions — raw on the pool, and the named typed delegates (and only those)
 * on the writer — which is the pair a future "finish the migration" edit would
 * otherwise break silently in production only.
 *
 * It also pins that each raw read takes its OWN `read()` dispatch rather than
 * being gathered onto one pooled connection, since that separation is what lets
 * the pool fan a section's `Promise.all` out across connections instead of
 * self-serializing the way the writer did.
 *
 * Focused sibling suite rather than an addition to
 * `local-insights-contract.test.ts`, which is in the shrink-only grandfather
 * list.
 */

// Same timezone pin as the sibling suites: the insights SQL buckets by
// process-local day, so a fixed non-UTC zone keeps the conversion exercised and
// deterministic. Runs at module evaluation, before any DB opens.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Chicago";
after(() => {
  // Restore EXACTLY: assigning `undefined` would leave the string "undefined".
  if (ORIGINAL_TZ === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
    return;
  }
  process.env.TZ = ORIGINAL_TZ;
});

const NOW = new Date("2026-06-22T00:00:00.000Z"); // = June 21 19:00 CDT
const IN_WINDOW = "2026-06-20T10:00:00.000Z"; // = June 20 05:00 CDT

/** The raw-on-the-writer tripwire's message. */
const WRITER_TRIPWIRE = /raw Insights read reached the writer client/;

/**
 * Per section: the typed delegates it may reach on the writer client (FEA-2211).
 *
 * There is deliberately NO expected read COUNT here. "One `read()` per raw
 * aggregate" is a RELATIONSHIP, and a literal restates it as a snapshot that
 * goes stale the moment a section gains or loses an aggregate — which is
 * exactly what ISS-5936 did to the delivery and utilization counts. The suite
 * derives it instead, from two independently observed runtime quantities: how
 * many times the section dispatched `read()`, and how many raw statements the
 * pooled readers actually executed inside those dispatches (see
 * {@link DispatchLog}). Adding an aggregate moves both and stays green;
 * gathering several aggregates onto one pooled connection — the regression this
 * suite exists to catch — moves only one and fails.
 */
const SECTION_EXPECTATIONS: Record<
  InsightsSection,
  { writerDelegates: readonly string[] }
> = {
  [InsightsSection.Delivery]: { writerDelegates: [] },
  [InsightsSection.Agents]: { writerDelegates: ["agent"] },
  [InsightsSection.Utilization]: { writerDelegates: ["session"] },
};

/**
 * What one section's reads did with the connection topology.
 *
 * `poolReads` counts `read()` DISPATCHES (how many pooled connections the
 * section can fan out across); `rawStatements` counts the `$queryRaw*` calls
 * issued on the clients those dispatches handed back, including inside a read
 * `$transaction`. Their equality is the "one dispatch per raw aggregate"
 * contract in both directions: a gathered section reads more statements than it
 * dispatches, and a dispatch that runs no raw statement at all (a typed
 * delegate smuggled onto the pool) dispatches more than it reads.
 */
type DispatchLog = {
  poolReads: number;
  rawStatements: number;
  writerDelegates: string[];
};

function newLog(): DispatchLog {
  return { poolReads: 0, rawStatements: 0, writerDelegates: [] };
}

/**
 * A pooled read client that tallies the raw statements run on it. `$transaction`
 * is wrapped recursively so a future "take one snapshot for the whole section"
 * regression is counted at the statements it runs, not at the one dispatch it
 * would collapse to.
 */
function countingReader<T extends object>(reader: T, log: DispatchLog): T {
  // `target` is widened to `object` so the member lookups below resolve against
  // `Reflect.get`'s non-generic overload; keyed off `T` it yields a conditional
  // type that no call signature is assignable from.
  const handler: ProxyHandler<T> = {
    get(target: object, property) {
      if (property === "$queryRaw" || property === "$queryRawUnsafe") {
        const raw: (...args: unknown[]) => unknown = Reflect.get(
          target,
          property
        );
        return (...args: unknown[]) => {
          log.rawStatements += 1;
          return raw.apply(target, args);
        };
      }
      if (property === "$transaction") {
        const transaction: (fn: (tx: object) => unknown) => unknown =
          Reflect.get(target, property);
        return (fn: (tx: object) => unknown) =>
          transaction.call(target, (tx: object) => fn(countingReader(tx, log)));
      }
      return Reflect.get(target, property);
    },
  };
  return new Proxy(reader, handler);
}

/**
 * `prisma` with BOTH writer doors instrumented and `read()` counted.
 *
 * The facade is a Proxy over the real writer client: a `$`-prefixed property
 * (`$queryRaw`, `$queryRawUnsafe`) throws, and any other STRING property is
 * recorded and forwarded, so the suite can assert exactly which typed delegates
 * the section still reaches for. Symbol keys are forwarded unrecorded — a
 * `Symbol.toStringTag`/`then` probe is not a delegate read and must not pollute
 * the assertion.
 */
function withInstrumentedPrisma(
  prisma: DesktopPrisma,
  log: DispatchLog
): DesktopPrisma {
  const writerFacade = new Proxy(prisma.client, {
    get(target, property) {
      if (typeof property !== "string") {
        return Reflect.get(target, property);
      }
      if (property.startsWith("$")) {
        throw new Error(
          `ISS-5938: raw Insights read reached the writer client (prisma.client.${property}); route it through prisma.read`
        );
      }
      log.writerDelegates.push(property);
      return Reflect.get(target, property);
    },
  });
  return {
    ...prisma,
    client: writerFacade,
    // The writer's OTHER door. `client` is narrowed to `DesktopPrismaReader`,
    // which strips every `$`-prefixed member except `$queryRaw*` — so it has no
    // `$transaction`, and a future edit wanting a section-wide snapshot has
    // exactly two routes: the reader pool's `$transaction`, or `write()`. The
    // second lands the read on the writer connection AND serializes it behind
    // the write queue — strictly worse than the regression this suite exists to
    // prevent — and a spread-only facade would forward it untrapped, leaving
    // the suite green. `computeLocalInsights` performs no writes, so the throw
    // is unconditional.
    write: () => {
      throw new Error(
        "ISS-5938: an Insights read reached prisma.write; route it through prisma.read"
      );
    },
    read: (fn) => {
      log.poolReads += 1;
      return prisma.read((client) => fn(countingReader(client, log)));
    },
  };
}

test("ISS-5938: the writer facade traps raw reads and passes typed delegates", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-pool-trap-");
  try {
    const log = newLog();
    const instrumented = withInstrumentedPrisma(prisma, log);
    // Without this the section assertions below would pass vacuously if the
    // trap ever stopped throwing.
    assert.throws(() => instrumented.client.$queryRawUnsafe, WRITER_TRIPWIRE);
    // The FEA-2211 typed delegates must still work through the facade, or the
    // "these stay on the writer" half of the contract would be untestable.
    assert.ok(instrumented.client.agent, "typed delegate reachable");
    assert.deepEqual(log.writerDelegates, ["agent"]);
  } finally {
    await prisma.disconnect();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const section of Object.keys(SECTION_EXPECTATIONS) as InsightsSection[]) {
  test(`ISS-5938: the ${section} section reads raw off the pool`, async () => {
    const { dir, db, prisma } = await openInsightsDb(
      `local-insights-pool-${section}-`
    );
    try {
      // A session + an event + a captured PR, so every section has a non-empty
      // corpus and each of its reads actually touches rows. An all-empty store
      // would still exercise the dispatch, but not the joins.
      await db.query(
        "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, $2, $3, $4)",
        [
          "session-pool",
          SESSION_STATUS.INACTIVE,
          IN_WINDOW,
          "2026-06-20T11:00:00.000Z",
        ]
      );
      await db.query(
        `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
         VALUES ($1, $2, $3, 'Read', $4)`,
        ["event-pool", "session-pool", TOOL_INVOCATION_EVENT_TYPE, IN_WINDOW]
      );
      await db.query(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, pr_number,
            lines_added, lines_removed, files_changed, created_at, last_seen_at)
         VALUES ($1, $2, 'pull_request', 'acme/repo', 1, 10, 5, 2, $3, $3)`,
        ["pr-pool", "pr:acme/repo:1", IN_WINDOW]
      );

      const log = newLog();
      const expected = SECTION_EXPECTATIONS[section];
      const response = await computeLocalInsights(
        withInstrumentedPrisma(prisma, log),
        section,
        InsightsPeriod.Quarter,
        NOW
      );

      // Reaching here at all is the primary assertion: no RAW read touched the
      // writer facade, or the trap would have thrown out of the section.
      assert.ok(response.kpis.length > 0, "section produced KPIs");
      // Non-vacuity: `0 === 0` must not be able to satisfy the equality below.
      assert.ok(
        log.rawStatements > 0,
        "section ran raw aggregates on the pool"
      );
      assert.equal(
        log.poolReads,
        log.rawStatements,
        "every raw aggregate takes its own pooled read() dispatch"
      );
      assert.deepEqual(
        [...new Set(log.writerDelegates)].sort(),
        [...expected.writerDelegates].sort(),
        "only the FEA-2211 typed delegates stay on the writer client"
      );
    } finally {
      await prisma.disconnect();
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
