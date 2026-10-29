import { IssueStatus } from "@repo/api/src/types/document";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { ArtifactType, LoopStatus } from "../../generated/enums";
import {
  deleteOrganization,
  migrationWithCeiling,
  readProjectedStatus,
  readProjection,
  seedArtifact,
  seedLoop,
  seedOrganization,
  seedProjectionRow,
  shippedMigrationSql,
  TEST_CEILING,
} from "./search-document-migration-fixtures";

/**
 * ISS-9938 (PLN-2065 §6.3): what the two one-time status repairs actually MOVE,
 * against real Postgres, by executing the SHIPPED migration files rather than a
 * transcription of them.
 *
 * Reading the files off disk and handing them to the server verbatim is
 * deliberate: a copy of either statement inside this test would keep passing
 * after someone edited the migration, which is the one regression this file
 * exists to prevent.
 *
 * BOTH CORPORA RUN EVERY CASE. The two migrations are near-identical text over
 * different tables, which is exactly the shape where a single-corpus fixture
 * passes while one of the two statements is wrong — the loop repair's enum cast
 * and its `entity_type` term have no document-side equivalent to lean on.
 *
 * SEEDED IN THE DRIFTED SHAPE DIRECTLY. The C1 sync triggers
 * (20260921132329_iss9938_search_document_status_sync_triggers) are live on any
 * database these migrations apply to, so a fixture that seeded a projection row
 * and then moved its source would be mirrored by the trigger before the repair
 * ever saw it. Each source below is inserted already holding its final status
 * and the projection row is then written with a different one — the corpus
 * production carries: a row indexed before the triggers existed, beside a
 * source that moved without it.
 *
 * NOTHING THE REPAIR WRITES EVER COMMITS, and that is not a tidiness
 * preference. Neither statement is fixture-scoped — each selects every drifted
 * projection row of its `entity_type` in the CONNECTED DATABASE, up to its
 * ceiling — so a committed run would rewrite rows no case here seeded and no
 * cleanup could reach. Every case in the first block runs inside a transaction
 * that is rolled back. The concurrency case needs two backends to see the same
 * rows, so its FIXTURE commits (and is deleted afterwards), but the repair
 * itself runs inside the runner's own transaction and is rolled back with it —
 * which is why that case reads the result back on the RUNNER's connection,
 * where a write it did make would still be visible.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const DOCUMENT_MIGRATION =
  "20260921151607_iss9938_search_document_document_status_repair";
const LOOP_MIGRATION =
  "20260921151657_iss9938_search_document_loop_status_repair";

type Corpus = {
  label: string;
  migration: string;
  entityType: SearchEntityType;
  /** The RAISE MESSAGE this corpus emits once the ceiling is lowered. */
  ceilingRaise: RegExp;
  /** Inserts a source row (and anything it needs) already holding `status`. */
  seedSource: (
    client: Client,
    organizationId: string,
    status: string
  ) => Promise<string>;
  /** Three distinct values this corpus's source column accepts. */
  sourceStatus: string;
  driftedStatus: string;
  aheadStatus: string;
};

const DOCUMENT_CORPUS: Corpus = {
  label: "document repair",
  migration: DOCUMENT_MIGRATION,
  entityType: SearchEntityType.Document,
  ceilingRaise: /ISS-9938: more than 2 search_document document rows/,
  seedSource: (client, organizationId, status) =>
    seedArtifact(client, organizationId, {
      type: ArtifactType.DOCUMENT,
      status,
    }),
  sourceStatus: IssueStatus.Done,
  driftedStatus: IssueStatus.InProgress,
  aheadStatus: IssueStatus.Blocked,
};

const LOOP_CORPUS: Corpus = {
  label: "loop repair",
  migration: LOOP_MIGRATION,
  entityType: SearchEntityType.Loop,
  ceilingRaise: /ISS-9938: more than 2 search_document loop rows/,
  seedSource: (client, organizationId, status) =>
    seedLoop(client, organizationId, { status }),
  sourceStatus: LoopStatus.COMPLETED,
  driftedStatus: LoopStatus.RUNNING,
  aheadStatus: LoopStatus.FAILED,
};

/** Each corpus paired with the one its own `entity_type` term must exclude. */
const CORPUS_PAIRS: readonly { corpus: Corpus; other: Corpus }[] = [
  { corpus: DOCUMENT_CORPUS, other: LOOP_CORPUS },
  { corpus: LOOP_CORPUS, other: DOCUMENT_CORPUS },
];

/** Bounded and clock-free; 300 x 20ms is ~6s against a 300s test budget. */
const BLOCKED_POLL_ATTEMPTS = 300;
const BLOCKED_POLL_INTERVAL_MS = 20;

describe.skipIf(!DATABASE_URL)("ISS-9938 search_document status repair", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  for (const { corpus, other } of CORPUS_PAIRS) {
    describe(corpus.label, () => {
      it("re-syncs the drifted rows and leaves every other row alone", async () => {
        const organizationId = await seedOrganization(client);
        const otherOrganizationId = await seedOrganization(client);

        // (a) the defect: the projection kept a status the source moved off.
        const drifted = await seedProjected(client, corpus, organizationId, {
          sourceStatus: corpus.sourceStatus,
          projectedStatus: corpus.driftedStatus,
        });
        // (b) indexed before FEA-3930 added the column and never re-indexed.
        // `IS DISTINCT FROM` rather than `<>` is the only thing putting it in
        // scope, and `IS NOT DISTINCT FROM` in the re-check the only thing
        // letting the write through.
        const neverProjected = await seedProjected(
          client,
          corpus,
          organizationId,
          { sourceStatus: corpus.sourceStatus, projectedStatus: null }
        );
        // (c) already in step — the write must not churn it.
        const inStep = await seedProjected(client, corpus, organizationId, {
          sourceStatus: corpus.sourceStatus,
          projectedStatus: corpus.sourceStatus,
        });
        // (d) the same drift under another organization, against THIS org's
        // source id. Only the organization term in the join keeps the repair
        // off it.
        const crossOrg = await seedProjectionRow(client, otherOrganizationId, {
          entityType: corpus.entityType,
          entityId: drifted.sourceId,
          status: corpus.driftedStatus,
        });
        // (e) the other corpus, equally drifted: each migration repairs one
        // `entity_type` and leaves the other's rows to its sibling.
        const otherCorpusRow = await seedProjected(
          client,
          other,
          organizationId,
          {
            sourceStatus: other.sourceStatus,
            projectedStatus: other.driftedStatus,
          }
        );
        const inStepBefore = await readProjection(client, inStep.rowId);

        await client.query(shippedMigrationSql(corpus.migration));

        expect(await readProjectedStatus(client, drifted.rowId)).toBe(
          corpus.sourceStatus
        );
        expect(await readProjectedStatus(client, neverProjected.rowId)).toBe(
          corpus.sourceStatus
        );
        // `ctid` moves on every UPDATE, including a same-value one, so an
        // unchanged ctid is what proves the in-step row was never written.
        expect((await readProjection(client, inStep.rowId)).ctid).toBe(
          inStepBefore.ctid
        );
        expect(await readProjectedStatus(client, crossOrg)).toBe(
          corpus.driftedStatus
        );
        expect(await readProjectedStatus(client, otherCorpusRow.rowId)).toBe(
          other.driftedStatus
        );
      });

      it("leaves updated_at alone", async () => {
        // It mirrors the SOURCE entity's updatedAt and orders search results,
        // so bumping it would re-rank every repaired row for a change no user
        // made (PLN-2065 §8).
        const organizationId = await seedOrganization(client);
        const drifted = await seedProjected(client, corpus, organizationId, {
          sourceStatus: corpus.sourceStatus,
          projectedStatus: corpus.driftedStatus,
        });
        const before = await readProjection(client, drifted.rowId);

        await client.query(shippedMigrationSql(corpus.migration));

        const after = await readProjection(client, drifted.rowId);
        expect(after.status).toBe(corpus.sourceStatus);
        expect(after.updatedAt).toEqual(before.updatedAt);
      });

      it("is idempotent — a second run rewrites nothing", async () => {
        const organizationId = await seedOrganization(client);
        const drifted = await seedProjected(client, corpus, organizationId, {
          sourceStatus: corpus.sourceStatus,
          projectedStatus: corpus.driftedStatus,
        });

        await client.query(shippedMigrationSql(corpus.migration));
        const afterFirst = await readProjection(client, drifted.rowId);
        await client.query(shippedMigrationSql(corpus.migration));
        const afterSecond = await readProjection(client, drifted.rowId);

        expect(afterFirst.status).toBe(corpus.sourceStatus);
        // A repaired row now equals its source and has left the population. An
        // unchanged ctid is what proves the second run selected nothing rather
        // than rewriting the same value.
        expect(afterSecond.ctid).toBe(afterFirst.ctid);
      });

      it("aborts above the ceiling and commits nothing", async () => {
        const organizationId = await seedOrganization(client);
        const rows: string[] = [];
        for (let seeded = 0; seeded <= TEST_CEILING; seeded += 1) {
          const drifted = await seedProjected(client, corpus, organizationId, {
            sourceStatus: corpus.sourceStatus,
            projectedStatus: corpus.driftedStatus,
          });
          rows.push(drifted.rowId);
        }

        // A savepoint, so the abort does not take down the suite's own
        // transaction and the rows stay readable afterwards.
        await client.query("SAVEPOINT before_ceiling");
        await expect(
          client.query(migrationWithCeiling(corpus.migration, TEST_CEILING))
        ).rejects.toThrow(corpus.ceilingRaise);
        await client.query("ROLLBACK TO SAVEPOINT before_ceiling");

        // The guard fires AFTER the write, so what proves it is that nothing
        // COMMITTED — every row still carries the drift.
        for (const row of rows) {
          expect(await readProjectedStatus(client, row)).toBe(
            corpus.driftedStatus
          );
        }
      });

      it("repairs a population sitting exactly ON the ceiling", async () => {
        // The abort case above only pins that `stale_selected > max_inline_rows`
        // fires when the population EXCEEDS the ceiling; it stays green if that
        // `>` is widened to `>=`. This is the other side of the boundary, and
        // the only case the widening turns red.
        const organizationId = await seedOrganization(client);
        // The statement is not fixture-scoped, so an unrelated drifted row in
        // this database would push the population past the ceiling and fail the
        // case for the wrong reason. A full-ceiling run first repairs any such
        // row (idempotently, inside this transaction), leaving the rows seeded
        // below as the whole population.
        await client.query(shippedMigrationSql(corpus.migration));

        const rows: string[] = [];
        for (let seeded = 0; seeded < TEST_CEILING; seeded += 1) {
          const drifted = await seedProjected(client, corpus, organizationId, {
            sourceStatus: corpus.sourceStatus,
            projectedStatus: corpus.driftedStatus,
          });
          rows.push(drifted.rowId);
        }

        await client.query(
          migrationWithCeiling(corpus.migration, TEST_CEILING)
        );

        for (const row of rows) {
          expect(await readProjectedStatus(client, row)).toBe(
            corpus.sourceStatus
          );
        }
      });
    });
  }

  it("leaves a session's projection row alone, though its entity_id is an artifact id", async () => {
    // Sessions, branches and deployments are artifacts too, so their
    // projection rows are the only non-`document` rows keyed on an
    // `artifacts` id. They carry `status = NULL` by contract, and without the
    // `entity_type = 'document'` term the document repair would stamp the
    // session's own lifecycle status onto them. The loop repair has no
    // analogue: nothing but a loop projects under a `loops` id.
    const organizationId = await seedOrganization(client);
    const sessionId = await seedArtifact(client, organizationId, {
      type: ArtifactType.SESSION,
      status: SESSION_STATUS.ACTIVE,
    });
    const sessionRow = await seedProjectionRow(client, organizationId, {
      entityType: SearchEntityType.AgentSession,
      entityId: sessionId,
      status: null,
    });

    await client.query(shippedMigrationSql(DOCUMENT_MIGRATION));

    expect(await readProjectedStatus(client, sessionRow)).toBeNull();
  });
});

describe.skipIf(!DATABASE_URL)(
  "ISS-9938 status repair beside a concurrent trigger write",
  () => {
    for (const { corpus } of CORPUS_PAIRS) {
      describe(corpus.label, () => {
        let fixture: Client;
        let blocker: Client;
        let runner: Client;
        let organizationId: string;

        beforeEach(async () => {
          fixture = new Client({ connectionString: DATABASE_URL });
          blocker = new Client({ connectionString: DATABASE_URL });
          runner = new Client({ connectionString: DATABASE_URL });
          await fixture.connect();
          await blocker.connect();
          await runner.connect();
          // The repair runs on this connection and must never commit: the
          // statement reaches every organization's drifted rows, not just the
          // fixture's. `runner.end()` below rolls this back whatever happens.
          await runner.query("BEGIN");
          organizationId = await seedOrganization(fixture);
        });

        afterEach(async () => {
          // The blocker goes first: closing it rolls back whatever transaction
          // it still holds and releases the lock the runner may be waiting on.
          await blocker.end();
          await runner.end();
          await deleteOrganization(fixture, organizationId);
          await fixture.end();
        });

        it("skips a row whose status changed since the snapshot", async () => {
          const drifted = await seedProjected(fixture, corpus, organizationId, {
            sourceStatus: corpus.sourceStatus,
            projectedStatus: corpus.driftedStatus,
          });

          // A trigger write IS this statement: the mirror row moving to the
          // source's new status, inside someone else's transaction. Holding it
          // open is what puts the repair's UPDATE on the far side of a commit
          // from its own snapshot.
          await blocker.query("BEGIN");
          await blocker.query(
            'UPDATE "search_document" SET "status" = $2 WHERE "id" = $1',
            [drifted.rowId, corpus.aheadStatus]
          );

          const runnerPid = await backendPid(runner);
          const running = runner.query(shippedMigrationSql(corpus.migration));
          // The repair has taken its snapshot (seeing the drifted value) and is
          // now waiting on the blocker's row lock. Committing before this point
          // would let it snapshot the newer value instead, and the case would
          // assert nothing.
          await waitUntilBlocked(fixture, runnerPid);
          await blocker.query("COMMIT");
          await running;

          // READ COMMITTED re-evaluated `sd.status IS NOT DISTINCT FROM
          // c.seen_status` against the version the blocker just committed. It
          // no longer matches, so the repair declined rather than writing its
          // older snapshot value back over a newer one.
          //
          // Read on the RUNNER, inside its still-open transaction: a write it
          // DID make would be visible here and nowhere else, so this is what
          // keeps the case falsifiable without committing the repair.
          expect(await readProjectedStatus(runner, drifted.rowId)).toBe(
            corpus.aheadStatus
          );
        });
      });
    }
  }
);

/** A source row plus the projection row an index pass wrote for it. */
async function seedProjected(
  client: Client,
  corpus: Corpus,
  organizationId: string,
  values: { sourceStatus: string; projectedStatus: string | null }
): Promise<{ sourceId: string; rowId: string }> {
  const sourceId = await corpus.seedSource(
    client,
    organizationId,
    values.sourceStatus
  );
  const rowId = await seedProjectionRow(client, organizationId, {
    entityType: corpus.entityType,
    entityId: sourceId,
    status: values.projectedStatus,
  });
  return { sourceId, rowId };
}

async function backendPid(client: Client): Promise<number> {
  const result = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid"
  );
  return result.rows[0].pid;
}

/**
 * Resolves once `pid` is waiting on a lock it has not been granted. Bounded by
 * an attempt count rather than a wall-clock deadline, and it polls a real server
 * state instead of sleeping a guessed interval.
 */
async function waitUntilBlocked(observer: Client, pid: number): Promise<void> {
  for (let attempt = 0; attempt < BLOCKED_POLL_ATTEMPTS; attempt += 1) {
    const blocked = await observer.query(
      "SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted",
      [pid]
    );
    if ((blocked.rowCount ?? 0) > 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, BLOCKED_POLL_INTERVAL_MS);
    });
  }
  throw new Error(
    `backend ${pid} never blocked on the fixture row's lock after ${BLOCKED_POLL_ATTEMPTS} attempts`
  );
}
