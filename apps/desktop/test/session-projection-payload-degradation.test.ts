/**
 * @file session-projection-payload-degradation.test.ts
 * @description ISS-9286 (ISS-8743 AC 3) — what the DATA_REVISION rebuild does
 * with a payload shape THIS build did not write: a record carrying a field the
 * strict boundary does not model, and a stored row written before a later
 * revision widened the set of columns the rebuild carries across its own
 * teardown.
 *
 * WHY THIS IS NOT THE PROMOTION-GATE SUITE AGAIN. `session-projection-promotion-
 * gate.test.ts` pins the gate's POSTURE — a candidate the session view refuses
 * cannot retire the standing projection. It refuses on a value that is out of
 * bounds (an overlong `cwd`). Nothing pins what happens on the other failure
 * mode of a `.strict()` boundary: an UNRECOGNIZED KEY, which rejects the whole
 * record rather than one field, and which is the shape a version-skewed or
 * live-watcher-sourced record actually arrives in. And nothing at all runs an
 * OLDER STORED ROW through the rebuild.
 *
 * WHY THE REAL PATH. Every test here drives the production
 * `runDataRevisionRebuild` against the production `openSqliteAgentDatabase`
 * (`openTestDb`, no Electron), which tears the parser-owned rows down and
 * re-imports through `importSessionWithTx`. There is no migration chain and no
 * versioned parser to simulate: "older shape" means an older row on disk, and
 * the only honest way to observe its disposition is to put it through the same
 * transaction production uses.
 *
 * EVERY EXPECTED VALUE HERE IS AN INDEPENDENTLY-WRITTEN LITERAL. Nothing is
 * derived from `normalizedSessionSchema`, from the rebuild's own output, or from
 * a re-read of the row under test. A fixture that asks the subject what it
 * expects cannot detect the subject changing.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HarnessImportMode } from "@repo/lib/harness/types";
import { describe, test } from "vitest";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import {
  HistoricalParseWorkerResponseType,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  type RebuildTestDb,
  readSessionEventIds,
  readSessionProjectionMarkers,
  rebuildSessionFrom,
  type SessionProjectionMarkerRow,
  setSessionDataRevision,
} from "./data-revision-rebuild-test-utils.js";
import { parsedSessions } from "./historical-parse-worker-response-support.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

type Db = RebuildTestDb;

const SID = "iss9286-degradation";
/** A plain older revision — not the maintenance sentinel — so "stale" is ordinary. */
const OLDER_REVISION = 1;
const GOOD_NAME = "Standing projection";
const REPLACEMENT_NAME = "Replacement projection";
const GOOD_CWD = "/workspace/standing";
/**
 * A key no build of this repo emits. Stands in for the version-skew case the
 * `.strict()` boundary exists to catch — a field a NEWER producer added that
 * this build's schema was never taught.
 */
const UNMODELLED_FUTURE_KEY = "futureOptionalFacet";

const REPO = "owner/repo";
/** The PR whose stored row predates the lifecycle columns. */
const LEGACY_PR_NUMBER = 41;
/** The PR whose stored row already carries them — the same-target sibling. */
const ENRICHED_PR_NUMBER = 42;
const LEGACY_PR_CREATED_AT = "2025-11-02T08:15:00.000Z";
const ENRICHED_PR_CREATED_AT = "2025-11-03T08:15:00.000Z";
const ENRICHED_CLOSED_AT = "2026-06-06T00:00:01.000Z";
const ENRICHED_OPENED_AT = "2026-06-05T00:00:00.000Z";
/** The fixture session's own end instant — the `observed_at` the import offers. */
const SESSION_ENDED_AT = "2026-06-07T11:00:00.000Z";
/**
 * `pull_requests.observed_at` is resolved as the LATER of the stored value and
 * the incoming one, so the two rows are seeded to straddle the incoming value
 * and pin BOTH directions of that comparison:
 *
 *   legacy   stored AFTER  the session end -> the stored value must win
 *   enriched stored BEFORE the session end -> the incoming value must win
 *
 * Seeding both rows at the incoming value (which is what the import writes) is
 * what a test cannot do here: with stored == incoming, "pick the later" and
 * "always take incoming" and "always take the seed" are indistinguishable.
 */
const LEGACY_PR_OBSERVED_AT = "2026-08-01T00:00:00.000Z";
const ENRICHED_STORED_OBSERVED_AT = "2026-01-05T00:00:00.000Z";

type SessionMarkerRow = SessionProjectionMarkerRow;

/**
 * A `pull_requests` row, normalized. `pr_number` is coerced because the raw
 * `$queryRawUnsafe` path can surface an INTEGER column as a `bigint`, against
 * which a strict `===` on a numeric literal silently matches nothing.
 */
type PullRequestRow = {
  prNumber: number;
  closedAt: string | null;
  openedAt: string | null;
  createdAt: string | null;
  observedAt: string | null;
};

function standingSession(): NormalizedSession {
  return makePopulatedSession({
    sessionId: SID,
    name: GOOD_NAME,
    cwd: GOOD_CWD,
    toolUses: [
      {
        id: "toolu_standing",
        name: "Read",
        timestamp: "2026-06-07T10:00:35.000Z",
      },
    ],
  });
}

/** The candidate every promotion test below offers, in its well-formed form. */
function replacementSession(): NormalizedSession {
  return makePopulatedSession({
    sessionId: SID,
    name: REPLACEMENT_NAME,
    cwd: GOOD_CWD,
    toolUses: [
      {
        id: "toolu_standing",
        name: "Read",
        timestamp: "2026-06-07T10:00:35.000Z",
      },
      {
        id: "toolu_added",
        name: "Bash",
        timestamp: "2026-06-07T10:00:45.000Z",
      },
    ],
  });
}

describe("ISS-9286 unknown fields and older stored rows through the rebuild", () => {
  /**
   * `importMode` is a REAL optional member of `NormalizedSession` that
   * `normalizedSessionSchema` deliberately omits (`WorkerBoundaryOmittedSessionKeys`
   * — it is transient live-watcher context no historical parser emits). That
   * makes it the type-legal spelling of "a field the source type can carry and
   * the strict boundary does not model", needing no cast to construct.
   */
  test("a candidate carrying a field the strict boundary omits is refused, not promoted over the standing projection", async () => {
    const candidate: NormalizedSession = Object.assign(replacementSession(), {
      importMode: HarnessImportMode.LiveWatcher,
    });
    const after = await runRefusalScenario(candidate);

    assert.ok(
      after.eventsBefore.length > 0,
      "precondition: the standing projection has derived events to lose"
    );
    assert.equal(
      after.result.rebuilt,
      0,
      "a refused candidate is never promoted"
    );
    assert.equal(
      after.result.errors,
      1,
      "and is reported as a retryable failure rather than swallowed"
    );
    assert.equal(
      after.markers?.name,
      GOOD_NAME,
      "the standing projection must still be readable"
    );
    assert.equal(after.markers?.cwd, GOOD_CWD);
    assert.deepEqual(
      after.events,
      after.eventsBefore,
      "no derived row may be torn down for a candidate that was refused"
    );
    assert.equal(
      after.markers?.data_revision,
      OLDER_REVISION,
      "the older revision stays as the durable retry marker"
    );
    assert.equal(
      after.markers?.projection_candidate_revision,
      null,
      "an abandoned attempt releases its in-flight marker"
    );
  });

  test("a candidate carrying a wholly unmodelled future key is refused on the same terms", async () => {
    const candidate: NormalizedSession = Object.assign(replacementSession(), {
      [UNMODELLED_FUTURE_KEY]: { enabled: true },
    });
    const after = await runRefusalScenario(candidate);

    assert.ok(
      after.eventsBefore.length > 0,
      "precondition: the standing projection has derived events to lose"
    );
    assert.equal(after.result.rebuilt, 0);
    assert.equal(after.result.errors, 1);
    assert.equal(
      after.markers?.name,
      GOOD_NAME,
      "an unrecognized key costs the candidate, never the standing projection"
    );
    assert.deepEqual(after.events, after.eventsBefore);
    assert.equal(after.markers?.data_revision, OLDER_REVISION);
    assert.equal(after.markers?.projection_candidate_revision, null);
  });

  /**
   * The sibling for both refusals above, on the SAME targets in the opposite
   * state: strip the unmodelled key and the very same payload replaces the
   * standing projection. Without this the two tests above would pass against a
   * rebuild that had stopped promoting anything at all.
   */
  test("the identical candidate without the unmodelled key is promoted and replaces the projection", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss9286-promote-"));
    const db = await openTestDb(dir);
    try {
      await seedStanding(db);
      const eventsBefore = await readEventIds(db);
      const result = await rebuildWith(db, replacementSession());

      assert.equal(result.rebuilt, 1, "a well-formed candidate is promoted");
      assert.equal(result.errors, 0);
      const markers = await readMarkers(db);
      assert.equal(
        markers?.name,
        REPLACEMENT_NAME,
        "the same target the refusals held at the standing value does move here"
      );
      assert.equal(markers?.data_revision, effectiveDataRevision());
      assert.notDeepEqual(
        await readEventIds(db),
        eventsBefore,
        "and the derived rows the refusals preserved are genuinely re-derived here"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * ISS-4606 widened the rebuild's read-before-delete seed from
   * `created_at`/`observed_at` to also carry `closed_at`/`opened_at`. A row
   * written before that widening — or before enrichment ever reached it — has
   * those two NULL. This is that row, put through the real
   * teardown-and-reimport beside a row that has them, so both dispositions are
   * observed in ONE rebuild.
   *
   * The stated disposition: the row is re-inserted, never erased; an absent
   * lifecycle column stays absent rather than being fabricated or defaulted to a
   * string; and `created_at` rides across on the seed instead of being reset to
   * the import clock.
   */
  test("an older stored PR row missing the later-added lifecycle columns is preserved absent, never fabricated", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss9286-legacy-row-"));
    const db = await openTestDb(dir);
    try {
      const session = sessionWithPullRequests();
      await db.importer.importSession(session, "claude");
      await seedLegacyShapePullRequest(db);
      await seedEnrichedPullRequest(db);

      assert.deepEqual(
        await readPullRequests(db),
        [
          {
            prNumber: LEGACY_PR_NUMBER,
            closedAt: null,
            openedAt: null,
            createdAt: LEGACY_PR_CREATED_AT,
          },
          {
            prNumber: ENRICHED_PR_NUMBER,
            closedAt: ENRICHED_CLOSED_AT,
            openedAt: ENRICHED_OPENED_AT,
            createdAt: ENRICHED_PR_CREATED_AT,
          },
        ],
        "precondition: one row in the older shape, one in the current shape"
      );

      await markStale(db);
      const result = await rebuildWith(db, session);
      assert.equal(result.rebuilt, 1, "precondition: the session was rebuilt");
      assert.equal(result.errors, 0);

      const rows = await readPullRequestRows(db);
      assert.equal(
        rows.length,
        2,
        "both rows survive the teardown — an older shape is not an erasure"
      );

      const legacy = rows.find((row) => row.prNumber === LEGACY_PR_NUMBER);
      assert.equal(
        legacy?.closedAt,
        null,
        "an absent lifecycle instant stays absent — the rebuild must not invent one"
      );
      assert.equal(legacy?.openedAt, null);
      assert.equal(
        legacy?.createdAt,
        LEGACY_PR_CREATED_AT,
        "first-observation provenance rides the seed rather than resetting to the import clock"
      );
      assert.equal(
        legacy?.observedAt,
        LEGACY_PR_OBSERVED_AT,
        "a stored observation LATER than the session end outlives the import's own"
      );

      // The same targets, opposite state, from the same rebuild: a row that HAS
      // the later-added columns keeps their values, so the assertions above pin
      // "absent stays absent", not "the columns are always null" — and its
      // stored observation, being EARLIER, loses to the import's.
      const enriched = rows.find((row) => row.prNumber === ENRICHED_PR_NUMBER);
      assert.equal(enriched?.closedAt, ENRICHED_CLOSED_AT);
      assert.equal(enriched?.openedAt, ENRICHED_OPENED_AT);
      assert.equal(enriched?.createdAt, ENRICHED_PR_CREATED_AT);
      assert.equal(
        enriched?.observedAt,
        SESSION_ENDED_AT,
        "a stored observation EARLIER than the session end loses to the import's"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The boundary round trip, carried one leg further than the existing ones.
   * `historical-parse-worker-payload-clamped-signal.test.ts` already round-trips
   * a response through the strict schema and stops at the parsed object. This
   * takes the SCHEMA'S OWN OUTPUT — not the original in-memory session — into
   * the real rebuild and asserts what landed in SQLite, so a field the boundary
   * quietly dropped or coerced is caught as a wrong projection rather than as a
   * still-passing schema assertion.
   */
  test("a session round-tripped through the strict worker boundary rebuilds to the same projection", async () => {
    const wire = JSON.parse(
      JSON.stringify({
        type: HistoricalParseWorkerResponseType.Parsed,
        requestId: "iss9286-round-trip",
        sessions: [replacementSession()],
      })
    );
    const parsed = historicalParseWorkerResponseSchema.safeParse(wire);
    assert.equal(
      parsed.success,
      true,
      "the clean payload crosses the boundary — the sibling for the rejection below"
    );
    const [crossed] = parsedSessions(parsed);
    assert.ok(crossed, "the boundary returned a session");

    const dir = await mkdtemp(path.join(os.tmpdir(), "iss9286-round-trip-"));
    const db = await openTestDb(dir);
    try {
      await seedStanding(db);
      const result = await rebuildWith(db, crossed);
      assert.equal(result.rebuilt, 1);
      assert.equal(result.errors, 0);

      const markers = await readMarkers(db);
      assert.equal(markers?.name, REPLACEMENT_NAME);
      assert.equal(markers?.cwd, GOOD_CWD);
      assert.equal(markers?.data_revision, effectiveDataRevision());
      assert.deepEqual(
        await readEventToolNames(db),
        ["Bash", "Read"],
        "both tool uses survived the wire, the schema, and the re-import"
      );
      assert.deepEqual(
        await readSessionTimestamps(db),
        {
          startedAt: "2026-06-07T10:00:00.000Z",
          endedAt: "2026-06-07T11:00:00.000Z",
          model: "claude-sonnet-4-5",
        },
        "the scalar spine round-trips byte-identically"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the same wire payload carrying an unmodelled session key is refused by the boundary itself", () => {
    const wire = JSON.parse(
      JSON.stringify({
        type: HistoricalParseWorkerResponseType.Parsed,
        requestId: "iss9286-round-trip",
        sessions: [
          Object.assign(replacementSession(), {
            [UNMODELLED_FUTURE_KEY]: { enabled: true },
          }),
        ],
      })
    );
    const parsed = historicalParseWorkerResponseSchema.safeParse(wire);

    assert.equal(
      parsed.success,
      false,
      "an unrecognized session key rejects the whole response, so nothing reaches the importer"
    );
    assert.ok(
      !parsed.success &&
        JSON.stringify(parsed.error.issues).includes(UNMODELLED_FUTURE_KEY),
      "and the diagnostic names the offending key rather than failing anonymously"
    );
  });
});

async function seedStanding(db: Db): Promise<void> {
  await db.importer.importSession(standingSession(), "claude");
  await markStale(db);
}

/**
 * Run one refusal scenario against its own database: import the standing
 * projection, offer `candidate`, and report everything the assertions need. The
 * before/after event ids are read inside so a caller cannot accidentally compare
 * a snapshot to itself.
 */
async function runRefusalScenario(candidate: NormalizedSession) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss9286-refusal-"));
  const db = await openTestDb(dir);
  try {
    await db.importer.importSession(standingSession(), "claude");
    const eventsBefore = await readEventIds(db);
    await markStale(db);

    const result = await rebuildWith(db, candidate);
    return {
      result,
      eventsBefore,
      events: await readEventIds(db),
      markers: await readMarkers(db),
    };
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function rebuildWith(db: Db, candidate: NormalizedSession) {
  return rebuildSessionFrom(db, SID, candidate);
}

function sessionWithPullRequests(): NormalizedSession {
  return makePopulatedSession({
    sessionId: SID,
    name: GOOD_NAME,
    cwd: GOOD_CWD,
    artifacts: {
      prs: [LEGACY_PR_NUMBER, ENRICHED_PR_NUMBER].map((number) => ({
        number: String(number),
        repo: REPO,
        url: `https://github.com/${REPO}/pull/${number}`,
      })),
      issues: [],
      repo: REPO,
    },
  });
}

/**
 * Rewrite one row into the shape a build predating the lifecycle columns left on
 * disk: the two enrichment columns NULL, with a `created_at` older than any
 * clock this test run can produce.
 */
async function seedLegacyShapePullRequest(db: Db): Promise<void> {
  await db.run(
    `UPDATE pull_requests
        SET closed_at = NULL, opened_at = NULL,
            created_at = $1, observed_at = $2
      WHERE repo_full_name = $3 AND pr_number = $4`,
    LEGACY_PR_CREATED_AT,
    LEGACY_PR_OBSERVED_AT,
    REPO,
    LEGACY_PR_NUMBER
  );
}

async function seedEnrichedPullRequest(db: Db): Promise<void> {
  await db.run(
    `UPDATE pull_requests
        SET closed_at = $1, opened_at = $2,
            created_at = $3, observed_at = $4
      WHERE repo_full_name = $5 AND pr_number = $6`,
    ENRICHED_CLOSED_AT,
    ENRICHED_OPENED_AT,
    ENRICHED_PR_CREATED_AT,
    ENRICHED_STORED_OBSERVED_AT,
    REPO,
    ENRICHED_PR_NUMBER
  );
}

// Bound to this suite's session id; the statements themselves are shared so a
// sibling rebuild suite cannot drift away from what this one asserts on.
function markStale(db: Db): Promise<void> {
  return setSessionDataRevision(db, SID, OLDER_REVISION);
}

function readMarkers(db: Db): Promise<SessionMarkerRow | undefined> {
  return readSessionProjectionMarkers(db, SID);
}

function readEventIds(db: Db): Promise<string[]> {
  return readSessionEventIds(db, SID);
}

async function readEventToolNames(db: Db): Promise<string[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{ tool_name: string | null }>
  >(
    `SELECT tool_name FROM events
      WHERE session_id = $1 AND tool_name IS NOT NULL
      ORDER BY tool_name`,
    SID
  );
  return rows.map((row) => row.tool_name ?? "");
}

async function readSessionTimestamps(db: Db) {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{
      started_at: string | null;
      ended_at: string | null;
      model: string | null;
    }>
  >("SELECT started_at, ended_at, model FROM sessions WHERE id = $1", SID);
  return {
    startedAt: rows[0]?.started_at,
    endedAt: rows[0]?.ended_at,
    model: rows[0]?.model,
  };
}

async function readPullRequestRows(db: Db): Promise<PullRequestRow[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{
      pr_number: number | bigint;
      closed_at: string | null;
      opened_at: string | null;
      created_at: string | null;
      observed_at: string | null;
    }>
  >(
    `SELECT pr_number, closed_at, opened_at, created_at, observed_at
       FROM pull_requests WHERE session_id = $1 ORDER BY pr_number`,
    SID
  );
  return rows.map((row) => ({
    // Coerced once, here, so every caller compares the same kind of value: the
    // raw read can hand back a `bigint`, which no `=== 41` will ever match.
    prNumber: Number(row.pr_number),
    closedAt: row.closed_at,
    openedAt: row.opened_at,
    createdAt: row.created_at,
    observedAt: row.observed_at,
  }));
}

/** The precondition view — `observed_at` is asserted after the rebuild instead. */
async function readPullRequests(db: Db) {
  const rows = await readPullRequestRows(db);
  return rows.map(({ observedAt: _omitted, ...rest }) => rest);
}
