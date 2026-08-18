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
const RE_THIS_VERSION = /This version · #aaaaaaaa/;
const RE_ALL_VERSIONS = /All versions of this component/;
const RE_NO_USAGE_VERSION = /No usage for this version/;
const RE_NO_USAGE_VERSION_WINDOW =
  /No usage for this version in the last 30 days/;

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

// ISS-4403: content-scoped reads + version-honest UI.
describe("OptimizationAnalyticsPanel content scope (ISS-4403)", () => {
  const FINGERPRINT = "a".repeat(64);
  const SHORT = "aaaaaaaa";

  it("does NOT append a trailing fingerprint arg when unscoped (legacy arity)", async () => {
    // The historical call shapes: an older preload forwards a trailing explicit
    // `undefined` as an extra IPC argument, so an unscoped target must use the
    // pre-ISS-4403 arity — 4 / 2 / 1 args — with NO trailing undefined.
    const getComponentModelTrend = vi.fn().mockResolvedValue(makeTrend());
    const getSubagentFrequency = vi.fn().mockResolvedValue(makeFrequency());
    const isSkillLoaded = vi.fn().mockResolvedValue(makeSkillLoaded());
    installDesktopApi({
      getComponentModelTrend,
      getSubagentFrequency,
      isSkillLoaded,
    });

    render(
      <OptimizationAnalyticsPanel
        target={{ kind: "subagent", key: "bug-hunter", name: "Bug Hunter" }}
      />
    );

    await waitFor(() => expect(getComponentModelTrend).toHaveBeenCalled());
    expect(getComponentModelTrend.mock.calls[0]).toEqual([
      "subagent",
      "bug-hunter",
      undefined,
      30,
    ]);
    expect(getSubagentFrequency.mock.calls[0]).toEqual(["bug-hunter", 30]);
  });

  it("appends the fingerprint as the trailing content-scope arg when scoped", async () => {
    const getComponentModelTrend = vi.fn().mockResolvedValue(makeTrend());
    const getSubagentFrequency = vi.fn().mockResolvedValue(makeFrequency());
    installDesktopApi({ getComponentModelTrend, getSubagentFrequency });

    render(
      <OptimizationAnalyticsPanel
        target={{
          kind: "subagent",
          key: "bug-hunter",
          name: "Bug Hunter",
          fingerprint: FINGERPRINT,
          shortFingerprint: SHORT,
        }}
      />
    );

    await waitFor(() => expect(getComponentModelTrend).toHaveBeenCalled());
    expect(getComponentModelTrend.mock.calls[0]).toEqual([
      "subagent",
      "bug-hunter",
      undefined,
      30,
      FINGERPRINT,
    ]);
    expect(getSubagentFrequency.mock.calls[0]).toEqual([
      "bug-hunter",
      30,
      FINGERPRINT,
    ]);
  });

  it("scopes isSkillLoaded by fingerprint when scoped", async () => {
    const isSkillLoaded = vi.fn().mockResolvedValue(makeSkillLoaded());
    installDesktopApi({
      getComponentModelTrend: vi.fn().mockResolvedValue(makeTrend()),
      isSkillLoaded,
    });

    render(
      <OptimizationAnalyticsPanel
        target={{
          kind: "skill",
          key: "gstack",
          name: "GStack",
          fingerprint: FINGERPRINT,
          shortFingerprint: SHORT,
        }}
      />
    );

    await waitFor(() => expect(isSkillLoaded).toHaveBeenCalled());
    expect(isSkillLoaded.mock.calls[0]).toEqual(["gstack", FINGERPRINT]);
  });

  it("shows a version subhead with the short fingerprint when scoped", () => {
    installDesktopApi({
      getComponentModelTrend: vi.fn().mockResolvedValue(makeTrend()),
    });

    render(
      <OptimizationAnalyticsPanel
        target={{
          kind: "command",
          key: "foo",
          name: "Foo",
          fingerprint: FINGERPRINT,
          shortFingerprint: SHORT,
        }}
      />
    );

    expect(screen.getByText(RE_THIS_VERSION)).toBeDefined();
  });

  it("shows an all-versions subhead when unscoped (name-level)", () => {
    installDesktopApi({
      getComponentModelTrend: vi.fn().mockResolvedValue(makeTrend()),
    });

    render(
      <OptimizationAnalyticsPanel
        target={{ kind: "command", key: "foo", name: "Foo" }}
      />
    );

    expect(screen.getByText(RE_ALL_VERSIONS)).toBeDefined();
  });

  it("uses neutral (not warning) skill copy for a version with no usage", async () => {
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
        target={{
          kind: "skill",
          key: "gstack",
          name: "GStack",
          fingerprint: FINGERPRINT,
          shortFingerprint: SHORT,
        }}
      />
    );

    // Neutral, scope-honest copy — never the name-level "Not loading" alarm.
    await waitFor(() =>
      expect(screen.getByText(RE_NO_USAGE_VERSION)).toBeDefined()
    );
    expect(screen.queryByText("Not loading")).toBeNull();
  });

  it("carries the version scope in the trend empty state", async () => {
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
        target={{
          kind: "command",
          key: "foo",
          name: "Foo",
          fingerprint: FINGERPRINT,
          shortFingerprint: SHORT,
        }}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("trend-empty").textContent).toMatch(
        RE_NO_USAGE_VERSION_WINDOW
      )
    );
  });
});
