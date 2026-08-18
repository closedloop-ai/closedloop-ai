/**
 * @file loc-per-dollar-chunking.test.ts
 * @description ISS-5738: `loadSessionLocCost` receives a genuinely unbounded
 * session-id list (a `groupBy` with no `take`, over a session set the detail read
 * leaves uncapped on purpose). Prisma binds one parameter per `in` element and
 * Postgres rejects a statement past {@link POSTGRES_MAX_BIND_PARAMETERS} of
 * them, so the read chunks the predicate. These tests pin BOTH halves of that
 * contract: every statement stays
 * bind-safe, AND the merged map still covers the whole set — a truncating `take`
 * would silently understate the LOC/$ fold instead of failing loudly.
 *
 * The two properties chunking put at risk are pinned here too: the chunks run
 * SEQUENTIALLY (an unbounded chunk count must not become an unbounded fan-out
 * over the connection pool), and the load as a whole FAILS OPEN (many statements
 * that can each time out must not turn optional enrichment fatal).
 */
import { LOC_SOURCE_GIT } from "@repo/api/src/utils/session-loc";
import { log } from "@repo/observability/log";
import { describe, expect, it, vi } from "vitest";

// The module imports `@repo/database` only for a `typeof withDb` type and is
// called with a caller-supplied `db`; mock it so the module loads without a
// real client.
vi.mock("@repo/database", () => ({ withDb: vi.fn() }));

// The fail-open path logs; keep the real sink (and its module-load env
// warnings) out of the suite.
vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  loadSessionLocCost,
  SESSION_LOC_ID_CHUNK_SIZE,
} from "../loc-per-dollar";
import { POSTGRES_MAX_BIND_PARAMETERS } from "../org-population-reads";

const ORG = "org-1";
const CHUNK_READ_FAILURE = "canceling statement due to statement timeout";

type FindManyArgs = {
  where: { artifactId: { in: string[] } };
  take?: number;
};

/**
 * A `sessionDetail.findMany` double that answers each chunk with one row per
 * requested id. It honours `take` even though the read sets none, so that a
 * `take` added later shows up as a short merged map rather than passing
 * unnoticed.
 *
 * Each call CROSSES A TURN before it resolves and records how many calls are
 * in flight across that gap, so `peak.inFlight` distinguishes the sequential
 * loop from a `Promise.all` rewrite — which every completeness assertion here
 * would otherwise still pass. `rejectAtCall` fails the Nth chunk (1-based) to
 * drive the enrichment boundary's fail-open path.
 */
function makeFakeDb(options: { rejectAtCall?: number } = {}) {
  const peak = { inFlight: 0 };
  let inFlight = 0;
  let calls = 0;
  const findMany = vi.fn(async (args: FindManyArgs) => {
    calls += 1;
    const call = calls;
    inFlight += 1;
    peak.inFlight = Math.max(peak.inFlight, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    if (call === options.rejectAtCall) {
      throw new Error(CHUNK_READ_FAILURE);
    }
    const ids = args.where.artifactId.in;
    const returned = args.take === undefined ? ids : ids.slice(0, args.take);
    return returned.map((artifactId) => ({
      artifactId,
      linesAdded: 10,
      linesRemoved: 5,
      estimatedCost: 2,
      locSource: LOC_SOURCE_GIT,
      repositoryFullName: "acme/repo",
      branch: "main",
    }));
  });
  return {
    db: { sessionDetail: { findMany } } as unknown as Parameters<
      typeof loadSessionLocCost
    >[0],
    findMany,
    peak,
  };
}

function callArgs(findMany: ReturnType<typeof makeFakeDb>["findMany"]) {
  return findMany.mock.calls.map(([args]) => args);
}

describe("loadSessionLocCost id chunking (ISS-5738)", () => {
  // Every other assertion in this file is expressed RELATIVE to the chunk size,
  // so they all stay green if it is raised past the wire-protocol ceiling — the
  // exact defect this suite exists to prevent. This is the one absolute pin.
  it("keeps the chunk size under the Postgres bind-parameter ceiling", () => {
    expect(SESSION_LOC_ID_CHUNK_SIZE).toBeLessThan(
      POSTGRES_MAX_BIND_PARAMETERS
    );
  });

  it("issues no query for an empty id list", async () => {
    const { db, findMany } = makeFakeDb();

    const result = await loadSessionLocCost(db, ORG, []);

    expect(result.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("keeps every IN predicate within the chunk size for an over-chunk id list", async () => {
    const ids = Array.from(
      { length: SESSION_LOC_ID_CHUNK_SIZE * 2 + 1 },
      (_, i) => `s${i}`
    );
    const { db, findMany } = makeFakeDb();

    await loadSessionLocCost(db, ORG, ids);

    const args = callArgs(findMany);
    expect(args).toHaveLength(3);
    for (const arg of args) {
      expect(arg.where.artifactId.in.length).toBeLessThanOrEqual(
        SESSION_LOC_ID_CHUNK_SIZE
      );
      // Org scope rides on every chunk, not just the first.
      expect(arg.where).toMatchObject({
        artifact: { organizationId: ORG },
      });
    }
  });

  it("merges every chunk into one map, so the LOC/cost fold is not truncated", async () => {
    const ids = Array.from(
      { length: SESSION_LOC_ID_CHUNK_SIZE * 2 + 1 },
      (_, i) => `s${i}`
    );
    const { db } = makeFakeDb();

    const result = await loadSessionLocCost(db, ORG, ids);

    // Every id resolves — the first chunk, the last partial chunk, and the
    // boundary ids either side of the second chunk.
    expect(result.size).toBe(ids.length);
    for (const id of [
      "s0",
      `s${SESSION_LOC_ID_CHUNK_SIZE - 1}`,
      `s${SESSION_LOC_ID_CHUNK_SIZE}`,
      `s${ids.length - 1}`,
    ]) {
      expect(result.get(id)).toEqual({
        loc: 15,
        cost: 2,
        locSource: LOC_SOURCE_GIT,
        repositoryFullName: "acme/repo",
        branch: "main",
      });
    }
  });

  it("stays bind-safe and complete for an id set past the bind ceiling", async () => {
    // The regime the issue is actually about: an org whose whole session history
    // is folded at once. Before chunking this bound one statement to more than
    // Postgres accepts and the read 500'd outright, so this case has to prove
    // BOTH that no statement exceeds the ceiling and that nothing was dropped to
    // get there.
    const ids = Array.from(
      { length: POSTGRES_MAX_BIND_PARAMETERS * 3 },
      (_, i) => `s${i}`
    );
    const { db, findMany, peak } = makeFakeDb();

    const result = await loadSessionLocCost(db, ORG, ids);

    const args = callArgs(findMany);
    const widest = Math.max(
      ...args.map((arg) => arg.where.artifactId.in.length)
    );
    expect(widest).toBeLessThan(POSTGRES_MAX_BIND_PARAMETERS);
    // No id is queried twice and none is skipped — the chunks partition the set.
    const queried = args.flatMap((arg) => arg.where.artifactId.in);
    expect(queried).toHaveLength(ids.length);
    expect(new Set(queried).size).toBe(ids.length);
    expect(result.size).toBe(ids.length);
    // The OTHER half of the trade: the chunk count is unbounded, so the loop
    // has to stay sequential — one pooled connection at a time, never one per
    // chunk. Every assertion above survives a `Promise.all` rewrite; this is
    // the one that pins it.
    expect(peak.inFlight).toBe(1);
  });

  it("returns an empty map, never the partially filled one, when a chunk read fails", async () => {
    // LOC/$ is optional enrichment (`apps/api/AGENTS.md`), and chunking turned
    // one statement into many that can each time out. The first chunk resolves
    // and the second throws, so a map that leaked what it had would be a
    // plausible, silently understated fold — the outcome worse than none.
    // THREE chunks with the failure on the second: the loop must abort, so a
    // per-chunk catch that carried on would show up as a third call.
    const ids = Array.from(
      { length: SESSION_LOC_ID_CHUNK_SIZE * 3 },
      (_, i) => `s${i}`
    );
    const { db, findMany } = makeFakeDb({ rejectAtCall: 2 });

    const result = await loadSessionLocCost(db, ORG, ids);

    expect(result.size).toBe(0);
    expect(findMany).toHaveBeenCalledTimes(2);
    // The log is the whole reason swallowing the error is defensible — without
    // it the read fails with no operator signal at all. `chunksRead` names the
    // chunk that failed (the one after the last complete read).
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      "agent_components_loc_cost_load_failed",
      expect.objectContaining({
        chunkCount: 3,
        chunksRead: 1,
        organizationId: ORG,
        sessionCount: ids.length,
      })
    );
  });

  it("still issues a single query for an id list within the chunk size", async () => {
    const ids = Array.from(
      { length: SESSION_LOC_ID_CHUNK_SIZE },
      (_, i) => `s${i}`
    );
    const { db, findMany } = makeFakeDb();

    const result = await loadSessionLocCost(db, ORG, ids);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(SESSION_LOC_ID_CHUNK_SIZE);
  });
});
