// FEA-4276: the Sessions LIST cost and the session DETAIL cost must agree for
// the same record. Historically the list read the stored per-model rollup
// (`SessionDetail.estimatedCost`) directly while the detail reconciled cost from
// the per-event token stream (FEA-2926) — so a session whose rollup had gone
// stale/inflated relative to the (repriced) per-event costs read one figure in
// the table and another in the card it opens ($1,378.39 list vs $33.24 detail).
// Both surfaces now derive the displayed cost from the SAME captured-cost
// authority (`reconcileSessionCost`); these tests pin that parity for a normal
// record and for the high-magnitude divergence, plus the rollup-fallback paths.

import { TokenCostCompleteness } from "@repo/api/src/types/token-cost-provenance";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionDetailRecord,
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";
import { SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS } from "./records";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const EVENT_AT = new Date("2026-01-01T00:10:00.000Z");
const SESSION_ID = "session-1";

// Per-event input+output token count for the parity fixtures. The value itself
// doesn't matter — only that the per-event token counts sum to the record's
// rollup token total, so the FEA-4276 (shafty review) ingest-completeness
// cross-check sees a COMPLETE stream and lets the per-event cost sum win. A
// short stream whose tokens summed to LESS than the rollup would (correctly) be
// treated as a dropped-chunk under-report and fall back to the rollup, which is
// what the dedicated completeness tests in cost-query-reconciliation.test.ts
// cover — these parity fixtures model the whole-stream reprice case instead.
const TOKENS_PER_EVENT_INPUT = 10;
const TOKENS_PER_EVENT_OUTPUT = 5;
const TOKENS_PER_EVENT = TOKENS_PER_EVENT_INPUT + TOKENS_PER_EVENT_OUTPUT;

/**
 * Drive both the list and detail read paths for a single session that has the
 * given stored rollup and per-event token-cost stream, and return the `cost`
 * string each surface displays. The list's per-event aggregate is served by the
 * `$queryRaw` mock (the bulk reconciler `getReconciledCostsBySessionId`, one
 * bounded org-scoped raw aggregate); the detail path reads the same events off
 * the record's `tokenEvents` select.
 *
 * The fixture models a COMPLETE per-event stream: each event carries a token
 * count and the record's rollup token total is set to their sum, so the
 * FEA-4276 (shafty review) ingest-completeness cross-check
 * (`tokenEventTokenSum >= rollupTokenTotal`) passes on BOTH surfaces and the
 * per-event cost authority wins for a divergent rollup. The list feeds the
 * cross-check through the `$queryRaw` aggregate's `tokenSum`; the detail feeds
 * it by summing the per-event `inputTokens`/`outputTokens` — both must agree
 * with the rollup token total for the streams to read as complete.
 */
async function readListAndDetailCost(input: {
  storedRollup: number;
  tokenEventCosts: number[];
  costCompleteness?: (string | null)[];
}): Promise<{ listCost: string; detailCost: string }> {
  const tokenEvents = input.tokenEventCosts.map((estimatedCost, index) => ({
    eventCreatedAt: EVENT_AT,
    estimatedCost,
    costCompleteness: input.costCompleteness?.[index] ?? null,
    inputTokens: TOKENS_PER_EVENT_INPUT,
    outputTokens: TOKENS_PER_EVENT_OUTPUT,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }));
  const eventSum = input.tokenEventCosts.reduce((sum, c) => sum + c, 0);
  // The rollup token total the completeness cross-check compares against: the
  // sum of the per-event token counts, so a complete stream reads as complete.
  const rollupTokenTotal = input.tokenEventCosts.length * TOKENS_PER_EVENT;

  // --- LIST path ---
  installDb({
    sessionDetail: {
      findMany: vi.fn().mockResolvedValue([
        buildSessionListRecord({
          artifactId: SESSION_ID,
          estimatedCost: input.storedRollup,
          inputTokens: rollupTokenTotal,
          outputTokens: 0,
        }),
      ]),
      count: vi.fn().mockResolvedValue(1),
    },
    $queryRaw: vi.fn().mockResolvedValue(
      input.tokenEventCosts.length > 0
        ? [
            {
              agentSessionId: SESSION_ID,
              eventCount: BigInt(input.tokenEventCosts.length),
              // These parity fixtures use all-nonzero costs, so every row is
              // priced — the price-completeness gate passes.
              pricedCount: BigInt(
                input.tokenEventCosts.filter(
                  (cost, index) =>
                    input.costCompleteness?.[index] ===
                      TokenCostCompleteness.Complete ||
                    ((input.costCompleteness?.[index] ?? null) === null &&
                      cost > 0)
                ).length
              ),
              costSum: eventSum,
              // Σ per-event token counts. Equal to the rollup token total above,
              // so the ingest-completeness cross-check reads the stream as
              // complete and the per-event cost sum wins.
              tokenSum: BigInt(rollupTokenTotal),
            },
          ]
        : []
    ),
  });
  const list = await agentSessionsService.findSessions({
    organizationId: "org-1",
    filters: {},
  });
  const listCost = list.items[0]?.cost ?? "";

  // --- DETAIL path (same record + events) ---
  installDb({
    sessionDetail: {
      findFirst: vi.fn().mockResolvedValue(
        buildSessionDetailRecord({
          artifactId: SESSION_ID,
          estimatedCost: input.storedRollup,
          inputTokens: rollupTokenTotal,
          outputTokens: 0,
          tokenEvents,
        })
      ),
    },
    sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
  });
  const detail = await agentSessionsService.findSessionDetail({
    id: SESSION_ID,
    organizationId: "org-1",
  });
  const detailCost = detail?.cost ?? "";

  return { listCost, detailCost };
}

describe("session cost list/detail parity (FEA-4276)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the same cost on list and detail for a normal record", async () => {
    const { listCost, detailCost } = await readListAndDetailCost({
      // Rollup happens to agree with the per-event sum here.
      storedRollup: 0.5,
      tokenEventCosts: [0.15, 0.35],
    });

    expect(listCost).toBe("$0.50");
    expect(detailCost).toBe("$0.50");
    expect(listCost).toBe(detailCost);
  });

  it("reconciles a high-magnitude divergence to the per-event authority on BOTH surfaces", async () => {
    // The dossier's 41× case: the stored rollup is inflated to $1,378.39 while
    // the (repriced) per-event stream sums to $33.24. Neither surface may show
    // the stale rollup — both must show the per-event authority.
    const { listCost, detailCost } = await readListAndDetailCost({
      storedRollup: 1378.39,
      tokenEventCosts: [5, 10, 7, 11.24],
    });

    expect(listCost).toBe("$33.24");
    expect(detailCost).toBe("$33.24");
    expect(listCost).toBe(detailCost);
  });

  it("falls back to the stored rollup on BOTH surfaces when there are no token events", async () => {
    const { listCost, detailCost } = await readListAndDetailCost({
      storedRollup: 1.25,
      tokenEventCosts: [],
    });

    expect(listCost).toBe("$1.25");
    expect(detailCost).toBe("$1.25");
    expect(listCost).toBe(detailCost);
  });

  it("keeps the rollup for legacy literal-zero events after the no-backfill migration", async () => {
    const { listCost, detailCost } = await readListAndDetailCost({
      storedRollup: 12.5,
      tokenEventCosts: [0, 0],
    });

    expect(listCost).toBe("$12.50");
    expect(detailCost).toBe("$12.50");
  });

  it("keeps the rollup when every event carries a knowingly partial subtotal", async () => {
    const { listCost, detailCost } = await readListAndDetailCost({
      storedRollup: 12.5,
      tokenEventCosts: [2, 3],
      costCompleteness: [
        TokenCostCompleteness.Partial,
        TokenCostCompleteness.Partial,
      ],
    });

    expect(listCost).toBe("$12.50");
    expect(detailCost).toBe("$12.50");
  });

  it("falls back to the stored rollup on BOTH surfaces when the per-event read is capped", async () => {
    // A count at/above the cap means the per-event read is (or would be)
    // truncated, so both paths must ignore the (under-reporting) sum and show
    // the rollup — they stay reconciled even at the cap boundary.
    const cappedCosts = Array.from(
      { length: SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS },
      () => 0.0001
    );
    const { listCost, detailCost } = await readListAndDetailCost({
      storedRollup: 1.25,
      tokenEventCosts: cappedCosts,
    });

    expect(listCost).toBe("$1.25");
    expect(detailCost).toBe("$1.25");
    expect(listCost).toBe(detailCost);
  });
});
