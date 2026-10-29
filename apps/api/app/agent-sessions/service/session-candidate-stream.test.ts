import type { Prisma } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_CANDIDATE_KEYSET_ORDER_BY,
  selectOrderedSessionWindow,
} from "./session-candidate-stream";

/**
 * ISS-6892 — direct coverage for the keyset window selector. The service-level
 * suites prove the ORDER a Sessions page emits; these prove the selector's own
 * boundaries, which a ~10,000-row integration fixture cannot reach at all
 * (`limit <= 0`, `offset >= total`, an empty population) and cannot pin exactly
 * (the trim threshold, the head-vs-tail edge choice).
 */

type Row = {
  artifactId: string;
  /**
   * A MUTABLE `SessionDetail` column, stamped so lexicographic order matches
   * chronological order. Nothing ranks on it — it exists so the fixture can be
   * traversed in the production scan order when that order is a column a
   * concurrent write moves. Rewriting a row makes this the latest stamp in the
   * population, exactly as a session written mid-walk would.
   */
  lastActivityAt: string;
  rank: number;
};

const BASE_WHERE: Prisma.SessionDetailWhereInput = {
  artifact: { is: { organizationId: "org-1" } },
};

/** Ascending by `rank`, closed with the unique id — a TOTAL order, as required. */
function byRank(a: Row, b: Row): number {
  if (a.rank !== b.rank) {
    return a.rank - b.rank;
  }
  return a.artifactId < b.artifactId ? -1 : 1;
}

/**
 * `stride` leaves gaps between the generated ids so a boundary-mutation test can
 * insert a row that sorts strictly BELOW or ABOVE a chosen cursor. Ids stay
 * zero-padded to a fixed width, so lexicographic order — what the keyset walk
 * and Postgres both compare on — matches numeric order.
 */
function buildPopulation(size: number, stride = 1): Row[] {
  return Array.from({ length: size }, (_unused, index) => ({
    artifactId: `s-${String(index * stride).padStart(4, "0")}`,
    // Seeded in step with the ids, so the two candidate scan orders agree until
    // a write moves a row — which is the only thing that tells them apart.
    lastActivityAt: `t-${String(index).padStart(4, "0")}`,
    // Rank is the REVERSE of the scan order, so a result that merely reflects
    // the keyset walk instead of the comparator is immediately visible.
    rank: size - index,
  }));
}

/**
 * A walk that stopped narrowing its cursor would re-serve the same chunk
 * forever, so the fake caps its reads. Well above the deepest walk here (a
 * 200-row population in chunks of 5 issues 41), so only a non-terminating walk
 * can reach it.
 */
const MAX_CHUNK_READS = 200;

/**
 * The cursor a chunk resumed from, or `undefined` for the first chunk (which
 * carries the caller's bare `where`).
 *
 * Throws when an AND-carrying `where` has any other second conjunct — a
 * `gt` -> `gte` regression would otherwise leave this fake unable to see a
 * cursor, restart from row 0 on every read, and HANG the suite, which is not a
 * counterfactual but a timeout. A resume that dropped the AND entirely reads as
 * a first chunk here and is caught instead by {@link MAX_CHUNK_READS}.
 */
function resolveChunkCursor(
  chunkWhere: Prisma.SessionDetailWhereInput
): string | undefined {
  if (!Array.isArray(chunkWhere.AND)) {
    return undefined;
  }
  const bound = chunkWhere.AND[1] as
    | { artifactId?: { gt?: unknown } }
    | undefined;
  const cursor = bound?.artifactId?.gt;
  if (typeof cursor !== "string") {
    throw new Error(
      `keyset chunk carried no \`artifactId > cursor\` bound: ${JSON.stringify(bound)}`
    );
  }
  return cursor;
}

/**
 * The single ascending column the PRODUCTION scan orders by, taken from the
 * constant both `findMany` calls in `list-page-fetch.ts` hand to `orderBy` —
 * read, never restated. {@link byScanKey} traverses the fixture in it, so
 * switching the production constant to a mutable column changes the order this
 * suite's rows arrive in and the mutation cases below fail. Restating
 * `artifactId` here instead would leave those cases asserting an invariant of a
 * scan order production had stopped using.
 *
 * The walk's own resume clause is NOT read from here: it is whatever
 * `selectOrderedSessionWindow` emits, which {@link resolveChunkCursor} reads off
 * the chunk `where`. Keeping the two separate is what lets the fixture expose a
 * scan order and a resume key that no longer agree.
 */
function resolveKeysetScanKey(
  orderBy: readonly Prisma.SessionDetailOrderByWithRelationInput[]
): string {
  const entries: [string, unknown][] = Object.entries(orderBy[0] ?? {});
  const [key, direction] = entries[0] ?? [];
  if (
    orderBy.length !== 1 ||
    entries.length !== 1 ||
    key === undefined ||
    direction !== "asc"
  ) {
    throw new Error(
      `this fixture models ONE ascending keyset column; production declares ${JSON.stringify(orderBy)}`
    );
  }
  return key;
}

const KEYSET_SCAN_KEY = resolveKeysetScanKey(SESSION_CANDIDATE_KEYSET_ORDER_BY);

/**
 * How the fixture reads each scan column it models. A `Map` so a column name
 * arriving from the production constant can never resolve to an inherited
 * member.
 */
const SCAN_KEY_READERS = new Map<string, (row: Row) => string>([
  ["artifactId", (row) => row.artifactId],
  ["lastActivityAt", (row) => row.lastActivityAt],
]);

function readScanKey(row: Row): string {
  const read = SCAN_KEY_READERS.get(KEYSET_SCAN_KEY);
  if (read === undefined) {
    throw new Error(
      `production scans on \`${KEYSET_SCAN_KEY}\`, which this fixture does not model — add it to SCAN_KEY_READERS so these cases exercise the order production actually uses`
    );
  }
  return read(row);
}

/** The production scan order, applied to the fixture's rows. */
function byScanKey(a: Row, b: Row): number {
  const left = readScanKey(a);
  const right = readScanKey(b);
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * A fetcher over `population` that honors the keyset `artifactId > cursor`
 * clause and `take` exactly as Postgres would, orders what survives that clause
 * by {@link KEYSET_SCAN_KEY} — the production `orderBy` — and records every
 * chunk `where` so a test can prove the caller's scope was ANDed, never
 * replaced.
 *
 * `population` is read LIVE on every chunk and rows are returned as copies, so a
 * boundary-mutation test can write to it between chunks exactly as a concurrent
 * transaction would, without retroactively editing a chunk already served.
 * `onChunk` fires after a chunk is served and before the next is read — the
 * deterministic interleaving point, in place of racing a real clock.
 */
function buildFetcher(
  population: Row[],
  onChunk?: (chunkIndex: number, cursorId: string) => void
) {
  const seen: Prisma.SessionDetailWhereInput[] = [];
  const servedIds: string[] = [];
  let reads = 0;
  const fetchChunk = vi
    .fn()
    .mockImplementation(
      (chunkWhere: Prisma.SessionDetailWhereInput, take: number) => {
        reads += 1;
        if (reads > MAX_CHUNK_READS) {
          throw new Error(
            `keyset walk issued ${reads} chunk reads without terminating`
          );
        }
        seen.push(chunkWhere);
        const after = resolveChunkCursor(chunkWhere);
        // WHERE, then the production ORDER BY, then LIMIT — the three steps in
        // the order Postgres applies them, so a resume key and a scan order that
        // have stopped agreeing produce the page they really would.
        const chunk = population
          .filter((row) => after === undefined || row.artifactId > after)
          .sort(byScanKey)
          .slice(0, take)
          .map((row) => ({ ...row }));
        servedIds.push(...chunk.map((row) => row.artifactId));
        const cursorId = chunk.at(-1)?.artifactId;
        if (cursorId !== undefined) {
          onChunk?.(reads, cursorId);
        }
        return Promise.resolve(chunk);
      }
    );
  return { fetchChunk, seen, servedIds };
}

const identityMap = (rows: readonly Row[]) => Promise.resolve([...rows]);

async function selectWindow(
  population: Row[],
  args: {
    offset: number;
    limit: number;
    chunkSize?: number;
    total?: number;
    onChunk?: (chunkIndex: number, cursorId: string) => void;
  }
) {
  const { fetchChunk, seen, servedIds } = buildFetcher(
    population,
    args.onChunk
  );
  const items = await selectOrderedSessionWindow<Row, Row>({
    where: BASE_WHERE,
    offset: args.offset,
    limit: args.limit,
    total: args.total ?? population.length,
    compare: byRank,
    fetchChunk,
    mapChunk: identityMap,
    chunkSize: args.chunkSize ?? 10,
  });
  return { items, fetchChunk, seen, servedIds };
}

/** The window the caller asked for, computed the naive whole-population way. */
function expectedIds(population: Row[], offset: number, limit: number) {
  return [...population]
    .sort(byRank)
    .slice(offset, offset + limit)
    .map((row) => row.artifactId);
}

describe("selectOrderedSessionWindow (ISS-6892)", () => {
  it("returns the head window in comparator order, not scan order", async () => {
    const population = buildPopulation(95);
    const { items } = await selectWindow(population, { offset: 0, limit: 5 });

    expect(items.map((row) => row.artifactId)).toEqual(
      expectedIds(population, 0, 5)
    );
    // Rank is the reverse of the keyset walk, so the last-scanned row leads.
    expect(items[0]?.artifactId).toBe("s-0094");
  });

  it("returns a mid window identical to a whole-population sort", async () => {
    const population = buildPopulation(95);
    const { items } = await selectWindow(population, { offset: 40, limit: 7 });

    expect(items.map((row) => row.artifactId)).toEqual(
      expectedIds(population, 40, 7)
    );
  });

  it("resolves a deep window near the end of the population", async () => {
    const population = buildPopulation(95);
    const { items } = await selectWindow(population, { offset: 90, limit: 3 });

    expect(items.map((row) => row.artifactId)).toEqual(
      expectedIds(population, 90, 3)
    );
  });

  it("clips a window that runs past the end of the population", async () => {
    const population = buildPopulation(95);
    const { items } = await selectWindow(population, { offset: 93, limit: 10 });

    expect(items.map((row) => row.artifactId)).toEqual(
      expectedIds(population, 93, 10)
    );
    expect(items).toHaveLength(2);
  });

  it("keeps the right rows when the scan trims mid-walk", async () => {
    // `keep` (12) is far below the population, so the window is trimmed on
    // every chunk after the first. Trimming must discard only rows that can no
    // longer place, which a naive `slice` of the untrimmed buffer would not.
    const population = buildPopulation(200);
    const { items, fetchChunk } = await selectWindow(population, {
      offset: 8,
      limit: 4,
      chunkSize: 5,
    });

    expect(items.map((row) => row.artifactId)).toEqual(
      expectedIds(population, 8, 4)
    );
    expect(fetchChunk.mock.calls.length).toBeGreaterThan(1);
  });

  it("positions a deep page against the SCANNED rows, not the counted total", async () => {
    // `total` comes from a separate `count(where)` on a separate snapshot, and
    // sessions are written continuously — so it can over- or under-state what
    // the walk goes on to see. The page must be the true `[offset, offset+limit)`
    // of the rows actually visited either way; keying its position off `total`
    // shifts the page by the drift and can make a rank unreachable.
    const population = buildPopulation(95);

    const staleHigh = await selectWindow(population, {
      offset: 90,
      limit: 3,
      total: 130,
    });
    const staleLow = await selectWindow(population, {
      offset: 90,
      limit: 3,
      total: 95,
    });

    expect(staleHigh.items.map((row) => row.artifactId)).toEqual(
      expectedIds(population, 90, 3)
    );
    expect(staleLow.items.map((row) => row.artifactId)).toEqual(
      staleHigh.items.map((row) => row.artifactId)
    );
  });

  it("reads nothing when the offset is at or past the population", async () => {
    const population = buildPopulation(20);
    const { items, fetchChunk } = await selectWindow(population, {
      offset: 20,
      limit: 10,
    });

    expect(items).toEqual([]);
    expect(fetchChunk).not.toHaveBeenCalled();
  });

  it("reads nothing for a non-positive limit or an empty population", async () => {
    const population = buildPopulation(20);
    const zeroLimit = await selectWindow(population, { offset: 0, limit: 0 });
    expect(zeroLimit.items).toEqual([]);
    expect(zeroLimit.fetchChunk).not.toHaveBeenCalled();

    const emptyPopulation = await selectWindow([], {
      offset: 0,
      limit: 10,
      total: 0,
    });
    expect(emptyPopulation.items).toEqual([]);
    expect(emptyPopulation.fetchChunk).not.toHaveBeenCalled();
  });

  it("stops on an empty chunk rather than walking forever", async () => {
    // `total` overstates the rows the fetcher can actually produce (a row
    // deleted between the count and the scan). The walk must end on the empty
    // chunk instead of re-issuing the same cursor.
    const population = buildPopulation(12);
    const { items, fetchChunk } = await selectWindow(population, {
      offset: 0,
      limit: 5,
      chunkSize: 12,
      total: 60,
    });

    expect(items.map((row) => row.artifactId)).toEqual(
      expectedIds(population, 0, 5)
    );
    expect(fetchChunk).toHaveBeenCalledTimes(2);
  });

  it("ANDs the keyset bound onto the caller's where, never replaces it", async () => {
    const population = buildPopulation(30);
    const { seen } = await selectWindow(population, {
      offset: 0,
      limit: 5,
      chunkSize: 10,
    });

    expect(seen[0]).toBe(BASE_WHERE);
    for (const chunkWhere of seen.slice(1)) {
      const conjuncts = Array.isArray(chunkWhere.AND) ? chunkWhere.AND : [];
      // The org scope stays the FIRST conjunct; the cursor can only narrow it.
      expect(conjuncts[0]).toBe(BASE_WHERE);
      expect(conjuncts[1]).toEqual({
        artifactId: { gt: expect.any(String) },
      });
    }
  });
});

/** 40 rows in chunks of 10: four crossed page boundaries, not one. */
const MUTATION_POPULATION_SIZE = 40;
/** Gaps of 10 leave room for an id that sorts strictly between two existing ones. */
const MUTATION_POPULATION_STRIDE = 10;
const MUTATION_CHUNK_SIZE = 10;
const MUTATION_WINDOW_OFFSET = 0;
const MUTATION_WINDOW_LIMIT = 5;

type BoundaryMutation = (population: Row[], cursorId: string) => void;

/**
 * A `lastActivityAt` strictly after every stamp in `population`: the row was
 * written just now. Appending to the current maximum keeps that true for
 * successive writes without a shared clock between tests.
 */
function nextWriteStamp(population: readonly Row[]): string {
  const latest = population.reduce(
    (max, row) => (row.lastActivityAt > max ? row.lastActivityAt : max),
    ""
  );
  return `${latest}z`;
}

function insertRow(population: Row[], row: Omit<Row, "lastActivityAt">): void {
  if (population.some((existing) => existing.artifactId === row.artifactId)) {
    throw new Error(`insert would duplicate ${row.artifactId}`);
  }
  population.push({ ...row, lastActivityAt: nextWriteStamp(population) });
  population.sort((a, b) => (a.artifactId < b.artifactId ? -1 : 1));
}

function removeRow(population: Row[], artifactId: string): void {
  const index = population.findIndex((row) => row.artifactId === artifactId);
  if (index < 0) {
    throw new Error(`cannot delete absent row ${artifactId}`);
  }
  population.splice(index, 1);
}

/**
 * One session rewritten mid-walk. Both halves of a real write land: the value
 * the caller's comparator ranks on moves, AND `lastActivityAt` becomes the
 * population's latest — so under a keyset order on that mutable column the row
 * moves in the SCAN too, which is the regression the mutable-key case exists to
 * catch.
 */
function rewriteRow(population: Row[], artifactId: string, rank: number): void {
  const row = population.find(
    (candidate) => candidate.artifactId === artifactId
  );
  if (row === undefined) {
    throw new Error(`cannot rewrite absent row ${artifactId}`);
  }
  row.rank = rank;
  row.lastActivityAt = nextWriteStamp(population);
}

/**
 * Runs one walk, applying `mutations[chunkIndex]` after that chunk is served and
 * before the next is read. The write lands at a KNOWN point in the read
 * sequence, so the proof is that the sequence is correct — never that a timer
 * elapsed.
 */
async function walkUnderMutation(mutations: Map<number, BoundaryMutation>) {
  const population = buildPopulation(
    MUTATION_POPULATION_SIZE,
    MUTATION_POPULATION_STRIDE
  );
  const originalIds = population.map((row) => row.artifactId);
  const boundaries: string[] = [];
  const { items, servedIds } = await selectWindow(population, {
    offset: MUTATION_WINDOW_OFFSET,
    limit: MUTATION_WINDOW_LIMIT,
    chunkSize: MUTATION_CHUNK_SIZE,
    onChunk: (chunkIndex, cursorId) => {
      boundaries.push(cursorId);
      mutations.get(chunkIndex)?.(population, cursorId);
    },
  });
  return { items, servedIds, originalIds, boundaries };
}

/**
 * Ids as a sorted MULTISET. Comparing two of these fails on a skipped row AND on
 * a duplicated row — which a served-row count, or a `new Set` size check, would
 * not: those stay green when one row is dropped and another repeated. Comparing
 * against a non-empty expected set also fails a walk that errored out early and
 * served nothing.
 */
function servedMultiset(ids: readonly string[]): string[] {
  return [...ids].sort();
}

/**
 * ISS-9623 — the walk's own chunk-boundary invariant, independent of caller
 * transaction semantics.
 *
 * These model an UNSNAPSHOTTED caller: the fake re-reads the population on every
 * chunk, so a write between chunks is visible to the next one. Production is
 * stricter — `withSessionListSnapshot` (`list-page-fetch.ts`) wraps every call
 * in one `RepeatableRead` snapshot, so a Sessions list page sees no concurrent
 * write at all. That makes this the SECOND of two independent guarantees, and
 * the only one a future caller that forgets the wrapper would still have.
 *
 * Deliberately NOT covered: a pinned-snapshot fixture. Modelling it means a fake
 * that withholds the writes, so it would assert only that a fetcher which never
 * sees a write yields a walk that never sees one — a restatement of the fixture,
 * and an attempt to prove Postgres's isolation guarantee against a mock.
 *
 * Boundaries here are CHUNK boundaries inside one traversal. One request is one
 * whole walk, so none of this speaks to the across-request page boundary.
 *
 * The fetcher traverses in {@link KEYSET_SCAN_KEY}, read from the production
 * `orderBy` constant (codex review, thread 3964094642). Without that these cases
 * would hold a scan order of their own: `artifactId` would stay immutable here
 * however production scanned, and the mutable-key regression they name could
 * land with every one of them green.
 */
describe("selectOrderedSessionWindow chunk boundaries under live mutation (ISS-9623)", () => {
  it("serves a row inserted ABOVE the cursor exactly once, and ranks it", async () => {
    // Regression: a walk that bounded itself by the up-front `count(where)`, or
    // by the population size it started with, never sees a session written past
    // its cursor mid-walk.
    const { items, servedIds, originalIds, boundaries } =
      await walkUnderMutation(
        new Map<number, BoundaryMutation>([
          [
            1,
            (population) =>
              insertRow(population, { artifactId: "s-0155", rank: 0 }),
          ],
        ])
      );

    expect(boundaries[0]).toBe("s-0090");
    expect(servedMultiset(servedIds)).toEqual(
      servedMultiset([...originalIds, "s-0155"])
    );
    // Not merely visited — the new row's rank places it at the head of the page.
    expect(items.map((row) => row.artifactId)).toEqual([
      "s-0155",
      "s-0390",
      "s-0380",
      "s-0370",
      "s-0360",
    ]);
  });

  it("omits a row inserted BELOW the cursor without disturbing its neighbours", async () => {
    // The one case this walk cannot serve, and why the module DISCLOSES it
    // rather than fixing it. Regression: the omission must stay confined to the
    // new row — an implementation that re-seeked to pick it up would re-serve
    // or skip the rows around it.
    const { items, servedIds, originalIds } = await walkUnderMutation(
      new Map<number, BoundaryMutation>([
        [
          1,
          (population) =>
            insertRow(population, { artifactId: "s-0055", rank: 0 }),
        ],
      ])
    );

    expect(servedIds).not.toContain("s-0055");
    expect(servedMultiset(servedIds)).toEqual(servedMultiset(originalIds));
    // Rank 0 would have led the page had the row been reachable; it is not.
    expect(items.map((row) => row.artifactId)).toEqual([
      "s-0390",
      "s-0380",
      "s-0370",
      "s-0360",
      "s-0350",
    ]);
  });

  it("resumes past a deleted cursor row without stalling or skipping its successor", async () => {
    // Regression: resuming through a ROW REFERENCE (Prisma `cursor: {artifactId}`
    // plus `skip: 1`) loses its place when that exact row is deleted between
    // pages. Comparing the key by VALUE does not.
    const { servedIds, originalIds, boundaries } = await walkUnderMutation(
      new Map<number, BoundaryMutation>([
        [1, (population, cursorId) => removeRow(population, cursorId)],
      ])
    );

    expect(boundaries[0]).toBe("s-0090");
    // `s-0090` was served before it was deleted, and `s-0100` — the successor a
    // walk that lost its place would skip — is served exactly once.
    expect(servedMultiset(servedIds)).toEqual(servedMultiset(originalIds));
  });

  it("neither re-visits nor skips a row whose SORT KEY is updated mid-walk", async () => {
    // Regression: pointing `SESSION_CANDIDATE_KEYSET_ORDER_BY` at a MUTABLE
    // column (`lastActivityAt`) instead of the primary key. Both rows here are
    // rewritten, so each moves to the END of a `lastActivityAt` scan: the
    // already-read one lands back above the cursor, and the not-yet-read one
    // ends up behind it and is never served. The fixture traverses in the
    // production order, so that swap fails this case rather than passing under
    // a scan order production no longer uses.
    const { items, servedIds, originalIds } = await walkUnderMutation(
      new Map<number, BoundaryMutation>([
        [
          1,
          (population) => {
            rewriteRow(population, "s-0090", -5);
            rewriteRow(population, "s-0250", -9);
          },
        ],
      ])
    );

    expect(servedMultiset(servedIds)).toEqual(servedMultiset(originalIds));
    // The not-yet-read row carries its NEW rank. The already-read `s-0090` keeps
    // the rank the scan actually saw, so it does not re-enter the page.
    expect(items.map((row) => row.artifactId)).toEqual([
      "s-0250",
      "s-0390",
      "s-0380",
      "s-0370",
      "s-0360",
    ]);
  });

  it("does not skip a row when an already-served row below the cursor is deleted", async () => {
    // Regression: `skip`/`take` pagination. Deleting a row from page 1 shifts
    // page 2 back by one and silently drops a session. A keyset cursor is
    // unaffected by what happens behind it, so `s-0200` is still served.
    const { servedIds, originalIds, boundaries } = await walkUnderMutation(
      new Map<number, BoundaryMutation>([
        [2, (population) => removeRow(population, "s-0050")],
      ])
    );

    expect(boundaries[1]).toBe("s-0190");
    expect(servedMultiset(servedIds)).toEqual(servedMultiset(originalIds));
  });

  it("serves every reachable row exactly once with a write at EVERY boundary", async () => {
    // The decisive property, over a corpus with four boundaries and a different
    // mutation shape at each: the multiset of served ids is exactly the rows
    // that were present and above the cursor, each once.
    const { items, servedIds, originalIds, boundaries } =
      await walkUnderMutation(
        new Map<number, BoundaryMutation>([
          [
            1,
            (population) =>
              insertRow(population, { artifactId: "s-0155", rank: 0 }),
          ],
          [2, (population, cursorId) => removeRow(population, cursorId)],
          [
            3,
            (population) =>
              insertRow(population, { artifactId: "s-0055", rank: 0 }),
          ],
          [4, (population) => rewriteRow(population, "s-0390", -5)],
        ])
      );

    expect(boundaries).toEqual([
      "s-0090",
      "s-0180",
      "s-0280",
      "s-0380",
      "s-0390",
    ]);
    // `s-0180` was served before it was deleted; `s-0055` landed behind the
    // cursor and is unreachable until the next request.
    expect(servedMultiset(servedIds)).toEqual(
      servedMultiset([...originalIds, "s-0155"])
    );
    expect(items.map((row) => row.artifactId)).toEqual([
      "s-0390",
      "s-0155",
      "s-0380",
      "s-0370",
      "s-0360",
    ]);
  });

  it("fails loudly on a resume bound that is not `artifactId > cursor`", () => {
    // The counterfactual for every test above is a `gt` -> `gte` regression,
    // which re-serves the cursor row forever. Without this the fake would give
    // that mutation a HANG instead of a failure, and a hang proves nothing.
    const { fetchChunk } = buildFetcher(
      buildPopulation(MUTATION_POPULATION_SIZE, MUTATION_POPULATION_STRIDE)
    );

    expect(() =>
      fetchChunk(
        { AND: [BASE_WHERE, { artifactId: { gte: "s-0090" } }] },
        MUTATION_CHUNK_SIZE
      )
    ).toThrow("artifactId > cursor");
  });
});

/**
 * ISS-9627 — the read-path budget for the one walk ISS-6892 deliberately left
 * uncapped, counted in READS, ROWS PER READ and PEAK RESIDENCY rather than in
 * wall time.
 *
 * Uncapping the population made those three numbers the whole safety argument:
 * the walk may visit every matching row (that is the availability guarantee),
 * but it must visit each row exactly once, never hold more than a window plus
 * the chunks in flight, and never widen a single request past `chunkSize`. A
 * regression in any of them reads as a timeout or an OOM on a large org, which
 * is the pressure that produced the 10,000-row ceiling in the first place, and
 * none of the correctness cases above can see it.
 *
 * WHAT THIS FILE CAN AND CANNOT COUNT (codex review, thread 3962328667). The
 * suite supplies `fetchChunk`/`mapChunk`, so what it observes is how often the
 * WALK invoked the seams it was handed — the walk's own contract, and the thing
 * that has to hold before any caller's per-chunk batching means anything. It is
 * NOT a database-statement count, and the difference is load-bearing: IF a
 * caller's `mapChunk` resolved a chunk's data in one aggregate, rewriting it to
 * resolve per session would leave every number below untouched — this suite
 * cannot see that regression, only the walk's own chunking discipline. (The
 * production caller's own `mapChunk` is a trivial passthrough today
 * (`list-page-fetch.ts`), so no per-chunk resolution currently exists to guard;
 * this paragraph describes what the counters CAN'T prove, for whenever one does.)
 *
 * The population is deliberately several chunks deep. At one chunk the correct
 * shape and an N+1 both issue "a few" reads and hold "some" rows; only a
 * multi-chunk walk makes them different numbers.
 */
const BUDGET_POPULATION = 230;
/**
 * A SECOND population, nearly twice the first and landing on the same short
 * final chunk. The residency bound is a claim about the request and the chunk
 * size rather than about the population, and one size cannot decide that — a
 * peak that silently tracked the population would satisfy any single-size
 * literal. Both walks must report the SAME peak while ranking different totals.
 */
const LARGER_BUDGET_POPULATION = 430;
const BUDGET_CHUNK = 50;
const BUDGET_OFFSET = 0;
const BUDGET_LIMIT = 10;

/**
 * The trim threshold (`offset + limit + chunkSize`) plus the chunk that pushes
 * past it: a window sitting exactly AT the threshold has not tripped the trim
 * and still takes a full chunk before the next check.
 */
const EXPECTED_PEAK_WINDOW = BUDGET_OFFSET + BUDGET_LIMIT + 2 * BUDGET_CHUNK;
/**
 * …plus the fetched chunk itself, which the walk still holds while that sort
 * runs (`rows` is read again for the short-chunk termination check after it).
 *
 * That third chunk is the correction from whitlockk's review: the earlier instrument
 * counted only the mapped items the comparator saw, so on the production mapper
 * — which allocates a NEW candidate per row rather than handing the row itself
 * back — it missed the whole input chunk and reported a peak one chunk under
 * what was live.
 */
const EXPECTED_PEAK_LIVE = EXPECTED_PEAK_WINDOW + BUDGET_CHUNK;

describe("selectOrderedSessionWindow read-path budget (ISS-9627)", () => {
  it("reads each row exactly once, in chunk-sized reads", async () => {
    const { fetchChunk, mapChunk, rowsPerChunk, takes } =
      await budgetedWalk(BUDGET_POPULATION);

    // 230 rows in 50-row chunks is 5 reads, the last one short. Written out
    // rather than as `ceil(population / chunk)`: a count re-derived with the
    // walk's own arithmetic would agree with a walk that re-read rows.
    expect(fetchChunk).toHaveBeenCalledTimes(5);
    expect(rowsPerChunk).toEqual([50, 50, 50, 50, 30]);
    // Every `take` is the chunk size: the per-request clamp holds, so no single
    // read can be asked for the population.
    expect(takes).toEqual([50, 50, 50, 50, 50]);
    // The mapper is handed a whole chunk at a time, which is what would let a
    // caller resolve a chunk's data in one statement if it needed to — see the
    // WHAT THIS FILE CAN AND CANNOT COUNT note above for what that guarantee
    // does and does not currently protect.
    expect(mapChunk).toHaveBeenCalledTimes(5);
  });

  it("holds a window plus the chunks in flight, never the population", async () => {
    const walk = await budgetedWalk(BUDGET_POPULATION);

    // The measurement instrument first: every mapped row is ranked before it is
    // trimmed or returned, so the comparator must have seen all 230 across the
    // walk. An instrument that undercounted would report a SMALLER peak and
    // pass a residency budget it should have failed, so this has to be pinned
    // before the peaks below mean anything.
    expect(walk.itemsEverRanked).toBe(BUDGET_POPULATION);

    // The retained window, and then everything the walk holds at that moment:
    // the window PLUS the fetched rows the mapped items were derived from.
    expect(walk.peakWindowResidency).toBe(EXPECTED_PEAK_WINDOW);
    expect(walk.peakLiveObjects).toBe(EXPECTED_PEAK_LIVE);
    // 110 and 160 respectively, written out so the constants above cannot
    // absorb a change in the bound they are supposed to describe.
    expect([walk.peakWindowResidency, walk.peakLiveObjects]).toEqual([
      110, 160,
    ]);
  });

  it("holds the same peak over a population nearly twice the size", async () => {
    const larger = await budgetedWalk(LARGER_BUDGET_POPULATION);

    // 430 rows ranked instead of 230 — nine reads instead of five — and not one
    // more object resident. This is the assertion that makes the peak a
    // statement about `offset + limit + chunkSize` rather than about the rows.
    expect(larger.itemsEverRanked).toBe(LARGER_BUDGET_POPULATION);
    expect(larger.peakWindowResidency).toBe(EXPECTED_PEAK_WINDOW);
    expect(larger.peakLiveObjects).toBe(EXPECTED_PEAK_LIVE);
    expect(larger.peakLiveObjects).toBeLessThan(LARGER_BUDGET_POPULATION);
  });
});

/**
 * One walk over `size` rows, with the reads it issued and the objects it held
 * simultaneously.
 *
 * THE MAPPER ALLOCATES, so the fetched rows and the ranked items are two
 * distinct populations that are BOTH live while the walk sorts — a mapper that
 * handed the fetched row straight back would make them one population and hide
 * exactly the undercount this instrument was corrected for. (A mapper that
 * resolves per-row data, building a new candidate object per row, is the
 * general shape this guards; the production caller's own `mapChunk` is a
 * trivial passthrough today, which still allocates a new array per chunk.)
 *
 * Residency is OBSERVED rather than predicted. `compare` runs only inside the
 * walk's own `sort`, and `mapChunk` runs once per chunk before it, so the
 * distinct items the comparator sees between two `mapChunk` calls are exactly
 * the items resident at that sort. That equality rests on a comparison sort
 * being unable to place an element it never compared — not on any one engine's
 * merge strategy — and `itemsEverRanked` re-checks it on every run rather than
 * leaving it as an argument.
 *
 * The fetched chunk is added from the walk's own control flow rather than
 * observed: `rows` is a local the walk reads AFTER the sort (`rows.length <
 * chunkSize`), so it is reachable across it by construction. Attributing the
 * final, post-loop sort to the last chunk over-states that one slot — `rows` has
 * left scope by then — which is the safe direction for an upper bound and is
 * never the peak anyway.
 */
async function budgetedWalk(size: number) {
  const population = buildPopulation(size);
  const { fetchChunk } = buildFetcher(population);
  const rowsPerChunk: number[] = [];
  const takes: number[] = [];
  const observations: { resident: Set<Row>; rowsInFlight: number }[] = [];

  const mapChunk = vi.fn((rows: readonly Row[]) => {
    rowsPerChunk.push(rows.length);
    observations.push({ resident: new Set<Row>(), rowsInFlight: rows.length });
    return Promise.resolve(rows.map((row) => ({ ...row })));
  });
  const compare = (a: Row, b: Row) => {
    const observation = observations.at(-1);
    observation?.resident.add(a);
    observation?.resident.add(b);
    return byRank(a, b);
  };

  await selectOrderedSessionWindow<Row, Row>({
    where: BASE_WHERE,
    offset: BUDGET_OFFSET,
    limit: BUDGET_LIMIT,
    total: population.length,
    compare,
    fetchChunk: (chunkWhere, take) => {
      takes.push(take);
      return fetchChunk(chunkWhere, take);
    },
    mapChunk,
    chunkSize: BUDGET_CHUNK,
  });

  return {
    fetchChunk,
    mapChunk,
    rowsPerChunk,
    takes,
    peakWindowResidency: Math.max(
      ...observations.map((observation) => observation.resident.size)
    ),
    peakLiveObjects: Math.max(
      ...observations.map(
        (observation) => observation.resident.size + observation.rowsInFlight
      )
    ),
    itemsEverRanked: new Set(
      observations.flatMap((observation) => [...observation.resident])
    ).size,
  };
}
