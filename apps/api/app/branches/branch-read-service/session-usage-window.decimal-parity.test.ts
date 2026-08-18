import { describe, expect, it } from "vitest";
import type { SessionSpendEvent } from "./session-usage-window";
import {
  numberFromDecimal,
  windowedSpendBySession,
} from "./session-usage-window";

// A Prisma Decimal-like value: the production `estimatedCost` field is typed
// `{ toString(): string } | number | null`, so a stub with a `.toString()` is a
// faithful stand-in for the real Decimal without pulling in the runtime.
function decimalLike(value: string): { toString(): string } {
  return { toString: () => value };
}

const sessionId = "session-1";

// Regression pin for the drift surface the ISS-4697 move opened: the windowed
// per-event spend path (`windowedSpendBySession` → `numberFromDecimal`) and the
// lifetime session-total path (`resolveSessionSpend`/`branch-read-service` →
// `numberFromDecimal`) now both price cost through the SINGLE exported
// `numberFromDecimal`. Before consolidation the file carried a byte-identical
// private `decimalToNumber` twin, so hardening one path for Decimal precision or
// a non-finite floor and not the other would have made the same branch report
// two different costs. These tests assert the two paths agree on the same
// Decimal input, so any future divergence fails here rather than in the UI.
describe("branch session-usage Decimal→number parity", () => {
  it("prices a Decimal-like estimatedCost identically for both spend paths", () => {
    const cost = decimalLike("1.234567");
    const event: SessionSpendEvent = {
      agentSessionId: sessionId,
      eventCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: cost,
    };

    // Windowed path, with an open window so the single event is fully counted.
    const windowed = windowedSpendBySession([event], undefined);
    const windowedCost = windowed.get(sessionId)?.estimatedCostUsd;

    // Lifetime path helper used by resolveSessionSpend / branch-read-service.
    const lifetimeCost = numberFromDecimal(cost);

    expect(windowedCost).toBe(lifetimeCost);
    expect(windowedCost).toBe(1.234_567);
  });

  it("sums multiple in-window events to the same total the lifetime helper yields", () => {
    const costs = ["0.5", "1.25", "2.75"];
    const events: SessionSpendEvent[] = costs.map((value, index) => ({
      agentSessionId: sessionId,
      eventCreatedAt: new Date(`2026-01-0${index + 1}T00:00:00.000Z`),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: decimalLike(value),
    }));

    const windowed = windowedSpendBySession(events, undefined);
    const windowedTotal = windowed.get(sessionId)?.estimatedCostUsd;

    const lifetimeTotal = costs.reduce(
      (sum, value) => sum + numberFromDecimal(decimalLike(value)),
      0
    );

    expect(windowedTotal).toBe(lifetimeTotal);
    expect(windowedTotal).toBe(4.5);
  });

  it("converts a numeric estimatedCost without a toString round-trip", () => {
    expect(numberFromDecimal(3.14)).toBe(3.14);
  });

  it("lets an unknown nullable token-event cost contribute nothing", () => {
    expect(numberFromDecimal(null)).toBe(0);
  });
});
