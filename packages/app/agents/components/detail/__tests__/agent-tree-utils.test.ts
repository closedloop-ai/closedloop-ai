import { describe, expect, it } from "vitest";
import {
  emptyAgentsAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
} from "../agent-session-detail-fixtures";
import {
  buildAgentTree,
  buildSessionAgents,
  flattenTree,
} from "../agent-tree-utils";

describe("agent detail tree utilities", () => {
  it("builds a canonical hierarchy with event, tool, and error counts", () => {
    const roots = buildAgentTree(
      populatedAgentSessionDetailFixture.agents,
      populatedAgentSessionDetailFixture.events
    );
    const flatNodes = flattenTree(roots);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.agent.externalAgentId).toBe("agent-main");
    expect(roots[0]?.children).toHaveLength(2);
    expect(
      flatNodes.find((node) => node.agent.externalAgentId === "agent-review")
        ?.errorCount
    ).toBe(1);
    expect(
      flatNodes.find((node) => node.agent.externalAgentId === "agent-ui")
        ?.toolInvocationCount
    ).toBe(1);
  });

  it("keeps orphaned agents visible as root nodes", () => {
    const roots = buildAgentTree(
      [
        {
          ...populatedAgentSessionDetailFixture.agents[1]!,
          parentExternalAgentId: "missing-parent",
        },
      ],
      populatedAgentSessionDetailFixture.events
    );

    expect(roots).toHaveLength(1);
    expect(roots[0]?.agent.externalAgentId).toBe("agent-review");
    expect(roots[0]?.depth).toBe(0);
  });

  it("adapts the canonical tree into session detail display agents", () => {
    const displayAgents = buildSessionAgents(
      populatedAgentSessionDetailFixture.agents,
      populatedAgentSessionDetailFixture.events
    );

    expect(displayAgents[0]).toMatchObject({
      id: "agent-main",
      type: "main",
      label: "2 events",
    });
    const rootAgent = displayAgents[0];
    expect(rootAgent).toBeDefined();
    const childAgent = rootAgent?.children?.[0];
    expect(childAgent).toMatchObject({
      id: "agent-review",
      type: "subagent",
      label: "1 events",
    });
  });

  it("handles empty agent data", () => {
    expect(
      buildAgentTree(
        emptyAgentsAgentSessionDetailFixture.agents,
        emptyAgentsAgentSessionDetailFixture.events
      )
    ).toEqual([]);
  });
});
