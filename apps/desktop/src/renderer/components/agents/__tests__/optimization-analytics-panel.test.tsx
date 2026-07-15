/**
 * @file optimization-analytics-panel.test.tsx
 * @description Unit tests for the desktop OptimizationAnalyticsPanel
 * (FEA-2923 / AC-022 / §E).
 *
 * Proves the previously-orphaned optimization-analytics IPC methods
 * (getComponentModelTrend / getSubagentFrequency / isSkillLoaded) now have a
 * live renderer consumer that renders their data. These tests FAIL if the
 * panel does not call the IPC or does not render the returned trend/frequency.
 */

import type {
  ComponentModelTrendResponse,
  SkillLoadedResponse,
  SubagentFrequencyResponse,
} from "@repo/api/src/types/agent-component";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OptimizationAnalyticsPanel } from "../optimization-analytics-panel";

const ACROSS_5_SESSIONS = /across 5 sessions/;

function makeTrend(): ComponentModelTrendResponse {
  return {
    componentKind: "subagent",
    componentKey: "bug-hunter",
    windowDays: 30,
    points: [
      {
        day: "2026-07-10",
        model: "claude-opus-4-5",
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 1.23,
        latencyAvgMs: 500,
        latencyMaxMs: 900,
        compactionCount: 0,
      },
    ],
  };
}

function makeFrequency(): SubagentFrequencyResponse {
  return {
    subagentKey: "bug-hunter",
    windowDays: 30,
    points: [
      { day: "2026-07-10", sessionCount: 3, invocations: 7 },
      { day: "2026-07-11", sessionCount: 2, invocations: 4 },
    ],
  };
}

function makeSkillLoaded(
  over: Partial<SkillLoadedResponse> = {}
): SkillLoadedResponse {
  return {
    skillKey: "gstack",
    existsInInventory: true,
    hasUsage: true,
    totalInvocations: 5,
    lastUsedAt: "2026-07-11T00:00:00Z",
    ...over,
  };
}

function installDesktopApi(db: Record<string, unknown>): void {
  (window as unknown as { desktopApi: unknown }).desktopApi = { db };
}

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { desktopApi?: unknown }).desktopApi = undefined;
});

describe("OptimizationAnalyticsPanel (AC-022)", () => {
  it("renders per-model token trend rows from getComponentModelTrend", async () => {
    const getComponentModelTrend = vi.fn().mockResolvedValue(makeTrend());
    installDesktopApi({
      getComponentModelTrend,
      getSubagentFrequency: vi.fn().mockResolvedValue(makeFrequency()),
    });

    render(
      <OptimizationAnalyticsPanel
        target={{ kind: "subagent", key: "bug-hunter", name: "Bug Hunter" }}
      />
    );

    await waitFor(() => expect(screen.getByTestId("trend-rows")).toBeDefined());
    expect(getComponentModelTrend).toHaveBeenCalledWith(
      "subagent",
      "bug-hunter",
      undefined,
      30
    );
    expect(screen.getByText("claude-opus-4-5")).toBeDefined();
    expect(screen.getByText("$1.23")).toBeDefined();
  });

  it("renders sub-agent pull-in frequency for a subagent target", async () => {
    const getSubagentFrequency = vi.fn().mockResolvedValue(makeFrequency());
    installDesktopApi({
      getComponentModelTrend: vi.fn().mockResolvedValue(makeTrend()),
      getSubagentFrequency,
    });

    render(
      <OptimizationAnalyticsPanel
        target={{ kind: "subagent", key: "bug-hunter", name: "Bug Hunter" }}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("subagent-frequency-card")).toBeDefined()
    );
    expect(getSubagentFrequency).toHaveBeenCalledWith("bug-hunter", 30);
    // 3 + 2 = 5 sessions total.
    expect(screen.getByText(ACROSS_5_SESSIONS)).toBeDefined();
  });

  it("renders a skill-loaded badge for a skill target", async () => {
    const isSkillLoaded = vi.fn().mockResolvedValue(makeSkillLoaded());
    installDesktopApi({
      getComponentModelTrend: vi.fn().mockResolvedValue(makeTrend()),
      isSkillLoaded,
    });

    render(
      <OptimizationAnalyticsPanel
        target={{ kind: "skill", key: "gstack", name: "GStack" }}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("skill-loaded-card")).toBeDefined()
    );
    expect(isSkillLoaded).toHaveBeenCalledWith("gstack");
    expect(screen.getByText("Skill loading")).toBeDefined();
  });

  it("flags a skill that exists but has no usage as not loading", async () => {
    installDesktopApi({
      getComponentModelTrend: vi.fn().mockResolvedValue(makeTrend()),
      isSkillLoaded: vi
        .fn()
        .mockResolvedValue(
          makeSkillLoaded({ hasUsage: false, totalInvocations: 0 })
        ),
    });

    render(
      <OptimizationAnalyticsPanel
        target={{ kind: "skill", key: "gstack", name: "GStack" }}
      />
    );

    await waitFor(() => expect(screen.getByText("Not loading")).toBeDefined());
  });

  it("shows an empty state when the trend has no points", async () => {
    installDesktopApi({
      getComponentModelTrend: vi.fn().mockResolvedValue({
        componentKind: "command",
        componentKey: "foo",
        windowDays: 30,
        points: [],
      }),
    });

    render(
      <OptimizationAnalyticsPanel
        target={{ kind: "command", key: "foo", name: "Foo" }}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("trend-empty")).toBeDefined()
    );
  });
});
