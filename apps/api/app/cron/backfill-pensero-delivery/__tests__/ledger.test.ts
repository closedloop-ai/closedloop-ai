/**
 * ISS-8761: the attempt ledger's reads and writes.
 *
 * The contract worth pinning hardest here is the one a naive bound gets wrong:
 * the recheck window must be anchored at the CURSOR, not at the oldest day.
 * Reading "oldest N attempted days" looks like a harmless cap and is actually
 * permanent starvation — every day past the prefix would never be rechecked
 * again, while the ledger and the metrics both went on reporting a healthy run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  const mocked = Object.assign(vi.fn(), { tx: vi.fn() });
  return { ...actual, withDb: mocked };
});

import { withDb } from "@repo/database";
import {
  hasFailedPenseroBackfillDay,
  readOrganizationBackfillState,
  recordBackfillDayAttempt,
  writeBackfillCursors,
} from "../ledger";

const ORG = "11111111-1111-4111-8111-111111111111";
/** A SECOND org: a probe that ignored its argument would pass with only one. */
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

/**
 * ISS-9930: ORG has a day it attempted and never retrieved; OTHER_ORG's every
 * attempted day succeeded. Both hold rows, so an empty result for OTHER_ORG
 * means the predicate discriminated rather than that the table was empty.
 */
const DAY_ROWS = [
  {
    id: "d1",
    organizationId: ORG,
    day: new Date("2026-08-02T00:00:00.000Z"),
    lastSuccessAt: new Date("2026-08-02"),
  },
  {
    id: "d2",
    organizationId: ORG,
    day: new Date("2026-08-05T00:00:00.000Z"),
    lastSuccessAt: null,
  },
  {
    id: "d3",
    organizationId: OTHER_ORG,
    day: new Date("2026-08-03T00:00:00.000Z"),
    lastSuccessAt: new Date("2026-08-03"),
  },
];

/** Ten consecutive attempted days, oldest first. */
const ATTEMPTED_DAYS = [
  "2026-08-01",
  "2026-08-02",
  "2026-08-03",
  "2026-08-04",
  "2026-08-05",
  "2026-08-06",
  "2026-08-07",
  "2026-08-08",
  "2026-08-09",
  "2026-08-10",
];

let cursorRow: {
  backwardCursor: Date | null;
  recheckCursor: Date | null;
} | null = null;
let upsertCalls: {
  where: unknown;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}[] = [];
let cursorUpserts: {
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}[] = [];
let cursorUpdateManyCalls: {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}[] = [];

function makeFakeDb() {
  return {
    penseroBackfillCursor: {
      findUnique: () => Promise.resolve(cursorRow),
      upsert: (args: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        cursorUpserts.push(args);
        return Promise.resolve({});
      },
      updateMany: (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        cursorUpdateManyCalls.push(args);
        return Promise.resolve({ count: 1 });
      },
    },
    penseroBackfillDay: {
      // Honours BOTH halves of the predicate, because a fake that ignored
      // either one would pass a probe that dropped the org scope or the
      // never-succeeded filter — the exact false green this case exists for.
      // ISS-10653: `day` with Prisma's semantics — an absent key or bound
      // constrains nothing, `gte`/`lte` are inclusive.
      findFirst: ({
        where,
      }: {
        where: {
          organizationId: string;
          lastSuccessAt: null;
          day?: { gte?: Date; lte?: Date };
        };
      }) =>
        Promise.resolve(
          DAY_ROWS.find(
            (dayRow) =>
              dayRow.organizationId === where.organizationId &&
              where.lastSuccessAt === null &&
              dayRow.lastSuccessAt === null &&
              !(where.day?.gte && dayRow.day < where.day.gte) &&
              !(where.day?.lte && dayRow.day > where.day.lte)
          ) ?? null
        ),
      // Honours BOTH `day.gt` and `take`, because the bug this suite exists for
      // is invisible against a fake that ignores either one.
      findMany: ({
        where,
        take,
      }: {
        where: { organizationId: string; day?: { gt: Date } };
        take: number;
      }) => {
        const gt = where.day?.gt;
        const matching = ATTEMPTED_DAYS.filter((day) =>
          gt ? day > gt.toISOString().slice(0, 10) : true
        );
        return Promise.resolve(
          matching
            .slice(0, take)
            .map((day) => ({ day: new Date(`${day}T00:00:00.000Z`) }))
        );
      },
      upsert: (args: {
        where: unknown;
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        upsertCalls.push(args);
        return Promise.resolve({});
      },
    },
  };
}

beforeEach(() => {
  cursorRow = null;
  upsertCalls = [];
  cursorUpserts = [];
  cursorUpdateManyCalls = [];
  vi.clearAllMocks();
  const db = makeFakeDb();
  vi.mocked(withDb).mockImplementation((callback) =>
    Promise.resolve(callback(db as never))
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readOrganizationBackfillState", () => {
  it("anchors the bounded window AFTER the recheck cursor, not at the oldest day", async () => {
    cursorRow = {
      backwardCursor: new Date("2026-08-01T00:00:00.000Z"),
      recheckCursor: new Date("2026-08-07T00:00:00.000Z"),
    };

    const state = await readOrganizationBackfillState(ORG, 3);

    // The cursor sits on 08-07, so the next three days the round robin owes are
    // 08-08, 08-09, 08-10 — NOT 08-01..08-03, which an oldest-N bound returns
    // and which would leave 08-08 onwards permanently unrechecked.
    expect(state.attemptedDays).toEqual([
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
    ]);
    expect(state.cursors.recheckCursor).toBe("2026-08-07");
    expect(state.cursors.backwardCursor).toBe("2026-08-01");
  });

  it("wraps to the oldest days when the post-cursor tail cannot fill the budget", async () => {
    cursorRow = {
      backwardCursor: null,
      recheckCursor: new Date("2026-08-09T00:00:00.000Z"),
    };

    const state = await readOrganizationBackfillState(ORG, 4);

    // One day remains after the cursor; the rest of the budget wraps to the
    // oldest, which is exactly where the round robin is about to go next.
    expect(state.attemptedDays).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-10",
    ]);
  });

  it("starts at the oldest day when nothing has been rechecked yet", async () => {
    cursorRow = null;

    const state = await readOrganizationBackfillState(ORG, 2);

    expect(state.attemptedDays).toEqual(["2026-08-01", "2026-08-02"]);
    expect(state.cursors).toEqual({
      backwardCursor: null,
      recheckCursor: null,
    });
  });

  it("clamps a zero or negative limit up to one rather than reading nothing", async () => {
    // An empty attempted set reads exactly like an org with no history, which
    // would silently disable the recheck lane instead of bounding it.
    const state = await readOrganizationBackfillState(ORG, -5);
    expect(state.attemptedDays).toEqual(["2026-08-01"]);
  });
});

describe("recordBackfillDayAttempt", () => {
  const ATTEMPTED_AT = new Date("2026-08-10T09:00:00.000Z");

  it("writes one atomic upsert keyed on (organization, day)", async () => {
    await recordBackfillDayAttempt(ORG, ATTEMPTED_AT, {
      day: "2026-08-10",
      succeeded: true,
      failureReason: null,
      rowsWritten: 12,
    });

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].where).toEqual({
      organizationId_day: {
        organizationId: ORG,
        day: new Date("2026-08-10T00:00:00.000Z"),
      },
    });
    // `increment`, not a read-then-write: two overlapping runs must both count.
    expect(upsertCalls[0].update.attemptCount).toEqual({ increment: 1 });
    expect(upsertCalls[0].update.lastSuccessAt).toEqual(ATTEMPTED_AT);
    expect(upsertCalls[0].update.lastFailureReason).toBeNull();
    expect(upsertCalls[0].update.lastRowsWritten).toBe(12);
  });

  it("leaves lastSuccessAt untouched on a failure", async () => {
    await recordBackfillDayAttempt(ORG, ATTEMPTED_AT, {
      day: "2026-08-10",
      succeeded: false,
      failureReason: "Pensero delivery request failed: 502",
      rowsWritten: 0,
    });

    // "Failing since" and "never worked" are different facts. A failure states
    // the first without erasing the second.
    expect(upsertCalls[0].update).not.toHaveProperty("lastSuccessAt");
    expect(upsertCalls[0].update).not.toHaveProperty("lastRowsWritten");
    expect(upsertCalls[0].update.lastFailureReason).toBe(
      "Pensero delivery request failed: 502"
    );
    expect(upsertCalls[0].create.lastSuccessAt).toBeNull();
  });
});

describe("writeBackfillCursors", () => {
  it("advances the backward cursor only when the new value is strictly older", async () => {
    await writeBackfillCursors(ORG, {
      backwardCursor: "2026-07-28",
      recheckCursor: "2026-08-05",
    });

    // The guard is expressed in SQL, not decided in process: two overlapping
    // sweeps compute their cursors from whatever they each read at their own
    // start, so a blind last-write-wins would let the staler one drag history
    // back over days the other already walked.
    expect(cursorUpdateManyCalls).toHaveLength(1);
    expect(cursorUpdateManyCalls[0].where).toEqual({
      organizationId: ORG,
      OR: [
        { backwardCursor: null },
        { backwardCursor: { gt: new Date("2026-07-28T00:00:00.000Z") } },
      ],
    });
    expect(cursorUpdateManyCalls[0].data).toEqual({
      backwardCursor: new Date("2026-07-28T00:00:00.000Z"),
    });
  });

  it("leaves the backward cursor out of the upsert UPDATE so only the guard moves it", async () => {
    await writeBackfillCursors(ORG, {
      backwardCursor: "2026-07-28",
      recheckCursor: "2026-08-05",
    });

    expect(cursorUpserts).toHaveLength(1);
    expect(cursorUpserts[0].update).toEqual({
      recheckCursor: new Date("2026-08-05T00:00:00.000Z"),
    });
    // On CREATE there is nothing to regress past, so the backward value goes in.
    expect(cursorUpserts[0].create).toEqual({
      organizationId: ORG,
      backwardCursor: new Date("2026-07-28T00:00:00.000Z"),
      recheckCursor: new Date("2026-08-05T00:00:00.000Z"),
    });
  });

  it("writes the recheck cursor UNGUARDED, because that cursor wraps", async () => {
    await writeBackfillCursors(ORG, {
      backwardCursor: null,
      recheckCursor: "2026-08-01",
    });

    // A monotonic guard here would pin the round robin at the newest attempted
    // day forever: at the end of a cycle the cursor legitimately moves BACK to
    // the oldest day, and refusing that stops the lane dead.
    expect(cursorUpserts[0].update).toEqual({
      recheckCursor: new Date("2026-08-01T00:00:00.000Z"),
    });
    expect(cursorUpdateManyCalls).toHaveLength(0);
  });
});

describe("ISS-9930 hasFailedPenseroBackfillDay", () => {
  it("is true only for an org holding a day that never succeeded", async () => {
    // Two orgs, both with rows. A probe that dropped `organizationId` would
    // answer true for OTHER_ORG off ORG's failed day; one that dropped
    // `lastSuccessAt: null` would answer true for both.
    await expect(hasFailedPenseroBackfillDay(ORG)).resolves.toBe(true);
    await expect(hasFailedPenseroBackfillDay(OTHER_ORG)).resolves.toBe(false);
  });
});

describe("ISS-10653 hasFailedPenseroBackfillDay bounded to a window", () => {
  // ORG's one failed day is 2026-08-05 (UTC).
  it.each([
    [
      "the failed day's last instant opens the window",
      { start: "2026-08-05T23:59:59.999Z", end: "2026-08-09T00:00:00.000Z" },
      true,
    ],
    [
      "the failed day's first instant closes the window",
      { start: "2026-08-01T00:00:00.000Z", end: "2026-08-05T00:00:00.000Z" },
      true,
    ],
    [
      "a +02:00 instant is read on its UTC day",
      { start: "2026-08-06T01:00:00.000+02:00" },
      true,
    ],
    [
      "the window opens the day after",
      { start: "2026-08-06T00:00:00.000Z" },
      false,
    ],
    [
      "the window closes the day before",
      { end: "2026-08-04T23:59:59.999Z" },
      false,
    ],
    ["no bound at all is the org-wide probe", {}, true],
  ] as const)("%s", async (_name, bounds, expected) => {
    const window = {
      ...("start" in bounds ? { start: new Date(bounds.start) } : {}),
      ...("end" in bounds ? { end: new Date(bounds.end) } : {}),
    };

    await expect(hasFailedPenseroBackfillDay(ORG, window)).resolves.toBe(
      expected
    );
  });
});
