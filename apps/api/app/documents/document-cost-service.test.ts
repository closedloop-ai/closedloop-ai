import {
  DocumentType,
  DocumentTypeInput,
  IssueStatus,
} from "@repo/api/src/types/document";
import { documentCostsRequestSchema } from "@repo/api/src/types/document-costs";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import {
  TokenCostBasis,
  TokenCostCompleteness,
} from "@repo/api/src/types/token-cost-provenance";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentCostDb,
  type DocumentCostDbState,
  readScopedDocumentCosts,
} from "@/__tests__/support/documents/document-cost.test-db";
import { toTokenEventCostEvidence } from "@/app/agent-sessions/service/token-event-persistence";
import { documentCostService } from "./document-cost-service";

vi.mock("@repo/database", async (importActual) => {
  const actual = await importActual<typeof import("@repo/database")>();
  return {
    Prisma: actual.Prisma,
    withDb: Object.assign(vi.fn(), {
      tx: async (run: () => unknown) => await run(),
    }),
    ArtifactType: { DOCUMENT: "DOCUMENT" },
  };
});

import { withDb } from "@repo/database";

const docA = "00000000-0000-4000-8000-000000000001";
const docB = "00000000-0000-4000-8000-000000000002";
const sessionA = "00000000-0000-4000-8000-000000000003";
const startDate = "2026-10-01T00:00:00.000Z";
const endDate = "2026-10-02T00:00:00.000Z";
const organizationId = "org-a";
let state: DocumentCostDbState;
const fakeDb = createDocumentCostDb(() => state);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  state = {
    docs: [
      { id: docA, organizationId, subtype: DocumentType.Prd },
      { id: docB, organizationId: "org-b", subtype: DocumentType.Doc },
    ],
    links: [
      {
        sessionId: sessionA,
        docId: docA,
        organizationId,
        sourceOrg: organizationId,
        targetOrg: organizationId,
      },
    ],
    sessions: [
      { id: sessionA, organizationId, inputTokens: 40n, estimatedCost: 17 },
    ],
    events: [
      sessionEvent(0, 5, new Date("2026-09-30T23:59:59Z")),
      sessionEvent(1, 2, new Date(startDate)),
      sessionEvent(2, 3, new Date("2026-10-01T12:00:00Z")),
      sessionEvent(3, 7, new Date(endDate)),
    ],
  };
  vi.mocked(withDb).mockImplementation(async (fn) => await fn(fakeDb as never));
});

afterEach(() => vi.useRealTimers());

function sessionEvent(index: number, cost: number, date: Date) {
  return {
    id: `event-${index}`,
    sessionId: sessionA,
    inputTokens: 10n,
    cost,
    completeness: TokenCostCompleteness.Complete as string | null,
    date,
  };
}

describe("linked document event costs", () => {
  it("uses the canonical complete subtotal across API and subscription estimate lanes", async () => {
    const evidence = toTokenEventCostEvidence({
      externalEventId: "event-cost",
      model: "model",
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      createdAt: startDate,
      costSummary: {
        completeness: TokenCostCompleteness.Complete,
        subtotalUsd: 1.25,
        lanes: [
          { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 0.5 },
          { basis: TokenCostBasis.SubscriptionEquivalent, subtotalUsd: 0.75 },
        ],
      },
    });
    state.events[1].cost = evidence.estimatedCost;
    state.events[1].completeness = evidence.costCompleteness;
    expect(
      (
        await documentCostService.read(organizationId, {
          artifactIds: [docA],
          startDate,
          endDate,
        })
      ).artifacts[0].totalEstimatedCost
    ).toBe(4.25);
  });
  it("prices only tokens incurred in the half-open window, including subscription and API event totals", async () => {
    const result = await documentCostService.read(organizationId, {
      artifactIds: [docA],
      startDate,
      endDate,
    });
    expect(scalarCosts(result.artifacts)).toEqual([
      { artifactId: docA, totalEstimatedCost: 5 },
    ]);
  });
  it("deduplicates multiple contributing links to one session", async () => {
    state.links.push({
      ...state.links[0],
      relation: ArtifactRefRelation.Reviewed,
    });
    expect(
      (
        await documentCostService.read(organizationId, {
          artifactIds: [docA],
          startDate,
          endDate,
        })
      ).artifacts[0].totalEstimatedCost
    ).toBe(5);
  });
  it("prices each artifact's linked session independently and excludes cross-org artifacts", async () => {
    state.docs.push({
      ...state.docs[0],
      id: "00000000-0000-4000-8000-000000000004",
      subtype: DocumentType.ImplementationPlan,
    });
    state.links.push({ ...state.links[0], docId: state.docs[2].id });
    const result = await documentCostService.read(organizationId, {
      artifactIds: [docA, docB, state.docs[2].id],
      startDate,
      endDate,
    });
    expect(scalarCosts(result.artifacts)).toEqual([
      { artifactId: docA, totalEstimatedCost: 5 },
      { artifactId: state.docs[2].id, totalEstimatedCost: 5 },
    ]);
  });
  it.each(["organizationId", "sourceOrg", "targetOrg"] as const)(
    "excludes cross-org %s link evidence",
    async (field) => {
      state.links[0][field] = "org-b";
      expect(
        (
          await documentCostService.read(organizationId, {
            artifactIds: [docA],
            startDate,
            endDate,
          })
        ).artifacts.map(withoutTrendline)
      ).toEqual([{ artifactId: docA, totalEstimatedCost: 0 }]);
    }
  );
  it("does not price mere references", async () => {
    state.links[0].relation = ArtifactRefRelation.Referenced;
    expect(
      (await documentCostService.read(organizationId, { artifactIds: [docA] }))
        .artifacts[0].totalEstimatedCost
    ).toBe(0);
  });
  it("keeps missing event coverage unavailable instead of substituting lifetime spend", async () => {
    state.sessions[0].inputTokens = 50n;
    expect(
      (
        await documentCostService.read(organizationId, {
          artifactIds: [docA],
          startDate,
          endDate,
        })
      ).artifacts.map(withoutTrendline)
    ).toEqual([{ artifactId: docA }]);
  });
  it.each([
    TokenCostCompleteness.Partial,
    TokenCostCompleteness.Unavailable,
    "future-completeness",
    null,
  ])("does not publish a partial total for %s", async (completeness) => {
    state.events[1].completeness = completeness;
    expect(
      (
        await documentCostService.read(organizationId, {
          artifactIds: [docA],
          startDate,
          endDate,
        })
      ).artifacts.map(withoutTrendline)
    ).toEqual([{ artifactId: docA }]);
  });
  it("preserves missing pricing as unavailable", async () => {
    state.events[1].cost = null;
    expect(
      (
        await documentCostService.read(organizationId, {
          artifactIds: [docA],
          startDate,
          endDate,
        })
      ).artifacts.map(withoutTrendline)
    ).toEqual([{ artifactId: docA }]);
  });
  it("returns a real zero when captured events all occur outside the window", async () => {
    expect(
      (
        await documentCostService.read(organizationId, {
          artifactIds: [docA],
          startDate: "2026-10-03T00:00:00Z",
        })
      ).artifacts.map(withoutTrendline)
    ).toEqual([{ artifactId: docA, totalEstimatedCost: 0 }]);
  });
  it("cannot price a legacy session without token events", async () => {
    state.events = [];
    expect(
      (
        await documentCostService.read(organizationId, { artifactIds: [docA] })
      ).artifacts.map(withoutTrendline)
    ).toEqual([{ artifactId: docA }]);
  });
});

it("deduplicates a shared session in the server summary while retaining per-document median", async () => {
  state.docs[1].organizationId = organizationId;
  state.links.push({ ...state.links[0], docId: docB });
  const result = await readScopedDocumentCosts(organizationId, {
    artifactIds: [],
    scope: { types: [DocumentType.Prd, DocumentType.Doc] },
    startDate,
    endDate,
  });
  expect(result.totalEstimatedCost).toBe(5);
  expect(result.medianEstimatedCost).toBe(5);
  expect(scalarCosts(result.artifacts)).toEqual([]);
});

describe("document cost scope validation", () => {
  it.each([DocumentType.Feature, DocumentTypeInput.Issue])(
    "accepts the production issue subtype %s and lifecycle vocabulary",
    (type) => {
      const request = documentCostsRequestSchema.parse({
        artifactIds: [],
        scope: { types: [type], status: [IssueStatus.InProgress] },
      });
      expect(request.scope).toEqual({
        types: [DocumentType.Feature],
        status: [IssueStatus.InProgress],
      });
    }
  );
  it.each([{ types: [] }, { types: [DocumentType.Template] }])(
    "rejects non-index type selections %j",
    ({ types }) => {
      expect(
        documentCostsRequestSchema.safeParse({
          artifactIds: [],
          scope: { types },
        }).success
      ).toBe(false);
    }
  );
  it("rejects malformed or unknown scope fields", () => {
    expect(
      documentCostsRequestSchema.safeParse({
        artifactIds: [],
        scope: { recencyDays: "30" },
      }).success
    ).toBe(false);
    expect(
      documentCostsRequestSchema.safeParse({
        artifactIds: [],
        scope: { ignoredFilter: true },
      }).success
    ).toBe(false);
  });
});

describe("org-wide issue costs", () => {
  it("prices selected issues while excluding another organization's issue", async () => {
    state.docs[0].subtype = DocumentType.Feature;
    state.docs[1].subtype = DocumentType.Feature;
    const result = await documentCostService.read(organizationId, {
      artifactIds: [docA, docB],
      startDate,
      endDate,
    });
    expect(scalarCosts(result.artifacts)).toEqual([
      { artifactId: docA, totalEstimatedCost: 5 },
    ]);
  });

  it("summarizes the whole issue population, excluding other subtypes and organizations", async () => {
    state.docs[0].subtype = DocumentType.Feature;
    state.docs[1].subtype = DocumentType.Feature;
    state.docs.push({
      ...state.docs[0],
      id: "00000000-0000-4000-8000-000000000005",
      subtype: DocumentType.Doc,
    });
    const result = await readScopedDocumentCosts(organizationId, {
      artifactIds: [],
      scope: { types: [DocumentType.Feature] },
      startDate,
      endDate,
    });
    expect(result.totalEstimatedCost).toBe(5);
    expect(result.medianEstimatedCost).toBe(5);
  });

  it("preserves the existing document-only population when scope types are absent", async () => {
    state.docs[0].subtype = DocumentType.Feature;
    expect(
      await readScopedDocumentCosts(organizationId, {
        artifactIds: [],
        scope: {},
      })
    ).toMatchObject({ artifacts: [], totalEstimatedCost: 0 });
  });
});

function withoutTrendline({
  trendline: _trendline,
  ...cost
}: {
  artifactId: string;
  totalEstimatedCost?: number;
  trendline?: (number | null)[];
}) {
  return cost;
}
function scalarCosts(
  costs: {
    artifactId: string;
    totalEstimatedCost?: number;
    trendline?: (number | null)[];
  }[]
) {
  return costs.map(withoutTrendline);
}

it("measures actual daily event spend, deduplicating shared sessions and retaining artifact medians", async () => {
  state.docs[1].organizationId = organizationId;
  state.links.push({ ...state.links[0], docId: docB });
  const result = await readScopedDocumentCosts(organizationId, {
    artifactIds: [],
    scope: { types: [DocumentType.Prd, DocumentType.Doc] },
  });
  expect(result.trendlines).toEqual({
    startDate: "2026-09-19T00:00:00.000Z",
    endDate: "2026-10-02T12:00:00.000Z",
    totalEstimatedCost: [...new Array(11).fill(0), 5, 5, 7],
    medianEstimatedCost: [...new Array(11).fill(0), 5, 5, 7],
    measuredSubsetTotalEstimatedCost: new Array(14).fill(null),
    measuredSubsetMedianEstimatedCost: new Array(14).fill(null),
    coverage: new Array(14).fill({
      documentCount: 2,
      measuredDocumentCount: 2,
      unknownDocumentCount: 0,
    }),
  });
});

it("keeps incomplete daily pricing as a gap while preserving known days", async () => {
  state.events[1].cost = null;
  const result = await documentCostService.read(organizationId, {
    artifactIds: [docA],
    startDate,
    endDate,
  });
  expect(result.trendlines?.totalEstimatedCost).toEqual([
    ...new Array(11).fill(0),
    5,
    null,
    7,
  ]);
  expect(result.artifacts[0].trendline).toEqual(
    result.trendlines?.totalEstimatedCost
  );
  expect(result.artifacts[0].totalEstimatedCost).toBeUndefined();
});

it("measures every sparkline day when the list window starts inside the 14 days", async () => {
  const result = await documentCostService.read(organizationId, {
    artifactIds: [docA],
    startDate,
    endDate,
  });
  expect(result.artifacts[0].totalEstimatedCost).toBe(5);
  expect(result.trendlines?.totalEstimatedCost).toEqual([
    ...new Array(11).fill(0),
    5,
    5,
    7,
  ]);
});

it("does not fabricate history when lifetime token counters exceed captured evidence", async () => {
  state.sessions[0].inputTokens = 50n;
  const result = await documentCostService.read(organizationId, {
    artifactIds: [docA],
  });
  expect(result.trendlines?.totalEstimatedCost).toEqual(
    new Array(14).fill(null)
  );
});

it("sums every event on a day without a page bound", async () => {
  state.events = Array.from({ length: 501 }, (_, index) =>
    sessionEvent(index, 1, new Date(startDate))
  );
  state.sessions[0].inputTokens = 5010n;
  const result = await documentCostService.read(organizationId, {
    artifactIds: [docA],
    startDate,
    endDate,
  });
  expect(result.artifacts[0].totalEstimatedCost).toBe(501);
  expect(result.trendlines?.totalEstimatedCost[12]).toBe(501);
});

it("reports a corrupt persisted event price and leaves that day a gap instead of a plausible subtotal", async () => {
  const errorLog = vi.spyOn(log, "error").mockImplementation(() => undefined);
  state.events[1].cost = -1;
  const result = await documentCostService.read(organizationId, {
    artifactIds: [docA],
    startDate,
    endDate,
  });
  expect(result.trendlines?.totalEstimatedCost).toEqual([
    ...new Array(11).fill(0),
    5,
    null,
    7,
  ]);
  expect(errorLog).toHaveBeenCalledWith(
    "[document-cost] Invalid token-event cost",
    expect.objectContaining({ organizationId, tokenEventId: "event-1" })
  );
});

it("applies exact scope IDs with organization and subtype authority, preserving explicit empty cohorts", async () => {
  state.docs[0].subtype = DocumentType.Feature;
  state.docs[1].subtype = DocumentType.Feature;
  const result = await readScopedDocumentCosts(organizationId, {
    artifactIds: [],
    scope: { types: [DocumentType.Feature], artifactIds: [docA, docB] },
    startDate,
    endDate,
  });
  expect(result.artifacts.map((artifact) => artifact.artifactId)).toEqual([
    docA,
  ]);
  expect(result.totalEstimatedCost).toBe(5);
  const empty = await readScopedDocumentCosts(organizationId, {
    artifactIds: [],
    scope: { types: [DocumentType.Feature], artifactIds: [] },
  });
  expect(empty.artifacts).toEqual([]);
  expect(empty.totalEstimatedCost).toBe(0);
  expect(empty.trendlines?.totalEstimatedCost).toEqual(new Array(14).fill(0));
  expect(empty.trendlines?.medianEstimatedCost).toEqual(
    new Array(14).fill(null)
  );
});
