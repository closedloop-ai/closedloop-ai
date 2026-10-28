import { DocumentType } from "@repo/api/src/types/document";
import {
  type DocumentCostsResponse,
  documentCostsResponseSchema,
} from "@repo/api/src/types/document-costs";
import { TokenCostCompleteness } from "@repo/api/src/types/token-cost-provenance";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentCostDb,
  type DocumentCostDbState,
  emptyDocumentCostState,
  readScopedDocumentCosts,
} from "@/__tests__/support/documents/document-cost.test-db";
import {
  InvalidCostEvidenceReason,
  summarizeCostCoverage,
} from "../document-cost-coverage";
import { documentCostService } from "../document-cost-service";

vi.mock("@repo/database", async (importActual) => {
  const actual = await importActual<typeof import("@repo/database")>();
  return {
    Prisma: actual.Prisma,
    ArtifactType: actual.ArtifactType,
    withDb: Object.assign(vi.fn(), {
      tx: async (run: () => unknown) => await run(),
    }),
  };
});

import { withDb } from "@repo/database";

const ORG_A = "org-a";
const ORG_B = "org-b";
const NOW = new Date("2026-10-02T12:00:00Z");
const EVENT_AT = new Date("2026-10-01T06:00:00Z");
const EVENT_DAY = 12;
const BEFORE_SPARKLINE = new Date("2026-09-05T06:00:00Z");
const WINDOW = {
  startDate: "2026-10-01T00:00:00.000Z",
  endDate: "2026-10-02T00:00:00.000Z",
};
const SCOPE = { scope: { types: [DocumentType.Prd] } };
const INVALID_COST_LOG = "[document-cost] Invalid token-event cost";

let state: DocumentCostDbState;
const fakeDb = createDocumentCostDb(() => state);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  state = emptyDocumentCostState();
  vi.mocked(withDb).mockImplementation(async (fn) => await fn(fakeDb as never));
});

afterEach(() => {
  vi.useRealTimers();
});

function uuid(n: number) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** A document whose sessions each carry one in-window event of `cost`. */
function seedDocument(
  n: number,
  sessionCosts: Record<number, number | null | "partial">,
  organizationId = ORG_A
) {
  state.docs.push({ id: uuid(n), organizationId, subtype: DocumentType.Prd });
  for (const [sessionN, cost] of Object.entries(sessionCosts)) {
    const sessionId = uuid(Number(sessionN));
    state.links.push({ sessionId, docId: uuid(n), organizationId });
    if (state.sessions.some((session) => session.id === sessionId)) {
      continue;
    }
    state.sessions.push({
      id: sessionId,
      organizationId,
      inputTokens: 10n,
      estimatedCost: 1,
    });
    state.events.push({
      id: `event-${sessionN}`,
      sessionId,
      inputTokens: 10n,
      cost: cost === "partial" ? 1 : cost,
      completeness:
        cost === "partial"
          ? TokenCostCompleteness.Partial
          : TokenCostCompleteness.Complete,
      date: EVENT_AT,
    });
  }
}

function readScoped(organizationId = ORG_A) {
  return readScopedDocumentCosts(organizationId, {
    artifactIds: [],
    ...SCOPE,
    ...WINDOW,
  });
}

function seedPartialPopulation() {
  seedDocument(1, { 101: 4 });
  seedDocument(2, { 102: 6 });
  seedDocument(3, { 103: "partial" });
}

/** What a client predating ISS-12598 reads: the legacy fields only. */
function legacyView(response: DocumentCostsResponse) {
  const { trendlines } = response;
  return JSON.parse(
    JSON.stringify({
      artifacts: response.artifacts,
      totalEstimatedCost: response.totalEstimatedCost,
      medianEstimatedCost: response.medianEstimatedCost,
      sessionCosts: response.sessionCosts,
      trendlines: trendlines && {
        startDate: trendlines.startDate,
        endDate: trendlines.endDate,
        totalEstimatedCost: trendlines.totalEstimatedCost,
        medianEstimatedCost: trendlines.medianEstimatedCost,
      },
    })
  );
}

function dayLine(eventDayValue: number | null) {
  const line: (number | null)[] = new Array(14).fill(0);
  line[EVENT_DAY] = eventDayValue;
  return line;
}

describe("scoped document cost coverage (ISS-12598)", () => {
  it("returns a measured zero total with full coverage for an empty population", async () => {
    const result = await readScoped();
    expect(result.totalEstimatedCost).toBe(0);
    expect(result.medianEstimatedCost).toBeUndefined();
    expect(result.measuredSubsetTotalEstimatedCost).toBeUndefined();
    expect(result.measuredSubsetMedianEstimatedCost).toBeUndefined();
    expect(result.coverage).toEqual({
      documentCount: 0,
      measuredDocumentCount: 0,
      unknownDocumentCount: 0,
    });
  });

  it("returns 0 with full coverage when every document is a proven zero", async () => {
    seedDocument(1, { 101: 0 });
    seedDocument(2, {});
    const result = await readScoped();
    expect(result.totalEstimatedCost).toBe(0);
    expect(result.medianEstimatedCost).toBe(0);
    expect(result.measuredSubsetTotalEstimatedCost).toBeUndefined();
    expect(result.coverage).toEqual({
      documentCount: 2,
      measuredDocumentCount: 2,
      unknownDocumentCount: 0,
    });
  });

  it("carries the measured remainder's total and median in subset fields when one document is incomplete", async () => {
    seedPartialPopulation();
    const result = await readScoped();
    expect(result).not.toHaveProperty("totalEstimatedCost");
    expect(result).not.toHaveProperty("medianEstimatedCost");
    expect(result.measuredSubsetTotalEstimatedCost).toBe(10);
    expect(result.measuredSubsetMedianEstimatedCost).toBe(5);
    expect(result.coverage).toEqual({
      documentCount: 3,
      measuredDocumentCount: 2,
      unknownDocumentCount: 1,
    });
  });

  it("omits every total and median for an all-unknown population instead of reporting 0", async () => {
    seedDocument(1, { 101: "partial" });
    seedDocument(2, { 102: "partial" });
    const result = await readScoped();
    expect(result).not.toHaveProperty("totalEstimatedCost");
    expect(result).not.toHaveProperty("medianEstimatedCost");
    expect(result).not.toHaveProperty("measuredSubsetTotalEstimatedCost");
    expect(result).not.toHaveProperty("measuredSubsetMedianEstimatedCost");
    expect(result.coverage).toEqual({
      documentCount: 2,
      measuredDocumentCount: 0,
      unknownDocumentCount: 2,
    });
    expect(result.trendlines?.totalEstimatedCost[EVENT_DAY]).toBeNull();
    expect(
      result.trendlines?.measuredSubsetTotalEstimatedCost?.[EVENT_DAY]
    ).toBeNull();
  });

  it("treats an unpriced session as unknown without erasing priced documents", async () => {
    seedDocument(1, { 101: 3 });
    seedDocument(2, { 102: null });
    const result = await readScoped();
    expect(result.measuredSubsetTotalEstimatedCost).toBe(3);
    expect(result.coverage?.unknownDocumentCount).toBe(1);
  });

  it("treats a session whose lifetime tokens outrun captured events as unknown", async () => {
    seedDocument(1, { 101: 3 });
    seedDocument(2, { 102: 8 });
    state.sessions[1].inputTokens = 50n;
    const result = await readScoped();
    expect(result.measuredSubsetTotalEstimatedCost).toBe(3);
    expect(result.coverage).toEqual({
      documentCount: 2,
      measuredDocumentCount: 1,
      unknownDocumentCount: 1,
    });
  });

  it("counts a shared session once and excludes sessions of unknown documents", async () => {
    seedDocument(1, { 101: 5 });
    seedDocument(2, { 101: 5 });
    seedDocument(3, { 101: 5, 103: "partial", 104: 7 });
    const result = await readScoped();
    expect(result.measuredSubsetTotalEstimatedCost).toBe(5);
    expect(result.measuredSubsetMedianEstimatedCost).toBe(5);
    expect(result.coverage?.measuredDocumentCount).toBe(2);
  });

  it("averages the middle two documents for an even full-population median, zeros included", async () => {
    seedDocument(1, { 101: 0 });
    seedDocument(2, { 102: 2 });
    seedDocument(3, { 103: 4 });
    seedDocument(4, { 104: 10 });
    const result = await readScoped();
    expect(result.medianEstimatedCost).toBe(3);
    expect(result.totalEstimatedCost).toBe(16);
  });

  it("carries a partial day's calculable value and coverage in the subset trendlines", async () => {
    seedPartialPopulation();
    const { trendlines } = await readScoped();
    expect(trendlines?.totalEstimatedCost[EVENT_DAY]).toBeNull();
    expect(trendlines?.medianEstimatedCost[EVENT_DAY]).toBeNull();
    expect(trendlines?.measuredSubsetTotalEstimatedCost?.[EVENT_DAY]).toBe(10);
    expect(trendlines?.measuredSubsetMedianEstimatedCost?.[EVENT_DAY]).toBe(5);
    expect(trendlines?.coverage?.[EVENT_DAY]).toEqual({
      documentCount: 3,
      measuredDocumentCount: 2,
      unknownDocumentCount: 1,
    });
    expect(trendlines?.totalEstimatedCost[0]).toBe(0);
    expect(trendlines?.measuredSubsetTotalEstimatedCost?.[0]).toBeNull();
    expect(trendlines?.coverage?.[0]?.unknownDocumentCount).toBe(0);
  });

  it("scopes the population, sessions and coverage to the caller's organization", async () => {
    seedDocument(1, { 101: 4 });
    seedDocument(2, { 102: 100 }, ORG_B);
    seedDocument(3, { 103: "partial" }, ORG_B);
    const orgA = await readScoped(ORG_A);
    expect(orgA.totalEstimatedCost).toBe(4);
    expect(orgA.medianEstimatedCost).toBe(4);
    expect(orgA.coverage).toEqual({
      documentCount: 1,
      measuredDocumentCount: 1,
      unknownDocumentCount: 0,
    });
    const orgB = await readScoped(ORG_B);
    expect(orgB.measuredSubsetTotalEstimatedCost).toBe(100);
    expect(orgB.coverage).toEqual({
      documentCount: 2,
      measuredDocumentCount: 1,
      unknownDocumentCount: 1,
    });
  });
});

describe("impossible cost evidence", () => {
  it("reports a negative window cost to the monitored log instead of coercing it", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => undefined);
    seedDocument(1, { 101: 3 });
    seedDocument(2, { 102: 6 });
    state.events.push({ ...state.events[1], id: "event-negative", cost: -10 });
    state.sessions[1].inputTokens = 20n;
    const result = await readScoped();
    expect(result.measuredSubsetTotalEstimatedCost).toBe(3);
    expect(result.coverage?.unknownDocumentCount).toBe(1);
    expect(errorLog).toHaveBeenCalledWith(
      INVALID_COST_LOG,
      expect.objectContaining({
        organizationId: ORG_A,
        agentSessionId: uuid(102),
        reason: InvalidCostEvidenceReason.WindowCost,
      })
    );
  });

  it("leaves a NaN daily cost a gap on the monitored log instead of failing the read", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => undefined);
    seedDocument(1, { 101: 3 });
    seedDocument(2, { 102: Number.NaN });
    const result = await readScoped();
    expect(
      result.trendlines?.measuredSubsetTotalEstimatedCost?.[EVENT_DAY]
    ).toBe(3);
    expect(result.trendlines?.coverage?.[EVENT_DAY]?.unknownDocumentCount).toBe(
      1
    );
    expect(result.coverage?.unknownDocumentCount).toBe(1);
    expect(errorLog).toHaveBeenCalledWith(INVALID_COST_LOG, {
      organizationId: ORG_A,
      tokenEventId: "event-102",
    });
  });

  it("reports a negative window cost even when another event in the window is unpriced", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => undefined);
    seedDocument(1, { 101: 3 });
    seedDocument(2, { 102: -1 });
    // Both events predate the sparkline, so only the window read sees them.
    state.events[1].date = BEFORE_SPARKLINE;
    state.events.push({
      ...state.events[1],
      id: "event-unpriced",
      cost: null,
    });
    const result = await readScopedDocumentCosts(ORG_A, {
      artifactIds: [],
      ...SCOPE,
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: WINDOW.endDate,
    });
    expect(result.measuredSubsetTotalEstimatedCost).toBe(3);
    expect(result.coverage?.unknownDocumentCount).toBe(1);
    expect(errorLog).toHaveBeenCalledWith(
      INVALID_COST_LOG,
      expect.objectContaining({
        organizationId: ORG_A,
        agentSessionId: uuid(102),
        reason: InvalidCostEvidenceReason.WindowCost,
      })
    );
  });

  it("folds a session re-read on a later scoped page from one evidence set, never as $0", async () => {
    seedDocument(1, { 9001: 5 });
    seedDocument(2, { 9002: 3 });
    for (let n = 3; n <= 500; n++) {
      seedDocument(n, {});
    }
    seedDocument(501, { 9001: 5 });
    const shared = state.sessions[0];
    const fakeWithLateTokens = {
      ...fakeDb,
      sessionDetail: {
        findMany: (
          args: Parameters<typeof fakeDb.sessionDetail.findMany>[0]
        ) => {
          const rows = fakeDb.sessionDetail.findMany(args);
          // Tokens land after the first page read the shared session.
          shared.inputTokens = 50n;
          return rows;
        },
      },
    };
    vi.mocked(withDb).mockImplementation(
      async (fn) => await fn(fakeWithLateTokens as never)
    );
    const result = await readScoped();
    expect(result.coverage).toEqual({
      documentCount: 501,
      measuredDocumentCount: 499,
      unknownDocumentCount: 2,
    });
    expect(result.measuredSubsetTotalEstimatedCost).toBe(3);
    expect(result).not.toHaveProperty("totalEstimatedCost");
  });

  it("logs a negative token counter under a reason naming the counter", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => undefined);
    seedDocument(1, { 101: 3 });
    seedDocument(2, { 102: 6 });
    state.sessions[1].inputTokens = -1n;
    state.events[1].inputTokens = -1n;
    const result = await readScoped();
    expect(result.measuredSubsetTotalEstimatedCost).toBe(3);
    expect(errorLog).toHaveBeenCalledWith(INVALID_COST_LOG, {
      organizationId: ORG_A,
      agentSessionId: uuid(102),
      reason: InvalidCostEvidenceReason.NegativeTokenCounter,
      tokenCounter: "inputTokens",
    });
  });
});

describe("document cost response compatibility", () => {
  it("keeps the legacy fields of a partial scoped read identical to the pre-coverage contract", async () => {
    seedPartialPopulation();
    expect(legacyView(await readScoped())).toEqual({
      artifacts: [],
      trendlines: {
        startDate: "2026-09-19T00:00:00.000Z",
        endDate: NOW.toISOString(),
        totalEstimatedCost: dayLine(null),
        medianEstimatedCost: dayLine(null),
      },
    });
  });

  it("keeps the legacy fields of a partial unscoped read identical to the pre-coverage contract", async () => {
    seedPartialPopulation();
    const result = await documentCostService.read(ORG_A, {
      artifactIds: [uuid(1), uuid(2), uuid(3)],
      ...WINDOW,
    });
    expect(legacyView(result)).toEqual({
      artifacts: [
        { artifactId: uuid(1), totalEstimatedCost: 4, trendline: dayLine(4) },
        { artifactId: uuid(2), totalEstimatedCost: 6, trendline: dayLine(6) },
        { artifactId: uuid(3), trendline: dayLine(null) },
      ],
      sessionCosts: [
        { sessionId: uuid(101), totalEstimatedCost: 4, trendline: dayLine(4) },
        { sessionId: uuid(102), totalEstimatedCost: 6, trendline: dayLine(6) },
        { sessionId: uuid(103), trendline: dayLine(null) },
      ],
      trendlines: {
        startDate: "2026-09-19T00:00:00.000Z",
        endDate: NOW.toISOString(),
        totalEstimatedCost: dayLine(null),
        medianEstimatedCost: dayLine(null),
      },
    });
  });

  it("parses an older server response without coverage fields", () => {
    const legacy = {
      artifacts: [],
      totalEstimatedCost: 5,
      medianEstimatedCost: 5,
      trendlines: {
        startDate: "2026-09-19T00:00:00.000Z",
        endDate: NOW.toISOString(),
        totalEstimatedCost: new Array(14).fill(null),
        medianEstimatedCost: new Array(14).fill(null),
      },
    };
    expect(documentCostsResponseSchema.parse(legacy)).toEqual(legacy);
  });

  it("rejects coverage whose counts do not partition the population", () => {
    expect(
      documentCostsResponseSchema.safeParse({
        artifacts: [],
        coverage: {
          documentCount: 2,
          measuredDocumentCount: 2,
          unknownDocumentCount: 1,
        },
      }).success
    ).toBe(false);
  });
});

describe("summarizeCostCoverage", () => {
  it("takes the odd middle over complete documents and keeps proven zeros", () => {
    const costs = new Map([
      ["a", 0],
      ["b", 0],
      ["c", 9],
      ["s0", 0],
      ["s1", 0],
      ["s2", 9],
    ]);
    const summary = summarizeCostCoverage(
      {
        artifactIds: ["a", "b", "c"],
        sessionsByArtifact: new Map([
          ["a", new Set(["s0"])],
          ["b", new Set(["s1"])],
          ["c", new Set(["s2"])],
        ]),
      },
      (id) => costs.get(id),
      (id) => costs.get(id)
    );
    expect(summary).toEqual({
      coverage: {
        documentCount: 3,
        measuredDocumentCount: 3,
        unknownDocumentCount: 0,
      },
      total: 9,
      median: 0,
      measuredSubsetTotal: null,
      measuredSubsetMedian: null,
    });
  });
});
