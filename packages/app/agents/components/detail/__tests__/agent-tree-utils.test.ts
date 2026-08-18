import { describe, expect, it } from "vitest";
import {
  emptyAgentsAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
} from "../agent-session-detail-fixtures";
import {
  buildAgentTree,
  buildSessionAgents,
  flattenTree,
  getStatusBorderColor,
  getStatusColor,
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

  it("populates a subagent's componentSlug and leaves the main agent null (FEA-4258)", () => {
    const displayAgents = buildSessionAgents(
      populatedAgentSessionDetailFixture.agents,
      populatedAgentSessionDetailFixture.events
    );
    const main = displayAgents[0];
    // The main agent is the session itself, not a reusable component → non-link.
    expect(main?.componentSlug).toBeNull();
    // Subagents carry the org-level `subagent::<key>` identity from subagentType.
    const review = main?.children?.find((a) => a.id === "agent-review");
    const ui = main?.children?.find((a) => a.id === "agent-ui");
    expect(review?.componentSlug).toBe("subagent::review");
    expect(ui?.componentSlug).toBe("subagent::visual");
  });

  it("degrades a keyless subagent to a null componentSlug (FEA-4258)", () => {
    const [mainAgent, reviewAgent] = populatedAgentSessionDetailFixture.agents;
    const displayAgents = buildSessionAgents(
      [
        mainAgent!,
        {
          ...reviewAgent!,
          externalAgentId: "agent-keyless",
          parentExternalAgentId: mainAgent!.externalAgentId,
          name: "",
          subagentType: null,
        },
      ],
      []
    );
    const keyless = displayAgents[0]?.children?.find(
      (a) => a.id === "agent-keyless"
    );
    expect(keyless?.type).toBe("subagent");
    expect(keyless?.componentSlug).toBeNull();
  });

  it("guards against negative durations from out-of-order timestamps", () => {
    const [mainAgent] = populatedAgentSessionDetailFixture.agents;
    const roots = buildAgentTree(
      [
        {
          ...mainAgent!,
          // endedAt precedes startedAt (clock skew / out-of-order sync).
          startedAt: "2026-06-10T12:20:00.000Z",
          endedAt: "2026-06-10T12:00:00.000Z",
        },
      ],
      []
    );

    expect(roots[0]?.durationMs).toBeNull();
  });

  it("returns null for unparseable timestamps (NaN guard)", () => {
    const [mainAgent] = populatedAgentSessionDetailFixture.agents;
    const roots = buildAgentTree(
      [
        {
          ...mainAgent!,
          startedAt: "not-a-date",
          endedAt: "2026-06-10T12:20:00.000Z",
        },
      ],
      []
    );

    expect(roots[0]?.durationMs).toBeNull();
  });

  it("still computes valid non-negative durations", () => {
    const [mainAgent] = populatedAgentSessionDetailFixture.agents;
    const roots = buildAgentTree(
      [
        {
          ...mainAgent!,
          startedAt: "2026-06-10T12:00:00.000Z",
          endedAt: "2026-06-10T12:20:00.000Z",
        },
      ],
      []
    );

    expect(roots[0]?.durationMs).toBe(20 * 60 * 1000);
  });

  it("classifies success/done/complete status variants as successful", () => {
    const baseAgent = populatedAgentSessionDetailFixture.agents[0]!;
    const roots = buildAgentTree(
      [
        { ...baseAgent, externalAgentId: "agent-success", status: "success" },
        { ...baseAgent, externalAgentId: "agent-done", status: "done" },
        {
          ...baseAgent,
          externalAgentId: "agent-completed",
          status: "COMPLETED",
        },
      ],
      []
    );
    const flatNodes = flattenTree(roots);

    for (const id of ["agent-success", "agent-done", "agent-completed"]) {
      const node = flatNodes.find((n) => n.agent.externalAgentId === id);
      expect(node?.isSuccess).toBe(true);
      expect(node?.isFailed).toBe(false);
    }
  });

  it("classifies error/fail status variants as failed", () => {
    const baseAgent = populatedAgentSessionDetailFixture.agents[0]!;
    const roots = buildAgentTree(
      [
        { ...baseAgent, externalAgentId: "agent-fail", status: "failed" },
        { ...baseAgent, externalAgentId: "agent-error", status: "errored" },
      ],
      []
    );
    const flatNodes = flattenTree(roots);

    for (const id of ["agent-fail", "agent-error"]) {
      const node = flatNodes.find((n) => n.agent.externalAgentId === id);
      expect(node?.isFailed).toBe(true);
      expect(node?.isSuccess).toBe(false);
    }
  });

  it("colors success/done/complete status variants with the success class", () => {
    for (const status of ["success", "done", "complete", "COMPLETED"]) {
      expect(getStatusColor(status)).toBe("bg-emerald-500");
      expect(getStatusBorderColor(status)).toBe("border-emerald-500");
    }
  });

  it("colors error/fail status variants with the failed class", () => {
    for (const status of ["failed", "errored"]) {
      expect(getStatusColor(status)).toBe("bg-red-500");
      expect(getStatusBorderColor(status)).toBe("border-red-500");
    }
  });

  it("keeps running and awaiting status colors unchanged", () => {
    expect(getStatusColor("running")).toBe("bg-blue-500");
    expect(getStatusColor("awaiting_input")).toBe("bg-purple-500");
    expect(getStatusColor("unknown")).toBe("bg-gray-400");
    expect(getStatusBorderColor("running")).toBe("border-blue-500");
    expect(getStatusBorderColor("unknown")).toBe("border-gray-400");
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
