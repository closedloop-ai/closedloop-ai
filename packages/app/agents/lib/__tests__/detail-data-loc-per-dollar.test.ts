/**
 * FEA-4052 — the component-detail metric grid hides the LOC/$ card for a kind
 * with no reliable per-component attribution (skill/command/plugin/mcp/tool/…)
 * and keeps it for a verifiable kind (only `subagent` today — skill/command are
 * session-level, excluded until session partitioning, wongk PR #3720). No dead
 * "—" LOC/$ card on a tab whose column is hidden.
 */
import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import { componentMetrics } from "../detail-data";

function makeDetail(
  overrides: Partial<AgentComponentDetail>
): AgentComponentDetail {
  return {
    id: "id",
    slug: "slug",
    name: "name",
    kind: AgentComponentKind.Subagent,
    invocations: 10,
    sessions: 3,
    locPerDollar: 2.5,
    branchesTab: [],
    ...overrides,
    // A partial cast is acceptable for a test fixture; componentMetrics only
    // reads the fields set above.
  } as AgentComponentDetail;
}

const hasKlocCard = (detail: AgentComponentDetail): boolean =>
  componentMetrics(detail).some((metric) => metric.key === "loc-per-dollar");

describe("componentMetrics LOC/$ gating (FEA-4052)", () => {
  it.each([
    AgentComponentKind.Subagent,
  ])("shows the LOC/$ card for verifiable kind %s", (kind) => {
    expect(hasKlocCard(makeDetail({ kind, locPerDollar: 2.5 }))).toBe(true);
  });

  it.each([
    // skill/command excluded until session partitioning (wongk, PR #3720).
    AgentComponentKind.Skill,
    AgentComponentKind.Command,
    AgentComponentKind.Plugin,
    AgentComponentKind.Mcp,
    AgentComponentKind.Tool,
    AgentComponentKind.Workflow,
    AgentComponentKind.Hook,
    AgentComponentKind.Config,
  ])("hides the LOC/$ card for non-verifiable kind %s", (kind) => {
    // The service nulls locPerDollar for these kinds; the card is dropped, not
    // rendered as a dead "—".
    expect(hasKlocCard(makeDetail({ kind, locPerDollar: null }))).toBe(false);
  });
});
