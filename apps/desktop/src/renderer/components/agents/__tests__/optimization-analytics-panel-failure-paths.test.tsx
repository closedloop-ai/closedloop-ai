/**
 * ISS-10903: the FAILURE and edge arms of the desktop optimization-analytics
 * panel. The sibling `optimization-analytics-panel.test.tsx` owns the happy
 * paths and the ISS-4403 content-scope arity; this file owns what happens when
 * a read does not resolve, when there is no bridge to read through, and the
 * per-card branches the happy-path file does not reach.
 *
 * Each of the three cards keeps its OWN phase, so a failure in one must not
 * blank the others — that independence is the point of the error cases below,
 * and each asserts the surviving sibling card as well as the failed one.
 *
 * The panel degrades differently per card by design: the trend and frequency
 * cards say they could not load, while the skill badge withdraws entirely
 * rather than render a variant it cannot justify. That asymmetry is pinned
 * here, not smoothed over.
 */

import type {
  ComponentModelTrendPoint,
  ComponentModelTrendResponse,
  SkillLoadedResponse,
  SubagentFrequencyPoint,
  SubagentFrequencyResponse,
} from "@repo/api/src/types/agent-component";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OptimizationAnalyticsPanel,
  type OptimizationTarget,
} from "../optimization-analytics-panel";

const TREND_DAYS = 30;
const FINGERPRINT = "b".repeat(64);
const ONE_INVOCATION_RE = /\b1 invocation\b/;
const ONE_SESSION_RE = /Invoked across 1 session in the last 30 days\./;

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  cleanup();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

describe("OptimizationAnalyticsPanel — a read that does not resolve", () => {
  it("says the trend could not load instead of rendering an empty trend", async () => {
    installDb({ trend: rejected() });
    await mount(target());

    expect(screen.getByTestId("trend-error")).toBeTruthy();
    // An empty state would claim the component was never used — a different,
    // false fact from "the read failed".
    expect(screen.queryByTestId("trend-empty")).toBeNull();
    expect(screen.queryByTestId("trend-rows")).toBeNull();
  });

  it("says the frequency could not load instead of reporting zero sessions", async () => {
    installDb({ frequency: rejected() });
    await mount(target({ kind: "subagent" }));

    expect(screen.getByTestId("frequency-error")).toBeTruthy();
    expect(screen.queryByTestId("subagent-frequency-card")).toBeNull();
    // The trend card keeps its own phase and still renders.
    expect(screen.getByTestId("model-trend-card")).toBeTruthy();
  });

  it("withdraws the skill badge entirely when its read fails", async () => {
    installDb({ skill: rejected() });
    await mount(target({ kind: "skill" }));

    // No badge at all, rather than a variant the panel cannot justify.
    expect(screen.queryByTestId("skill-loaded-card")).toBeNull();
    expect(screen.queryByText("Not loading")).toBeNull();
    expect(screen.queryByText("Skill loading")).toBeNull();
    expect(screen.getByTestId("model-trend-card")).toBeTruthy();
  });

  it("leaves every card on its skeleton when there is no db bridge", async () => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {},
    });
    await mount(target({ kind: "subagent" }));

    // Nothing settled, so nothing may claim a failure it never observed.
    expect(screen.getByTestId("trend-loading")).toBeTruthy();
    expect(screen.getByTestId("frequency-loading")).toBeTruthy();
    expect(screen.queryByTestId("trend-error")).toBeNull();
    expect(screen.queryByTestId("frequency-error")).toBeNull();
  });

  it("leaves the skill badge on its skeleton when there is no db bridge", async () => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {},
    });
    await mount(target({ kind: "skill" }));

    expect(screen.getByTestId("skill-loaded-loading")).toBeTruthy();
  });
});

describe("OptimizationAnalyticsPanel — re-reading when the scope moves", () => {
  it("re-reads the trend when the routed version changes", async () => {
    const db = installDb();
    const view = await mount(target({ key: "build" }));
    expect(db.getComponentModelTrend).toHaveBeenCalledTimes(1);

    await view.rerender(target({ key: "build", fingerprint: FINGERPRINT }));

    expect(db.getComponentModelTrend).toHaveBeenCalledTimes(2);
    expect(db.getComponentModelTrend).toHaveBeenLastCalledWith(
      "command",
      "build",
      undefined,
      TREND_DAYS,
      FINGERPRINT
    );
  });

  it("does not re-read when an unrelated prop changes", async () => {
    const db = installDb();
    const view = await mount(target({ key: "build", name: "Build" }));

    await view.rerender(target({ key: "build", name: "Build (renamed)" }));

    expect(db.getComponentModelTrend).toHaveBeenCalledTimes(1);
  });
});

describe("OptimizationAnalyticsPanel — counting and cost honesty", () => {
  it("dashes a cost it could not estimate rather than printing a zero", async () => {
    installDb({
      trend: trendResponse([trendPoint({ estimatedCostUsd: null })]),
    });
    await mount(target());

    expect(screen.getByText("—")).toBeTruthy();
    // A fabricated $0.00 would read as a real, measured cost of nothing.
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("uses the singular for exactly one session", async () => {
    installDb({
      frequency: frequencyResponse([frequencyPoint(1)]),
    });
    await mount(target({ kind: "subagent" }));

    expect(screen.getByText(ONE_SESSION_RE)).toBeTruthy();
  });

  it("uses the singular for exactly one invocation", async () => {
    installDb({
      skill: skillResponse({ totalInvocations: 1 }),
    });
    await mount(target({ kind: "skill" }));

    expect(screen.getByText(ONE_INVOCATION_RE)).toBeTruthy();
  });
});

describe("OptimizationAnalyticsPanel — the skill badge's third arm", () => {
  it("alarms for a skill missing from the inventory even with usage recorded", async () => {
    installDb({
      skill: skillResponse({ existsInInventory: false, totalInvocations: 2 }),
    });
    await mount(target({ kind: "skill" }));

    // Loaded requires BOTH facts; usage alone does not earn the success badge.
    expect(screen.getByText("Not loading")).toBeTruthy();
    expect(screen.queryByText("Skill loading")).toBeNull();
  });

  it("stays neutral for a version-scoped skill missing from the inventory", async () => {
    installDb({
      skill: skillResponse({ existsInInventory: false, hasUsage: false }),
    });
    await mount(target({ kind: "skill", fingerprint: FINGERPRINT }));

    expect(screen.getByText("No usage for this version")).toBeTruthy();
    expect(screen.queryByText("Not loading")).toBeNull();
  });
});

describe("OptimizationAnalyticsPanel — which cards a kind gets", () => {
  it("gives a plain kind the trend alone", async () => {
    installDb();
    await mount(target({ kind: "command" }));

    expect(screen.getByTestId("model-trend-card")).toBeTruthy();
    expect(screen.queryByTestId("skill-loaded-card")).toBeNull();
    expect(screen.queryByTestId("subagent-frequency-card")).toBeNull();
  });

  it("never gives a skill the pull-in frequency card", async () => {
    installDb();
    await mount(target({ kind: "skill" }));

    expect(screen.getByTestId("skill-loaded-card")).toBeTruthy();
    expect(screen.queryByTestId("subagent-frequency-card")).toBeNull();
  });

  it("never gives a subagent the skill badge", async () => {
    installDb();
    await mount(target({ kind: "subagent" }));

    expect(screen.getByTestId("subagent-frequency-card")).toBeTruthy();
    expect(screen.queryByTestId("skill-loaded-card")).toBeNull();
  });
});

function trendResponse(
  points: ComponentModelTrendPoint[] = []
): ComponentModelTrendResponse {
  return {
    componentKind: "command",
    componentKey: "build",
    windowDays: TREND_DAYS,
    points,
  };
}

function trendPoint(
  overrides: Partial<ComponentModelTrendPoint> = {}
): ComponentModelTrendPoint {
  return {
    day: "2026-09-02",
    model: "haiku",
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 1.5,
    latencyAvgMs: null,
    latencyMaxMs: null,
    compactionCount: 0,
    ...overrides,
  };
}

function frequencyResponse(
  points: SubagentFrequencyPoint[] = []
): SubagentFrequencyResponse {
  return { subagentKey: "reviewer", windowDays: TREND_DAYS, points };
}

function frequencyPoint(sessionCount: number): SubagentFrequencyPoint {
  return { day: "2026-09-02", sessionCount, invocations: sessionCount };
}

function skillResponse(
  overrides: Partial<SkillLoadedResponse> = {}
): SkillLoadedResponse {
  return {
    skillKey: "docs",
    existsInInventory: true,
    hasUsage: true,
    totalInvocations: 0,
    lastUsedAt: null,
    ...overrides,
  };
}

function target(
  overrides: Partial<OptimizationTarget> = {}
): OptimizationTarget {
  return {
    kind: "command",
    key: "build",
    name: "Build",
    ...overrides,
  };
}

function rejected(): Promise<never> {
  const promise = Promise.reject(new Error("db closed"));
  // Claimed immediately so the rejection is never unhandled before the card's
  // own `.catch` attaches.
  promise.catch(() => undefined);
  return promise;
}

type DbOverrides = {
  trend?: unknown;
  frequency?: unknown;
  skill?: unknown;
};

function installDb(overrides: DbOverrides = {}) {
  const db = {
    getComponentModelTrend: vi.fn(() =>
      resolveOr(overrides.trend, trendResponse())
    ),
    getSubagentFrequency: vi.fn(() =>
      resolveOr(overrides.frequency, frequencyResponse())
    ),
    isSkillLoaded: vi.fn(() => resolveOr(overrides.skill, skillResponse())),
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { db },
  });
  return db;
}

function resolveOr(override: unknown, fallback: unknown): Promise<unknown> {
  if (override === undefined) {
    return Promise.resolve(fallback);
  }
  if (override instanceof Promise) {
    return override;
  }
  return Promise.resolve(override);
}

async function mount(initial: OptimizationTarget) {
  const utils = render(<OptimizationAnalyticsPanel target={initial} />);
  await act(async () => {
    await Promise.resolve();
  });
  return {
    async rerender(next: OptimizationTarget) {
      await act(async () => {
        utils.rerender(<OptimizationAnalyticsPanel target={next} />);
        await Promise.resolve();
      });
    },
  };
}
