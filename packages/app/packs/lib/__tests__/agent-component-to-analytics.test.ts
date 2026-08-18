/**
 * @file agent-component-to-analytics.test.ts
 * @description Unit tests for mapping the canonical agent-component analytics
 * onto the PackView team-usage + performance blocks.
 */
import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import { agentComponentToPackAnalytics } from "../agent-component-to-analytics";

function makeComponent(
  over: Partial<AgentComponentDetail> = {}
): AgentComponentDetail {
  return {
    id: "uuid-1",
    slug: "plugin::code",
    name: "code",
    kind: "plugin",
    sourceType: "pack",
    source: "closedloop-ai",
    harness: "claude",
    invocations: 1284,
    sessions: 412,
    locPerDollar: 3.2,
    trend: [8, 10, 12, 14],
    // FEA-4098 (Slice 3): authors people-set (discoverer first, then editors).
    collaborators: ["Maya Chen", "Devon Park", "Sasha Ortiz"],
    computeTargetIds: ["ct-1", "ct-2", "ct-3"],
    firstSeenAt: "2026-07-01T00:00:00Z",
    lastSeenAt: "2026-07-08T00:00:00Z",
    // Detail-only fields.
    properties: { path: "code", format: "md" },
    prompt: null,
    versions: [],
    resolvedState: "unresolved",
    sessionsTab: [],
    sessionsTabTruncated: false,
    branchesTab: [],
    branchesTabTruncated: false,
    provenance: [],
    usageSessions: [],
    // Comparison-based delivery metrics (the detail read computes these).
    locDelta: 18,
    successRate: 74,
    successDelta: 9,
    tokenEfficiencyDelta: 12,
    efficiencyTrend: [4, 5, 6, 7],
    mergedPrs: 96,
    qualityScore: 8.1,
    qualityDelta: 5,
    ...over,
  } as AgentComponentDetail;
}

describe("agentComponentToPackAnalytics", () => {
  it("maps the canonical absolute metrics", () => {
    const { performance } = agentComponentToPackAnalytics(makeComponent());
    expect(performance.locPerDollar).toBe(3.2);
    expect(performance.invocations).toBe(1284);
    expect(performance.sessions).toBe(412);
    expect(performance.usageTrend).toEqual([8, 10, 12, 14]);
  });

  it("maps the comparison delivery metrics 1:1 (no re-aggregation)", () => {
    const { performance } = agentComponentToPackAnalytics(makeComponent());
    expect(performance.locDelta).toBe(18);
    expect(performance.successRate).toBe(74);
    expect(performance.successDelta).toBe(9);
    expect(performance.tokenEfficiencyDelta).toBe(12);
    expect(performance.efficiencyTrend).toEqual([4, 5, 6, 7]);
    expect(performance.mergedPrs).toBe(96);
    // Quality is carried through (rendered UI-side is a separate decision).
    expect(performance.qualityScore).toBe(8.1);
    expect(performance.qualityDelta).toBe(5);
  });

  it("copies efficiencyTrend into a fresh array (no shared reference)", () => {
    const source = makeComponent();
    const { performance } = agentComponentToPackAnalytics(source);
    expect(performance.efficiencyTrend).not.toBe(source.efficiencyTrend);
    expect(performance.efficiencyTrend).toEqual([...source.efficiencyTrend]);
  });

  it("builds team usage from the collaborators (authors) set and device adoption", () => {
    const { teamUsage } = agentComponentToPackAnalytics(makeComponent());
    // codex P1: the `installers` / Used By roster models who USED the pack — a
    // different set from the version AUTHORS in `collaborators`. Mapping authors
    // → installers would corrupt the adoption model (authors shown as users,
    // real users omitted, inflated installedCount), so the roster stays
    // unavailable until the separate Used By source lands (FEA-4098 Slice 4).
    expect(teamUsage.installers).toEqual([]);
    expect(teamUsage.installedCount).toBe(0);
    // Device adoption breadth is honest and still surfaced.
    expect(teamUsage.deviceCount).toBe(3);
  });

  it("keeps the installers roster empty even for a component with authors", () => {
    const { teamUsage } = agentComponentToPackAnalytics(
      makeComponent({ collaborators: ["Maya Chen"] })
    );
    expect(teamUsage.installers).toEqual([]);
    expect(teamUsage.installedCount).toBe(0);
  });

  it("passes through null metrics without fabricating values", () => {
    const { performance } = agentComponentToPackAnalytics(
      makeComponent({
        locPerDollar: null,
        invocations: null,
        sessions: null,
        locDelta: null,
        successRate: null,
        successDelta: null,
        tokenEfficiencyDelta: null,
        efficiencyTrend: [],
        mergedPrs: null,
        qualityScore: null,
        qualityDelta: null,
      })
    );
    expect(performance.locPerDollar).toBeNull();
    expect(performance.invocations).toBeNull();
    expect(performance.sessions).toBeNull();
    expect(performance.locDelta).toBeNull();
    expect(performance.successRate).toBeNull();
    expect(performance.tokenEfficiencyDelta).toBeNull();
    expect(performance.mergedPrs).toBeNull();
    expect(performance.qualityScore).toBeNull();
  });

  it("carries the merged-PR coverage flag through in both declared directions", () => {
    // ISS-6462: dropping this made the Packs tile print a capped cohort scan as
    // an exact count.
    expect(
      agentComponentToPackAnalytics(makeComponent({ mergedPrsTruncated: true }))
        .performance.mergedPrsTruncated
    ).toBe(true);
    expect(
      agentComponentToPackAnalytics(
        makeComponent({ mergedPrsTruncated: false })
      ).performance.mergedPrsTruncated
    ).toBe(false);
  });

  it("preserves an omitted merged-PR coverage flag as unknown, not false", () => {
    // A server predating the disclosure applies the same cap and cannot report
    // it, so folding the omission to `false` would re-assert the full-cohort
    // claim under version skew.
    // Built with the flag present, then removed: `makeComponent` spreads its
    // overrides, so an absent key has to be re-created explicitly to be sure the
    // omission is what the mapper sees.
    const source = makeComponent({ mergedPrsTruncated: false });
    Reflect.deleteProperty(source, "mergedPrsTruncated");

    const { performance } = agentComponentToPackAnalytics(source);

    expect(performance.mergedPrsTruncated).toBeUndefined();
    expect(performance.mergedPrsTruncated).not.toBe(false);
  });

  it("resolves a version-skewed LEGACY-only payload (old server) into canonical LOC/$", () => {
    // ISS-4667: a server that predates the rename OMITS `locPerDollar`/`locDelta`
    // and sends the KLOC-unit legacy fields. The mapper must resolve them or the
    // Performance tab renders unavailable despite valid legacy data.
    const { performance } = agentComponentToPackAnalytics(
      makeComponent({
        locPerDollar: undefined,
        locDelta: undefined,
        // 0.0032 KLOC/$ === 3.2 LOC/$; the unit-free delta carries the same number.
        klocPerDollar: 0.0032,
        klocDelta: 18,
      })
    );
    expect(performance.locPerDollar).toBeCloseTo(3.2, 10);
    expect(performance.locDelta).toBe(18);
  });
});
