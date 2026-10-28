import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import {
  buildTimelineModelColors,
  buildTimelineStacks,
  getTimelineStackGroupingLabel,
  TIMELINE_STACK_GROUPINGS,
  TimelineStackGrouping,
  UNKNOWN_MODEL_LABEL,
  UNKNOWN_OWNER_LABEL,
} from "@repo/app/agents/lib/session-timeline-stacks";
import { describe, expect, it } from "vitest";

function makeBucket(overrides: Partial<ActivityBucket> = {}): ActivityBucket {
  return {
    byModel: {},
    cCache: 0,
    cIn: 0,
    cOut: 0,
    label: "",
    tl0: null,
    toolStart: 0,
    total: 0,
    ...overrides,
  };
}

describe("TimelineStackGrouping constants", () => {
  it("keys the three grouping dimensions", () => {
    expect(TimelineStackGrouping.TokenType).toBe("token-type");
    expect(TimelineStackGrouping.Model).toBe("model");
    expect(TimelineStackGrouping.Owner).toBe("owner");
  });

  it("orders and labels the grouping options for the control", () => {
    expect(TIMELINE_STACK_GROUPINGS).toEqual([
      { label: "Token Type", value: TimelineStackGrouping.TokenType },
      { label: "Model", value: TimelineStackGrouping.Model },
      { label: "Session Owner", value: TimelineStackGrouping.Owner },
    ]);
  });

  it("names the unknown-owner and unknown-model fallbacks", () => {
    expect(UNKNOWN_OWNER_LABEL).toBe("Unknown owner");
    expect(UNKNOWN_MODEL_LABEL).toBe("Unknown model");
  });
});

describe("getTimelineStackGroupingLabel", () => {
  it("returns the catalog label for each known grouping", () => {
    expect(getTimelineStackGroupingLabel(TimelineStackGrouping.TokenType)).toBe(
      "Token Type"
    );
    expect(getTimelineStackGroupingLabel(TimelineStackGrouping.Model)).toBe(
      "Model"
    );
    expect(getTimelineStackGroupingLabel(TimelineStackGrouping.Owner)).toBe(
      "Session Owner"
    );
  });

  it("falls back to 'Group' for an unrecognized grouping", () => {
    const unknownGrouping = "bogus-grouping" as TimelineStackGrouping;
    expect(getTimelineStackGroupingLabel(unknownGrouping)).toBe("Group");
  });
});

describe("buildTimelineModelColors", () => {
  it("returns an empty map for no buckets", () => {
    expect(buildTimelineModelColors([])).toEqual(new Map());
  });

  it("assigns colors by sorted model name, not first-seen order", () => {
    const buckets: ActivityBucket[] = [
      makeBucket({
        byModel: {
          zeta: { cCache: 0, cIn: 1, cOut: 0 },
          alpha: { cCache: 0, cIn: 1, cOut: 0 },
        },
      }),
      makeBucket({ byModel: { mid: { cCache: 0, cIn: 1, cOut: 0 } } }),
    ];
    const colors = buildTimelineModelColors(buckets);
    expect(Array.from(colors.entries())).toEqual([
      ["alpha", "var(--chart-1)"],
      ["mid", "var(--chart-2)"],
      ["zeta", "var(--chart-3)"],
    ]);
  });

  it("dedupes a model that appears in more than one bucket", () => {
    const buckets: ActivityBucket[] = [
      makeBucket({ byModel: { shared: { cCache: 0, cIn: 1, cOut: 0 } } }),
      makeBucket({ byModel: { shared: { cCache: 0, cIn: 2, cOut: 0 } } }),
    ];
    expect(buildTimelineModelColors(buckets).size).toBe(1);
  });

  it("wraps color slots after 5 models", () => {
    const byModel = Object.fromEntries(
      ["m0", "m1", "m2", "m3", "m4", "m5"].map((model) => [
        model,
        { cCache: 0, cIn: 1, cOut: 0 },
      ])
    );
    const colors = buildTimelineModelColors([makeBucket({ byModel })]);
    // Sorted order is m0..m5; the 6th model (index 5) wraps back to slot 1.
    expect(colors.get("m0")).toBe("var(--chart-1)");
    expect(colors.get("m4")).toBe("var(--chart-5)");
    expect(colors.get("m5")).toBe("var(--chart-1)");
  });
});

describe("buildTimelineStacks", () => {
  it("produces an empty stack for a zero-cost bucket, regardless of grouping", () => {
    const buckets = [makeBucket({ cCache: 0, cIn: 0, cOut: 0 })];
    for (const grouping of Object.values(TimelineStackGrouping)) {
      expect(
        buildTimelineStacks({
          buckets,
          grouping,
          modelColors: new Map(),
          ownerLabel: UNKNOWN_OWNER_LABEL,
        })
      ).toEqual([[]]);
    }
  });

  it("builds one entry per bucket", () => {
    const buckets = [
      makeBucket({ cIn: 1 }),
      makeBucket({ cCache: 0, cIn: 0, cOut: 0 }),
      makeBucket({ cOut: 2 }),
    ];
    const stacks = buildTimelineStacks({
      buckets,
      grouping: TimelineStackGrouping.TokenType,
      modelColors: new Map(),
      ownerLabel: UNKNOWN_OWNER_LABEL,
    });
    expect(stacks).toHaveLength(3);
    expect(stacks[1]).toEqual([]);
  });

  it("splits a token-type bucket into cache/output/input segments, in that order", () => {
    const bucket = makeBucket({ cCache: 2, cIn: 5, cOut: 3 });
    const [segments] = buildTimelineStacks({
      buckets: [bucket],
      grouping: TimelineStackGrouping.TokenType,
      modelColors: new Map(),
      ownerLabel: UNKNOWN_OWNER_LABEL,
    });
    expect(segments).toEqual([
      { colorVar: "var(--chart-3)", key: "cache", label: "Cache", value: 2 },
      { colorVar: "var(--chart-2)", key: "output", label: "Output", value: 3 },
      { colorVar: "var(--chart-1)", key: "input", label: "Input", value: 5 },
    ]);
  });

  it("drops a token-type segment whose value is zero", () => {
    const bucket = makeBucket({ cCache: 3, cIn: 5, cOut: 0 });
    const [segments] = buildTimelineStacks({
      buckets: [bucket],
      grouping: TimelineStackGrouping.TokenType,
      modelColors: new Map(),
      ownerLabel: UNKNOWN_OWNER_LABEL,
    });
    expect(segments.map((segment) => segment.key)).toEqual(["cache", "input"]);
  });

  it("splits a model bucket into per-model segments, sorted by model name", () => {
    const bucket = makeBucket({
      byModel: {
        "gpt-4": { cCache: 5, cIn: 0, cOut: 0 },
        "claude-3": { cCache: 0, cIn: 1, cOut: 2 },
      },
      cCache: 5,
      cIn: 1,
      cOut: 2,
    });
    const modelColors = buildTimelineModelColors([bucket]);
    const [segments] = buildTimelineStacks({
      buckets: [bucket],
      grouping: TimelineStackGrouping.Model,
      modelColors,
      ownerLabel: UNKNOWN_OWNER_LABEL,
    });
    expect(segments).toEqual([
      {
        colorVar: modelColors.get("claude-3"),
        key: "claude-3",
        label: "claude-3",
        value: 3,
      },
      {
        colorVar: modelColors.get("gpt-4"),
        key: "gpt-4",
        label: "gpt-4",
        value: 5,
      },
    ]);
  });

  it("falls back to the fallback color for a model missing from the color map", () => {
    const bucket = makeBucket({
      byModel: { "unmapped-model": { cCache: 0, cIn: 1, cOut: 0 } },
      cIn: 1,
    });
    const [segments] = buildTimelineStacks({
      buckets: [bucket],
      grouping: TimelineStackGrouping.Model,
      modelColors: new Map(),
      ownerLabel: UNKNOWN_OWNER_LABEL,
    });
    expect(segments).toEqual([
      {
        colorVar: "var(--chart-1)",
        key: "unmapped-model",
        label: "unmapped-model",
        value: 1,
      },
    ]);
  });

  it("drops a per-model segment whose value is zero", () => {
    const bucket = makeBucket({
      byModel: {
        counted: { cCache: 0, cIn: 4, cOut: 0 },
        empty: { cCache: 0, cIn: 0, cOut: 0 },
      },
      cIn: 4,
    });
    const [segments] = buildTimelineStacks({
      buckets: [bucket],
      grouping: TimelineStackGrouping.Model,
      modelColors: new Map(),
      ownerLabel: UNKNOWN_OWNER_LABEL,
    });
    expect(segments.map((segment) => segment.key)).toEqual(["counted"]);
  });

  it("collapses an owner-grouped bucket into a single labeled segment", () => {
    const bucket = makeBucket({ cCache: 1, cIn: 2, cOut: 3 });
    const [segments] = buildTimelineStacks({
      buckets: [bucket],
      grouping: TimelineStackGrouping.Owner,
      modelColors: new Map(),
      ownerLabel: "Alice",
    });
    expect(segments).toEqual([
      { colorVar: "var(--chart-1)", key: "owner", label: "Alice", value: 6 },
    ]);
  });
});
