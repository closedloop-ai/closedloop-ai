/**
 * Direct unit coverage for the pure projection helpers in `synced-payload.ts`.
 *
 * NOTE ON THE SIBLING FILE: `synced-payload.test.ts` sits beside the module but
 * drives `agentSessionsService` end-to-end for one BigInt-narrowing case — it
 * never calls these helpers directly. Same shape as the misnamed
 * `pull-request-details.test.ts` (ISS-5291 slice 1): a co-located test that
 * makes a module look covered while its own branches sit untouched.
 *
 * These eight exports are pure, so they take no harness and no `@repo/database`
 * mock. Each case asserts the returned value, not that the function ran.
 */

// ISS-5407 moved this ceiling out of `./records` and into `@repo/api`, because
// the desktop detail producer reads the same one; `records.ts` now imports it
// from there too rather than re-exporting it.
import { SESSION_DETAIL_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-detail-limits";
import { describe, expect, it } from "vitest";
import {
  getLoopApiKeySource,
  normalizeTokenUsage,
  sumTokenUsage,
  toAttribution,
  toBoundedDetailEvents,
  toSyncedAgents,
  toSyncedEvents,
  toTokenUsageBreakdown,
} from "./synced-payload";

function usage(
  model: string,
  overrides: Partial<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheWrite5mTokens: number | null;
    cacheWrite1hTokens: number | null;
    estimatedCostUsd: number;
  }> = {}
) {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
    estimatedCostUsd: 0,
    ...overrides,
  };
}

describe("getLoopApiKeySource", () => {
  it("returns the string apiKeySource from a JSON object", () => {
    expect(getLoopApiKeySource({ apiKeySource: "loop" })).toBe("loop");
  });

  it("returns null when apiKeySource is absent, non-string, or the value is not an object", () => {
    expect(getLoopApiKeySource({ apiKeySource: 42 })).toBeNull();
    expect(getLoopApiKeySource({})).toBeNull();
    expect(getLoopApiKeySource(null)).toBeNull();
    expect(getLoopApiKeySource("not-an-object")).toBeNull();
  });
});

describe("toSyncedAgents / toSyncedEvents", () => {
  it("degrade to an empty array when the stored JSON does not match the schema", () => {
    // A malformed persisted blob must not throw through the read path.
    expect(toSyncedAgents({ not: "an array" })).toEqual([]);
    expect(toSyncedAgents([{ missing: "fields" }])).toEqual([]);
    expect(toSyncedEvents(null)).toEqual([]);
    expect(toSyncedEvents([{ missing: "fields" }])).toEqual([]);
  });
});

describe("toTokenUsageBreakdown", () => {
  it("coerces bigint columns and preserves null as 'never reported' for the TTL split", () => {
    const [row] = toTokenUsageBreakdown([
      {
        model: "claude-sonnet-4-5",
        inputTokens: 10n,
        outputTokens: 20n,
        cacheReadTokens: 30n,
        cacheWriteTokens: 40n,
        cacheWrite5mTokens: null,
        cacheWrite1hTokens: null,
        estimatedCost: 1.5,
      },
    ] as unknown as Parameters<typeof toTokenUsageBreakdown>[0]);

    expect(row).toMatchObject({
      model: "claude-sonnet-4-5",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      estimatedCostUsd: 1.5,
    });
    // FEA-3419: null must survive as null — 0 would claim the harness reported
    // a zero split, which is a different fact from never reporting one.
    expect(row.cacheWrite5mTokens).toBeNull();
    expect(row.cacheWrite1hTokens).toBeNull();
  });

  it("coerces a present TTL split to numbers", () => {
    const [row] = toTokenUsageBreakdown([
      {
        model: "m",
        inputTokens: 0n,
        outputTokens: 0n,
        cacheReadTokens: 0n,
        cacheWriteTokens: 100n,
        cacheWrite5mTokens: 60n,
        cacheWrite1hTokens: 40n,
        estimatedCost: 0,
      },
    ] as unknown as Parameters<typeof toTokenUsageBreakdown>[0]);

    expect(row.cacheWrite5mTokens).toBe(60);
    expect(row.cacheWrite1hTokens).toBe(40);
  });
});

describe("normalizeTokenUsage", () => {
  it("sums rows that share a model", () => {
    const [row] = normalizeTokenUsage([
      usage("m", { inputTokens: 10, outputTokens: 1, estimatedCostUsd: 0.5 }),
      usage("m", { inputTokens: 5, outputTokens: 2, estimatedCostUsd: 0.25 }),
    ]);

    expect(row).toMatchObject({
      model: "m",
      inputTokens: 15,
      outputTokens: 3,
      estimatedCostUsd: 0.75,
    });
  });

  it("keeps distinct models separate", () => {
    const rows = normalizeTokenUsage([
      usage("a", { inputTokens: 1 }),
      usage("b", { inputTokens: 2 }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.model).sort()).toEqual(["a", "b"]);
  });

  it("leaves the TTL split absent when NEITHER side reported one", () => {
    // Absent on both sides means those cache writes stay in the unclassified
    // residual — materializing 0 would assert a split nobody measured.
    const [row] = normalizeTokenUsage([
      usage("m", { cacheWriteTokens: 10 }),
      usage("m", { cacheWriteTokens: 5 }),
    ]);

    expect(row.cacheWrite5mTokens).toBeNull();
    expect(row.cacheWrite1hTokens).toBeNull();
  });

  it("materializes the TTL split when EITHER side reported one, treating the absent side as 0", () => {
    const [row] = normalizeTokenUsage([
      usage("m", { cacheWriteTokens: 10 }),
      usage("m", {
        cacheWriteTokens: 5,
        cacheWrite5mTokens: 3,
        cacheWrite1hTokens: 2,
      }),
    ]);

    expect(row.cacheWrite5mTokens).toBe(3);
    expect(row.cacheWrite1hTokens).toBe(2);
  });

  it("does not mutate the caller's rows", () => {
    const first = usage("m", { inputTokens: 10 });
    normalizeTokenUsage([first, usage("m", { inputTokens: 5 })]);

    expect(first.inputTokens).toBe(10);
  });

  it("returns an empty array for no rows", () => {
    expect(normalizeTokenUsage([])).toEqual([]);
  });
});

describe("toAttribution", () => {
  it("returns null when every attribution field is null", () => {
    expect(
      toAttribution({
        repositoryFullName: null,
        worktreePath: null,
        sourceArtifactId: null,
        sourceLoopId: null,
        baseBranch: null,
      })
    ).toBeNull();
  });

  it("returns the record when any single field is populated", () => {
    expect(
      toAttribution({
        repositoryFullName: null,
        worktreePath: null,
        sourceArtifactId: null,
        sourceLoopId: null,
        baseBranch: "main",
      })
    ).toMatchObject({ baseBranch: "main", repositoryFullName: null });
  });
});

describe("sumTokenUsage", () => {
  it("folds to zeros for an empty set", () => {
    expect(sumTokenUsage([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
    });
  });

  it("accumulates across rows and treats an ABSENT cost as 0", () => {
    expect(
      sumTokenUsage([
        usage("a", {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          estimatedCostUsd: 1.25,
        }),
        usage("b", {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 40,
          // `estimatedCostUsd` is optional on the wire contract (`number |
          // undefined`) — absent, never null. This is the reachable case the
          // `?? 0` fold exists for.
          estimatedCostUsd: undefined,
        }),
      ])
    ).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheWriteTokens: 44,
      estimatedCost: 1.25,
    });
  });
});

describe("toBoundedDetailEvents", () => {
  const eventRow = (n: number) => ({
    externalEventId: `e${n}`,
    agentExternalId: null,
    eventType: "tool_use",
    toolName: null,
    eventCreatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n % 60)),
  });
  const rows = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      eventRow(i)
    ) as unknown as Parameters<typeof toBoundedDetailEvents>[0];

  it("omits the truncation flag entirely when the stream is complete", () => {
    const { events, truncation } = toBoundedDetailEvents(rows(3));

    expect(events).toHaveLength(3);
    // Absence is the contract's ONLY encoding of "complete" — a present falsy
    // value would serialize `eventsTruncated: false` onto the wire.
    expect(truncation).toEqual({});
    expect("eventsTruncated" in truncation).toBe(false);
  });

  it("maps the row shape onto the served event contract", () => {
    const { events } = toBoundedDetailEvents(rows(1));

    expect(events[0]).toEqual({
      externalEventId: "e0",
      agentExternalId: null,
      eventType: "tool_use",
      toolName: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("is NOT truncated at exactly the cap", () => {
    // The select reads one past the cap, so equality means the stream ended
    // right at it — the boundary that decides whether the flag is honest.
    const { events, truncation } = toBoundedDetailEvents(
      rows(SESSION_DETAIL_EVENT_MAX_ROWS)
    );

    expect(events).toHaveLength(SESSION_DETAIL_EVENT_MAX_ROWS);
    expect(truncation).toEqual({});
  });

  it("bounds back to the cap and reports truncation one row past it", () => {
    const { events, truncation } = toBoundedDetailEvents(
      rows(SESSION_DETAIL_EVENT_MAX_ROWS + 1)
    );

    expect(events).toHaveLength(SESSION_DETAIL_EVENT_MAX_ROWS);
    expect(truncation).toEqual({ eventsTruncated: true });
    // A stable chronological PREFIX, not an arbitrary window.
    expect(events[0].externalEventId).toBe("e0");
  });
});
