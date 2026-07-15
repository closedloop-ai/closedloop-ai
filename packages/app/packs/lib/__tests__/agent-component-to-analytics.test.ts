/**
 * @file agent-component-to-analytics.test.ts
 * @description Unit tests for mapping the canonical agent-component analytics
 * onto the PackView team-usage + performance blocks.
 */
import type { AgentComponent } from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import { agentComponentToPackAnalytics } from "../agent-component-to-analytics";

function makeComponent(over: Partial<AgentComponent> = {}): AgentComponent {
  return {
    id: "uuid-1",
    name: "code",
    kind: "plugin",
    sourceType: "pack",
    source: "closedloop-ai",
    harness: "claude",
    invocations: 1284,
    sessions: 412,
    klocPerDollar: 3.2,
    trend: [8, 10, 12, 14],
    owner: "Maya Chen",
    collaborators: ["Devon Park", "Sasha Ortiz"],
    computeTargetIds: ["ct-1", "ct-2", "ct-3"],
    firstSeenAt: "2026-07-01T00:00:00Z",
    lastSeenAt: "2026-07-08T00:00:00Z",
    ...over,
  } as AgentComponent;
}

describe("agentComponentToPackAnalytics", () => {
  it("maps performance from the canonical metrics", () => {
    const { performance } = agentComponentToPackAnalytics(makeComponent());
    expect(performance.klocPerDollar).toBe(3.2);
    expect(performance.invocations).toBe(1284);
    expect(performance.sessions).toBe(412);
    expect(performance.usageTrend).toEqual([8, 10, 12, 14]);
  });

  it("builds team usage from owner + collaborators and device adoption", () => {
    const { teamUsage } = agentComponentToPackAnalytics(makeComponent());
    expect(teamUsage.installers.map((u) => u.name)).toEqual([
      "Maya Chen",
      "Devon Park",
      "Sasha Ortiz",
    ]);
    expect(teamUsage.installers[0].initials).toBe("MC");
    expect(teamUsage.installedCount).toBe(3);
    expect(teamUsage.deviceCount).toBe(3);
  });

  it("handles an unattributed component (no owner)", () => {
    const { teamUsage } = agentComponentToPackAnalytics(
      makeComponent({ owner: null, collaborators: [] })
    );
    expect(teamUsage.installers).toEqual([]);
    expect(teamUsage.installedCount).toBe(0);
  });

  it("passes through null metrics without fabricating values", () => {
    const { performance } = agentComponentToPackAnalytics(
      makeComponent({ klocPerDollar: null, invocations: null, sessions: null })
    );
    expect(performance.klocPerDollar).toBeNull();
    expect(performance.invocations).toBeNull();
    expect(performance.sessions).toBeNull();
  });
});
