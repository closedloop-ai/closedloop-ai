/**
 * ISS-8936 — what `documentSummaryService.summarize` actually COUNTS.
 *
 * The risk this file exists for is not arithmetic; it is that a count is taken
 * over the wrong population. Four numbers that all look plausible can each be
 * measured over a different set, and nothing downstream can tell. So every case
 * here reads the `where` the service handed Prisma and asserts the predicate,
 * and the four scripted return values are DISTINCT so a transposed field is a
 * failure rather than a coincidence.
 *
 * `withDb` is replaced; `Prisma` is not — the predicate builders under test spend
 * `Prisma.QueryMode` and `Prisma.TransactionIsolationLevel`, and a total factory
 * would leave both undefined and assert against a shape the service never built.
 */
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import {
  DOCUMENT_SUMMARY_WINDOW_DAYS,
  type DocumentListSummary,
} from "@repo/api/src/types/document-list-summary";
import type { Prisma as PrismaNamespace } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  findMany: vi.fn(),
  txOptions: vi.fn(),
}));

vi.mock("@repo/database", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  const db = { artifact: { count: mocks.count, findMany: mocks.findMany } };
  const withDb = Object.assign(
    (run: (client: typeof db) => unknown) => Promise.resolve(run(db)),
    {
      tx: (run: () => unknown, options: unknown) => {
        mocks.txOptions(options);
        return Promise.resolve(run());
      },
    }
  );
  return { ...actual, withDb };
});

import { Prisma } from "@repo/database";
import {
  DOCUMENT_SUMMARY_SNAPSHOT_TX_TIMEOUT_MS,
  documentSummaryService,
} from "./document-summary-service";

const ORG = "org-1";
const INDEX_QUERY = {
  organizationId: ORG,
  type: DocumentType.Doc,
  unassignedProject: true,
} as const;

/** The four counts, in call order, deliberately all different. */
const SCRIPTED = [41, 17, 9, 5];

/** The instant the clock-pinned cases freeze, so a cutoff is an exact value. */
const NOW = new Date("2026-09-20T12:00:00.000Z");
const MILLISECONDS_PER_DAY = 86_400_000;

/** The `where` of the nth `artifact.count` the service issued. */
function whereOfCall(index: number): PrismaNamespace.ArtifactWhereInput {
  const args = mocks.count.mock.calls.at(index)?.[0] as {
    where: PrismaNamespace.ArtifactWhereInput;
  };
  return args.where;
}

/** The extra conjunct a sub-count AND-ed onto the shared list predicate. */
function conjunctOfCall(index: number): unknown {
  const where = whereOfCall(index) as { AND?: unknown[] };
  return where.AND?.at(1);
}

describe("documentSummaryService.summarize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([]);
    // Installed for every case and restored UNCONDITIONALLY below: a
    // `useRealTimers()` on the last line of a case leaks a frozen clock into
    // every later test in this worker the moment an assertion above it throws.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    for (const value of SCRIPTED) {
      mocks.count.mockResolvedValueOnce(value);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps each count to its own field, so a transposition cannot pass", async () => {
    const summary = await summarize({ ...INDEX_QUERY });

    expect(summary).toMatchObject({
      total: 41,
      producedByAgentSessions: 17,
      updatedInWindow: 9,
      neverEdited: 5,
      windowDays: DOCUMENT_SUMMARY_WINDOW_DAYS,
    });
  });

  it("counts every sub-metric over the SAME list predicate the total used", async () => {
    await summarize({ ...INDEX_QUERY });

    const total = whereOfCall(0);
    for (const index of [1, 2, 3]) {
      const where = whereOfCall(index) as { AND?: unknown[] };
      // The shared predicate is the FIRST conjunct of each sub-count, verbatim.
      // Anything else and the band is describing a population the list was never
      // drawn from — the one thing it must never do.
      expect(where.AND?.at(0)).toEqual(total);
    }
  });

  it("scopes the agent-session count to PRODUCES links from in-org sessions", async () => {
    await summarize({ ...INDEX_QUERY });

    expect(conjunctOfCall(1)).toEqual({
      targetLinks: {
        some: {
          organizationId: ORG,
          linkType: { in: [LinkType.Produces] },
          source: {
            is: {
              organizationId: ORG,
              type: ArtifactType.Session,
              session: { isNot: null },
            },
          },
        },
      },
    });
  });

  it("windows freshness on updatedAt, at the window it reports", async () => {
    // The clock is PINNED, so the cutoff is asserted as an exact value rather
    // than bracketed against the call's own wall-clock span. A bounded real-clock
    // assertion would be flaky under load and would not pin the property that
    // matters, which is that the cutoff is exactly one reported window back from
    // the instant the service took.
    vi.setSystemTime(NOW);

    await summarize({ ...INDEX_QUERY });

    expect(conjunctOfCall(2)).toEqual({
      updatedAt: {
        gte: new Date(
          NOW.getTime() - DOCUMENT_SUMMARY_WINDOW_DAYS * MILLISECONDS_PER_DAY
        ),
      },
    });
  });

  it("counts never-edited from the document's own version counter", async () => {
    await summarize({ ...INDEX_QUERY });

    expect(conjunctOfCall(3)).toEqual({
      document: { is: { latestVersion: { lte: 1 } } },
    });
  });

  it("reads all four counts in one RepeatableRead snapshot, on its own budget", async () => {
    await summarize({ ...INDEX_QUERY });

    // The timeout is asserted here and not only in the service: four sequential
    // statements add serially, and on Prisma's 5s interactive default the fourth
    // rolls the whole snapshot back as P2028 — a computable band reported
    // unavailable (review thread on #8000). Kills: dropping the `timeout` key.
    expect(mocks.txOptions).toHaveBeenCalledWith({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: DOCUMENT_SUMMARY_SNAPSHOT_TX_TIMEOUT_MS,
    });
    expect(mocks.count).toHaveBeenCalledTimes(4);
  });

  it("floors a nonsensical window rather than counting a future-only slice", async () => {
    vi.setSystemTime(NOW);

    const summary = await summarize({ ...INDEX_QUERY }, 0);

    // A zero window would put the cutoff at `now`, so the count would describe
    // rows updated in the FUTURE — an empty card captioned as a measurement. The
    // reported window and the measured one must be the same single day.
    expect(summary.windowDays).toBe(1);
    expect(conjunctOfCall(2)).toEqual({
      updatedAt: { gte: new Date(NOW.getTime() - MILLISECONDS_PER_DAY) },
    });
  });
});

it("bins authoritative timestamps over the same filtered cohort including the current partial UTC day", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.count.mockReset();
  for (const value of SCRIPTED) {
    mocks.count.mockResolvedValueOnce(value);
  }
  mocks.findMany.mockResolvedValueOnce([
    {
      id: "one",
      createdAt: new Date("2026-09-07T00:00:00Z"),
      updatedAt: NOW,
      targetLinks: [{ createdAt: new Date("2026-09-08T15:00:00Z") }],
    },
    {
      id: "two",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-09-21T00:00:00Z"),
      targetLinks: [],
    },
  ]);
  try {
    const summary = await summarize({ ...INDEX_QUERY });
    expect(summary.trendlines).toEqual({
      startDate: "2026-09-07T00:00:00.000Z",
      endDate: NOW.toISOString(),
      total: [1, ...new Array(13).fill(0)],
      producedByAgentSessions: [0, 1, ...new Array(12).fill(0)],
      updatedInWindow: [...new Array(13).fill(0), 1],
    });
    const args = mocks.findMany.mock.calls.at(-1)?.[0];
    const productionLink = (
      conjunctOfCall(1) as { targetLinks: { some: object } }
    ).targetLinks.some;
    const start = new Date("2026-09-07T00:00:00.000Z");
    // Rows with no binned timestamp on or after the start are never paged.
    expect(args.where).toEqual({
      AND: [
        whereOfCall(0),
        {
          OR: [
            { createdAt: { gte: start } },
            { updatedAt: { gte: start } },
            {
              targetLinks: {
                some: { ...productionLink, createdAt: { gte: start } },
              },
            },
          ],
        },
      ],
    });
    expect(args.select.targetLinks.where).toEqual(productionLink);
    expect(args.select.targetLinks.take).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it("intersects exact artifact IDs with the organization predicate and acknowledges empty cohorts", async () => {
  mocks.findMany.mockResolvedValue([]);
  mocks.count.mockReset();
  mocks.count.mockResolvedValue(0);
  const summary = await summarize({
    ...INDEX_QUERY,
    artifactIds: [],
  });
  expect(summary.appliedArtifactIds).toEqual([]);
  expect(whereOfCall(0)).toMatchObject({ organizationId: ORG, id: { in: [] } });
});

it("walks bounded timestamp pages without limiting the cohort to the first page", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.count.mockReset();
  mocks.count.mockResolvedValue(501);
  mocks.findMany.mockReset();
  const rows = Array.from({ length: 501 }, (_, index) => ({
    id: String(index).padStart(4, "0"),
    createdAt: NOW,
    updatedAt: NOW,
    targetLinks: [],
  }));
  mocks.findMany
    .mockResolvedValueOnce(rows.slice(0, 500))
    .mockResolvedValueOnce(rows.slice(500));
  try {
    const summary = await summarize({ ...INDEX_QUERY });
    expect(summary.trendlines?.total[13]).toBe(501);
    expect(mocks.findMany.mock.calls.at(-1)?.[0]).toMatchObject({
      take: 500,
      cursor: { id: "0499" },
      skip: 1,
    });
  } finally {
    vi.useRealTimers();
  }
});

/** The scoped entry point with no facet to refuse, unwrapped for the counts. */
async function summarize(
  query: Parameters<typeof documentSummaryService.summarizeScope>[0],
  windowDays?: number
): Promise<DocumentListSummary> {
  const result = await documentSummaryService.summarizeScope(
    query,
    "user-1",
    windowDays
  );
  if (!result.ok) {
    throw new Error(`summary refused: ${result.error}`);
  }
  return result.value;
}
