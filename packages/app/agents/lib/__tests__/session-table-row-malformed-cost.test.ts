import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { MAX_SESSION_ESTIMATED_COST_USD } from "@repo/cost/session-web-search-cost";
import { describe, expect, it } from "vitest";
import { createAgentSessionListItemFixture } from "../../components/sessions/session-list-fixtures";
import { CostAvailability } from "../cost-availability";
import { agentSessionToSessionTableRow } from "../session-table-row";

/**
 * ISS-9431: the Cost cell over inputs that arrive present but unusable.
 *
 * The list item crosses JSON (web) or structured-clone IPC (Desktop), so a
 * string, non-finite, negative, fractional or out-of-range value is reachable at
 * runtime even though the type says `number` — the trust-boundary case root
 * `AGENTS.md` requires tests for. An unusable `estimatedCost` is the figure
 * itself and always blanks the cell. An unusable counter blanks it only when the
 * answer turns on that counter: it must not invent a `$0.00` for a subscription
 * row whose only work evidence it is, and must not hide a price the row reported.
 */

const NOW = new Date("2026-06-17T12:00:00.000Z");
const EMPTY_CELL = "—";

const UNUSABLE_COUNTERS: [string, unknown][] = [
  ["turns", "3"],
  ["inputTokens", "1000"],
  ["outputTokens", Number.NaN],
  ["cacheReadTokens", -1],
  ["cacheWriteTokens", Number.POSITIVE_INFINITY],
  ["toolUseCount", 1.5],
  ["componentInvocationCount", 2 ** 53],
];

describe("agentSessionToSessionTableRow Cost over unusable inputs (ISS-9431)", () => {
  it.each([
    ["a string", "3.50"],
    ["negative", -3.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["past the stored cost ceiling", MAX_SESSION_ESTIMATED_COST_USD + 1],
  ])(
    "renders a subscription row's Cost as unavailable when estimatedCost is %s",
    (_label, estimatedCost) => {
      const row = toRow(subscriptionItem({ estimatedCost }));

      expect(row.costLabel).toBe(EMPTY_CELL);
      expect(row.costValue).toBeNull();
      expect(row.costAvailability).toBe(CostAvailability.Unavailable);
      expect(row.costTooltip).toBeNull();
    }
  );

  it.each(UNUSABLE_COUNTERS)(
    "keeps a priced metered row's figure when %s is %s",
    (field, value) => {
      const row = toRow(meteredItem({ [field]: value }));

      expect(row.costLabel).toBe("$12.50");
      expect(row.costValue).toBe(12.5);
      expect(row.costAvailability).toBe(CostAvailability.Available);
    }
  );

  it.each(UNUSABLE_COUNTERS)(
    "keeps a subscription row's covered figure when %s is %s",
    (field, value) => {
      const row = toRow(subscriptionItem({ [field]: value }));

      expect(row.costLabel).toBe("$3.50");
      expect(row.costAvailability).toBe(CostAvailability.Subscription);
      expect(row.costTooltip).toBe("Billed through your subscription");
    }
  );

  it.each(UNUSABLE_COUNTERS)(
    "renders an unpriced subscription row's Cost as unavailable when its only work evidence, %s, is %s",
    (field, value) => {
      const row = toRow(unpricedIdleSubscriptionItem({ [field]: value }));

      expect(row.costLabel).toBe(EMPTY_CELL);
      expect(row.costValue).toBeNull();
      expect(row.costAvailability).toBe(CostAvailability.Unavailable);
      expect(row.costTooltip).toBeNull();
    }
  );

  it("keeps an unpriced subscription row's $0.00 when a usable counter shows it worked", () => {
    const row = toRow(
      unpricedIdleSubscriptionItem({ inputTokens: "1000", outputTokens: 500 })
    );

    expect(row.costLabel).toBe("$0.00");
    expect(row.costAvailability).toBe(CostAvailability.Subscription);
  });

  it("states no tooltip when an unusable token counter decides which one applies", () => {
    const row = toRow(
      meteredItem({
        estimatedCost: 0,
        inputTokens: "1000",
        outputTokens: 0,
        toolUseCount: 2,
      })
    );

    expect(row.costLabel).toBe(EMPTY_CELL);
    expect(row.costAvailability).toBe(CostAvailability.Unavailable);
    expect(row.costTooltip).toBeNull();
  });

  it("keeps a priced metered row's figure at the stored cost ceiling", () => {
    const row = toRow(
      meteredItem({ estimatedCost: MAX_SESSION_ESTIMATED_COST_USD })
    );

    expect(row.costAvailability).toBe(CostAvailability.Available);
    expect(row.costValue).toBe(MAX_SESSION_ESTIMATED_COST_USD);
  });

  it("keeps a priced metered row's figure when every input is usable", () => {
    const row = toRow(meteredItem());

    expect(row.costLabel).toBe("$12.50");
    expect(row.costValue).toBe(12.5);
    expect(row.costAvailability).toBe(CostAvailability.Available);
  });

  it("keeps a subscription row's covered figure when every input is usable", () => {
    const row = toRow(subscriptionItem());

    expect(row.costLabel).toBe("$3.50");
    expect(row.costAvailability).toBe(CostAvailability.Subscription);
    expect(row.costTooltip).toBe("Billed through your subscription");
  });

  it("reads an omitted counter as no evidence, not as corrupt", () => {
    const row = toRow(
      meteredItem({
        cacheReadTokens: undefined,
        componentInvocationCount: undefined,
      })
    );

    expect(row.costLabel).toBe("$12.50");
    expect(row.costValue).toBe(12.5);
  });
});

function toRow(item: AgentSessionListItem) {
  return agentSessionToSessionTableRow(item, null, { now: NOW });
}

function meteredItem(overrides: Record<string, unknown> = {}) {
  return createAgentSessionListItemFixture({
    billingMode: "api",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    componentInvocationCount: 0,
    estimatedCost: 12.5,
    inputTokens: 1000,
    outputTokens: 500,
    toolUseCount: 2,
    ...overrides,
  });
}

function subscriptionItem(overrides: Record<string, unknown> = {}) {
  return meteredItem({ billingMode: "pro", estimatedCost: 3.5, ...overrides });
}

/** A subscription row with no price and no counter showing it worked. */
function unpricedIdleSubscriptionItem(overrides: Record<string, unknown> = {}) {
  return subscriptionItem({
    estimatedCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolUseCount: 0,
    turns: 0,
    ...overrides,
  });
}
