/**
 * ISS-9880: `loadAgentComponentInvocationReadPage` served the first
 * AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS rows and reported `hasMore` with no
 * input that could reach row 501.
 *
 * The fake delegate below EVALUATES the `where` the reader builds — it is not a
 * positional stand-in — so the keyset predicate itself is under test and a
 * wrong tuple comparison shows up as wrong rows rather than passing. It is
 * still JS, so it proves the predicate's logic, not Postgres' NULL semantics;
 * the null-lead ordering it models is stated on `invocationReadCursorWhere`.
 *
 * The population is deliberately larger than one page, NOT a whole multiple of
 * it, and mixes timestamped rows with an untimestamped tail: a fixture sized at
 * the cap cannot tell a page from the population, one sized at two pages cannot
 * tell a correct final page from an off-by-one, and one whose rows all share an
 * `invokedAt` never exercises the tiebreak arm.
 */
import {
  AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it, vi } from "vitest";
import { loadAgentComponentInvocationReadPage } from "../service/invocation-read";

const ORGANIZATION_ID = "org-1";
const KIND = "tool";
const KEY = "my-tool";

/** One page, the remainder of a second, and a partial third. */
const POPULATION = AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS * 2 + 37;
/** The untimestamped tail, which the read's `nulls: "last"` sorts after all of it. */
const NULL_TAIL = 40;
/**
 * Rows per distinct `invokedAt`. Three, with the first two also sharing a
 * `sequence`, so every arm of the tiebreak decides at least one boundary:
 * without a pair that ties on `sequence`, the `externalInvocationId` arm never
 * fires and deleting it leaves the suite green.
 */
const TIE_WIDTH = 3;
const BASE_MS = Date.parse("2026-01-10T12:00:00.000Z");

type FakeRow = ReturnType<typeof buildRow>;

/** The subset of Prisma's `where` DSL this reader emits. */
type PrismaPredicate = Record<string, unknown>;

type FindManyArgs = {
  where?: PrismaPredicate;
  take?: number;
};

function uuid(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function buildRow(index: number) {
  const isNullTail = index >= POPULATION - NULL_TAIL;
  const tieGroup = Math.floor(index / TIE_WIDTH);
  return {
    // Descending, so ascending `index` is the read's own order.
    invokedAt: isNullTail ? null : new Date(BASE_MS - tieGroup * 1000),
    generationId: uuid("aaaaaaaa", tieGroup),
    sequence: Math.floor((index % TIE_WIDTH) / 2),
    externalInvocationId: `ext-invocation-${String(index).padStart(5, "0")}`,
    id: uuid("bbbbbbbb", index),
    sourceSessionId: "source-session-1",
    childSessionId: null,
    parentExternalInvocationId: null,
    externalAgentId: null,
    componentKind: AgentComponentInvocationKind.Tool,
    componentKey: KEY,
    rawName: null,
    normalizedName: null,
    relationship: AgentComponentInvocationRelationship.Direct,
    anchor: { kind: AgentComponentInvocationAnchorKind.Session },
    providerInvocationId: null,
    attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
    definitionHash: null,
    normalizerContractVersion: null,
    definitionVersionId: null,
    sourceOccurrenceId: null,
    sourcePath: null,
    sourceModifiedAt: null,
    capturedAt: null,
    repositoryFullName: null,
    repositoryCommit: null,
    packId: null,
    branchName: null,
    generation: {
      agentSessionId: "session-1",
      session: { externalSessionId: "ext-session-1" },
    },
  };
}

function comparable(value: unknown): number | string | null {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }
  return null;
}

/** One `{ gt }` / `{ lt }` / literal / `null` leaf against a row field. */
function matchesLeaf(actual: unknown, expected: unknown): boolean {
  if (expected === null) {
    return actual === null;
  }
  if (typeof expected !== "object") {
    return comparable(actual) === comparable(expected);
  }
  if (expected instanceof Date) {
    return comparable(actual) === expected.getTime();
  }
  const left = comparable(actual);
  if (left === null) {
    return false;
  }
  const operators = expected as { gt?: unknown; lt?: unknown };
  if ("gt" in operators) {
    const right = comparable(operators.gt);
    return right !== null && left > right;
  }
  const right = comparable(operators.lt);
  return right !== null && left < right;
}

/** The read's ordering tuple — the only columns this evaluator compares. */
const KEYSET_FIELDS = new Set([
  "invokedAt",
  "generationId",
  "sequence",
  "externalInvocationId",
]);

/** Sibling keys AND together; `AND`/`OR` nest — Prisma's own semantics. */
function matchesPredicate(row: FakeRow, predicate: PrismaPredicate): boolean {
  return Object.entries(predicate).every(([key, expected]) => {
    if (key === "AND") {
      return (expected as PrismaPredicate[]).every((clause) =>
        matchesPredicate(row, clause)
      );
    }
    if (key === "OR") {
      return (expected as PrismaPredicate[]).some((clause) =>
        matchesPredicate(row, clause)
      );
    }
    // Only the ordering tuple is modelled. The identity and org arms of the
    // production `where` (the `generation` relation filter, the component-key
    // fallback) hold for every row in this fixture — one component, one org —
    // so they are assumed rather than evaluated.
    if (!KEYSET_FIELDS.has(key)) {
      return true;
    }
    return matchesLeaf((row as Record<string, unknown>)[key], expected);
  });
}

function fakeDelegate(rows: readonly FakeRow[]) {
  return vi.fn((args: FindManyArgs) => {
    const matched = rows.filter((row) =>
      args.where ? matchesPredicate(row, args.where) : true
    );
    return Promise.resolve(matched.slice(0, args.take ?? matched.length));
  });
}

function readerFor(rows: readonly FakeRow[]) {
  const findMany = fakeDelegate(rows);
  // Typed arg, not `()`: the calls tuple is what the uncursored-counts case
  // reads back.
  const groupBy = vi.fn((_args: { where?: PrismaPredicate }) =>
    Promise.resolve([
      {
        attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
        _count: { _all: rows.length },
      },
    ])
  );
  const db = {
    agentComponentInvocation: { findMany, groupBy },
    sourceOccurrence: { findMany: vi.fn(() => Promise.resolve([])) },
  };
  return {
    findMany,
    groupBy,
    read: (cursor?: string | null) =>
      loadAgentComponentInvocationReadPage(
        db as unknown as Parameters<
          typeof loadAgentComponentInvocationReadPage
        >[0],
        {
          organizationId: ORGANIZATION_ID,
          kind: KIND,
          key: KEY,
          inventoryIds: [],
          ...(cursor === undefined ? {} : { cursor }),
        }
      ),
  };
}

function population(): FakeRow[] {
  return Array.from({ length: POPULATION }, (_, index) => buildRow(index));
}

async function walkToExhaustion(reader: ReturnType<typeof readerFor>) {
  const seen: string[] = [];
  const totals: number[] = [];
  let cursor: string | null | undefined;
  let pages = 0;
  do {
    const page = await reader.read(cursor);
    pages += 1;
    seen.push(...page.items.map((item) => item.id));
    totals.push(page.total);
    cursor = page.nextCursor;
  } while (cursor && pages < 10);
  return { seen, totals, pages };
}

describe("loadAgentComponentInvocationReadPage keyset continuation", () => {
  it("walks past the cap to exhaustion and yields every row exactly once", async () => {
    const rows = population();
    const reader = readerFor(rows);

    const { seen, totals, pages } = await walkToExhaustion(reader);

    // The walk delivers the POPULATION in the read's own order — a continuation
    // that re-served the head would repeat ids and fail the dedupe, and one that
    // over-shot the tuple would skip a row and fail the equality.
    expect(seen).toHaveLength(POPULATION);
    expect(new Set(seen).size).toBe(POPULATION);
    expect(seen).toEqual(rows.map((row) => row.id));
    expect(totals).toEqual([POPULATION, POPULATION, POPULATION]);
    expect(pages).toBe(3);
  });

  it("crosses the timestamped/untimestamped boundary without losing the null tail", async () => {
    const rows = population();
    const reader = readerFor(rows);

    const { seen } = await walkToExhaustion(reader);

    // `nulls: "last"` puts these at the very end, so a cursor predicate that
    // compared a null lead key with `<` — UNKNOWN in SQL, never true — drops
    // exactly this tail and the walk ends short of the population.
    const nullTailIds = rows.slice(-NULL_TAIL).map((row) => row.id);
    expect(rows.at(-1)?.invokedAt).toBeNull();
    expect(seen.slice(-NULL_TAIL)).toEqual(nullTailIds);
  });

  it("resumes past a cursor row that left the result set between pages", async () => {
    const rows = population();
    const first = await readerFor(rows).read();
    const anchorId = first.items.at(-1)?.id;

    // A Prisma row-reference cursor loses its place here; comparing the key by
    // VALUE does not. This read's `where` drops rows on reattribution, not only
    // on delete, so the anchor leaving is an ordinary event.
    const survivors = rows.filter((row) => row.id !== anchorId);
    const second = await readerFor(survivors).read(first.nextCursor);

    expect(second.items[0].id).toBe(
      rows[AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS].id
    );
    expect(second.items.map((item) => item.id)).not.toContain(anchorId);
  });

  it("reports the second page's rows as ones the first page did not carry", async () => {
    const reader = readerFor(population());

    const first = await reader.read();
    expect(first.items).toHaveLength(AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await reader.read(first.nextCursor);
    const firstIds = new Set(first.items.map((item) => item.id));
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.items.filter((item) => firstIds.has(item.id))).toHaveLength(
      0
    );
  });

  it("closes the walk on the final page instead of reporting a page that is not there", async () => {
    const reader = readerFor(population());

    let page = await reader.read();
    page = await reader.read(page.nextCursor);
    const last = await reader.read(page.nextCursor);

    // The tail is shorter than the cap while `total` stays at the population, so
    // a `hasMore` derived from `total > items.length` reads true here forever.
    expect(last.items).toHaveLength(
      POPULATION - AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS * 2
    );
    expect(last.total).toBe(POPULATION);
    expect(last.hasMore).toBe(false);
    expect(last.nextCursor).toBeUndefined();
  });

  it("offers no continuation when the whole population fits on one page", async () => {
    const reader = readerFor([buildRow(0), buildRow(1), buildRow(2)]);

    const page = await reader.read();

    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  it("bounds the read at one page rather than fetching the overfetch row into the page", async () => {
    const reader = readerFor(population());

    const page = await reader.read();

    // The probe row is requested but must not be delivered: a reader that
    // returned it would hand the caller a row the next page also carries.
    expect(reader.findMany.mock.calls[0][0].take).toBe(
      AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS + 1
    );
    expect(page.items).toHaveLength(AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS);
  });

  it("narrows only the page read, leaving the population counts uncursored", async () => {
    const reader = readerFor(population());

    const first = await reader.read();
    await reader.read(first.nextCursor);

    // `total` and the status counts answer "how many exist", so a cursor
    // reaching the groupBy would shrink them as the caller walks.
    const [firstGroupBy, secondGroupBy] = reader.groupBy.mock.calls;
    expect(secondGroupBy[0]).toEqual(firstGroupBy[0]);
    expect(reader.findMany.mock.calls[1][0].where).not.toEqual(
      reader.findMany.mock.calls[0][0].where
    );
  });

  it("refuses a malformed cursor instead of silently restarting at the head", async () => {
    const reader = readerFor(population());

    // A caller that walked a token it could not parse would otherwise loop on
    // the head forever, which is the dead end a bare `hasMore` already was.
    await expect(reader.read("not-a-cursor")).rejects.toThrow(
      "Invalid invocation read cursor"
    );
    // A well-formed envelope whose ids are not uuids: a non-uuid in a Prisma
    // comparison is a query error, so it is refused before the read.
    await expect(
      reader.read(
        Buffer.from(
          JSON.stringify({ t: null, g: "not-a-uuid", s: 0, e: "x" })
        ).toString("base64url")
      )
    ).rejects.toThrow("Invalid invocation read cursor");
    expect(reader.findMany).not.toHaveBeenCalled();
  });

  it("refuses an EMPTY cursor rather than treating it as no cursor", async () => {
    const reader = readerFor(population());

    // `?cursor=` produces exactly this, and a truthiness test sent it down the
    // no-cursor branch — the silent restart at row 1 the case above refuses for
    // every other malformed token (whitlockk review). Only null/undefined mean "no
    // cursor".
    await expect(reader.read("")).rejects.toThrow(
      "Invalid invocation read cursor"
    );
    expect(reader.findMany).not.toHaveBeenCalled();
  });

  it("still treats an ABSENT cursor as a request for the head", async () => {
    const reader = readerFor(population());

    // The other half of the pair: tightening the empty-string arm must not turn
    // a cursorless first page into a rejection, which is every existing caller.
    const page = await reader.read(undefined);

    expect(page.items.length).toBeGreaterThan(0);
    expect(reader.findMany).toHaveBeenCalled();
  });

  it("refuses a sequence outside the int4 column range", async () => {
    const reader = readerFor(population());

    // `agent_component_invocations.sequence` is INTEGER (migration
    // 20260723200300), so a value the column cannot hold is a 22003 at the
    // driver rather than a miss — refuse it with the other unusable tokens
    // (marisolashgrove review). Both ends: Number.isInteger(-1e21) is true.
    for (const sequence of [3_000_000_000, -3_000_000_000]) {
      await expect(
        reader.read(
          Buffer.from(
            JSON.stringify({
              t: null,
              g: "00000000-0000-4000-8000-000000000000",
              s: sequence,
              e: "x",
            })
          ).toString("base64url")
        )
      ).rejects.toThrow("Invalid invocation read cursor");
    }
    expect(reader.findMany).not.toHaveBeenCalled();
  });
});
