import type {
  AgentSessionDetail,
  AgentSessionListItem,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { getBucketCost } from "../../components/detail/activity-bucket-rendering";
import { buildActivityBuckets } from "../../components/detail/activity-bucket-synthesis";
import { createAgentSessionDetailFixture } from "../../components/detail/agent-session-detail-fixtures";
import { hasSynthesizedBucketCosts } from "../../components/detail/session-timeline-bar-labels";
import { createAgentSessionListItemFixture } from "../../components/sessions/session-list-fixtures";
import {
  deriveCostAvailability,
  deriveSessionCostLabel,
} from "../cost-availability";
import { agentSessionToSessionTableRow } from "../session-table-row";

/**
 * ISS-12260: the cloud read now serves `estimatedCost: null` for a never-priced
 * session instead of `0`. Every Cost reader must land `null` on the state it
 * already rendered for the `0` older producers still send, so the change is on
 * the wire and not on screen.
 */

const NOW = new Date("2026-06-17T12:00:00.000Z");

const TIMED_WINDOW = {
  startMs: Date.parse("2026-06-10T12:00:00.000Z"),
  endMs: Date.parse("2026-06-10T12:20:00.000Z"),
};

const SHAPES: [string, Record<string, unknown>][] = [
  [
    "a metered session that consumed tokens",
    { billingMode: "api", inputTokens: 1000, outputTokens: 500, turns: 2 },
  ],
  [
    "a metered session with turns and no tokens",
    { billingMode: "api", inputTokens: 0, outputTokens: 0, turns: 2 },
  ],
  [
    "an idle session",
    { billingMode: "api", inputTokens: 0, outputTokens: 0, turns: 0 },
  ],
  [
    "a subscription session that worked",
    { billingMode: "pro", inputTokens: 1000, outputTokens: 500, turns: 2 },
  ],
];

describe("a null estimatedCost reads as the zero it replaced (ISS-12260)", () => {
  it.each(SHAPES)("Sessions table Cost cell: %s", (_label, shape) => {
    const { zero, unpriced } = itemPair(shape);
    const pick = (item: AgentSessionListItem) => {
      const row = agentSessionToSessionTableRow(item, null, { now: NOW });
      return [
        row.costAvailability,
        row.costLabel,
        row.costTooltip,
        row.costValue,
      ];
    };

    expect(pick(unpriced)).toEqual(pick(zero));
  });

  it.each(SHAPES)("detail Cost availability and label: %s", (_label, shape) => {
    const { zero, unpriced } = itemPair(shape);

    expect(deriveCostAvailability(unpriced)).toBe(deriveCostAvailability(zero));
    expect(deriveSessionCostLabel(unpriced)).toBe(deriveSessionCostLabel(zero));
  });
});

describe("a null estimatedCost on the synthesized activity strip (ISS-12260)", () => {
  it.each([
    ["timed", TIMED_WINDOW],
    ["even-bucket", null],
  ] as const)(
    "prices the %s strip like a zero-cost session",
    (_path, window) => {
      const zero = detailWithZeroCost(window !== null);
      const unpriced = { ...zero, estimatedCost: null };

      const costs = (session: AgentSessionDetail) =>
        buildActivityBuckets(session, [], window).buckets.map(getBucketCost);
      const unpricedCosts = costs(unpriced);

      expect(unpricedCosts.length).toBeGreaterThan(0);
      expect(unpricedCosts.every(Number.isFinite)).toBe(true);
      expect(unpricedCosts).toEqual(costs(zero));
      expect(hasSynthesizedBucketCosts(unpriced)).toBe(true);
    }
  );
});

function detailWithZeroCost(timed: boolean): AgentSessionDetail {
  const at = "2026-06-10T12:01:00.000Z";
  const untimedRow = {
    _row: 0,
    actor: {
      color: "var(--primary)",
      harness: "codex",
      human: null,
      name: "gpt-5.5",
      sessionId: "session-detail-1",
    },
    cats: { tool: 1 },
    cum: 0,
    failN: 0,
    hasFail: false,
    items: [{ detail: "call", err: false, label: "rg" }],
    summary: "Ran 1 tool",
    type: "tools" as const,
  };
  // An untimed row is not a valid `TurnItem` by type, but it is the shape that
  // sends `buildActivityBuckets` down its even-bucket path.
  const row: TurnItem = timed
    ? {
        ...untimedRow,
        t: at,
        tMs: Date.parse(at),
        endMs: Date.parse(at) + 1000,
      }
    : (untimedRow as unknown as TurnItem);
  return createAgentSessionDetailFixture({
    activityBuckets: [],
    endedAt: new Date(TIMED_WINDOW.endMs),
    estimatedCost: 0,
    markers: [],
    startedAt: new Date(TIMED_WINDOW.startMs),
    turnItems: [row],
  });
}

function itemPair(shape: Record<string, unknown>) {
  const zero = createAgentSessionListItemFixture({
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    componentInvocationCount: 0,
    toolUseCount: 0,
    ...shape,
    estimatedCost: 0,
  });
  return { zero, unpriced: { ...zero, estimatedCost: null } };
}
