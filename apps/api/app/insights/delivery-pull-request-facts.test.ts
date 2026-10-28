/**
 * The Delivery view's Merged PRs, prior window, closed-unmerged count and median
 * read the Branches card's fold (ISS-12408). These cases drive the real reader
 * against a fake `$queryRaw` and pin what it asks for and how it maps the answer.
 */

import { InsightsScope } from "@repo/api/src/types/insights";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
  (await import("@/__tests__/support/insights/service.test-db")).databaseMock()
);

import { withDb } from "@repo/database";
import {
  flattenRawSql,
  ORG,
} from "@/__tests__/support/insights/service.test-db";
import { readDeliveryPullRequestFacts } from "./delivery-pull-request-facts";

const USER = "user-1";
const TEAM = "team-1";
const CTX = { organizationId: ORG, userId: USER, scope: InsightsScope.Org };
const START = new Date("2026-05-01T00:00:00.000Z");
const END = new Date("2026-06-01T00:00:00.000Z");
const PRIOR_START = new Date("2026-04-01T00:00:00.000Z");
const RANGE = {
  start: START,
  end: END,
  priorStart: PRIOR_START,
  priorEnd: START,
};

type Recorded = { text: string; values: unknown[] };
type FoldRow = {
  key: string;
  merged: number;
  sized: number;
  median_size: number | null;
  closed_unmerged: number;
  decided_identities: number;
  conflicted: boolean;
};

function foldRow(key: string, overrides: Partial<FoldRow> = {}): FoldRow {
  return {
    key,
    merged: 0,
    sized: 0,
    median_size: null,
    closed_unmerged: 0,
    decided_identities: 0,
    conflicted: false,
    ...overrides,
  };
}

function mockFold(recorded: Recorded[], rows: FoldRow[]): void {
  vi.mocked(withDb).mockImplementation((cb) =>
    Promise.resolve(
      cb({
        $queryRaw: (sql: unknown) => {
          recorded.push(flattenRawSql(sql));
          return Promise.resolve(rows);
        },
      } as never)
    )
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readDeliveryPullRequestFacts", () => {
  it("maps the current window's merged, sized, closed-unmerged and median, and the prior window's merged", async () => {
    mockFold(
      [],
      [
        foldRow("current", {
          merged: 12,
          sized: 10,
          closed_unmerged: 3,
          median_size: 240,
        }),
        foldRow("prior", { merged: 8 }),
      ]
    );

    await expect(readDeliveryPullRequestFacts(CTX, RANGE)).resolves.toEqual({
      merged: 12,
      sized: 10,
      closedUnmerged: 3,
      medianSize: 240,
      priorMerged: 8,
    });
  });

  it("asks one statement for both windows, half-open on the dates it was given", async () => {
    const recorded: Recorded[] = [];
    mockFold(recorded, [foldRow("current"), foldRow("prior")]);

    await readDeliveryPullRequestFacts(CTX, RANGE);

    expect(recorded).toHaveLength(1);
    expect(recorded[0].values).toContainEqual(["current", "prior"]);
    expect(recorded[0].values).toContainEqual([
      START.toISOString(),
      PRIOR_START.toISOString(),
    ]);
    expect(recorded[0].values).toContainEqual([
      END.toISOString(),
      START.toISOString(),
    ]);
    expect(recorded[0].text).toContain("c.merged_at < w.end_at");
  });

  it("does not ask for a prior window when there is none, and reports no prior merges", async () => {
    const recorded: Recorded[] = [];
    mockFold(recorded, [foldRow("current", { merged: 5 })]);

    const facts = await readDeliveryPullRequestFacts(CTX, {
      ...RANGE,
      priorStart: null,
    });

    expect(recorded[0].values).toContainEqual(["current"]);
    expect(facts.priorMerged).toBe(0);
    expect(facts.merged).toBe(5);
  });

  it("reads an empty answer as zeros and no median, never as unknown", async () => {
    mockFold([], []);

    await expect(readDeliveryPullRequestFacts(CTX, RANGE)).resolves.toEqual({
      merged: 0,
      sized: 0,
      closedUnmerged: 0,
      medianSize: null,
      priorMerged: 0,
    });
  });
});

describe("the fold's tenant and scope bounds", () => {
  it("scopes an org read to the organization and the Product-eligible branches", async () => {
    const recorded: Recorded[] = [];
    mockFold(recorded, []);

    await readDeliveryPullRequestFacts(CTX, RANGE);

    expect(recorded[0].text).toContain("a.organization_id = ");
    expect(recorded[0].values).toContain(ORG);
    expect(recorded[0].values).not.toContain(USER);
    expect(recorded[0].text).toContain("branch_detail b");
  });

  it("narrows the Me scope to the requesting user's artifacts", async () => {
    const recorded: Recorded[] = [];
    mockFold(recorded, []);

    await readDeliveryPullRequestFacts(
      { ...CTX, scope: InsightsScope.Me },
      RANGE
    );

    expect(recorded[0].text).toContain("a.created_by_id = ");
    expect(recorded[0].values).toContain(USER);
    expect(recorded[0].values).toContain(ORG);
  });

  it("narrows the Team scope to that team's members without losing the org bound", async () => {
    const recorded: Recorded[] = [];
    mockFold(recorded, []);

    await readDeliveryPullRequestFacts(
      { ...CTX, scope: InsightsScope.Team, teamId: TEAM },
      RANGE
    );

    expect(recorded[0].text).toContain("FROM team_members tm");
    expect(recorded[0].values).toContain(TEAM);
    expect(recorded[0].text).toContain("a.organization_id");
    expect(recorded[0].values).toContain(ORG);
  });

  it("matches nothing for a Team scope with no team", async () => {
    const recorded: Recorded[] = [];
    mockFold(recorded, []);

    await readDeliveryPullRequestFacts(
      { ...CTX, scope: InsightsScope.Team },
      RANGE
    );

    expect(recorded[0].text).toContain("false");
  });
});
