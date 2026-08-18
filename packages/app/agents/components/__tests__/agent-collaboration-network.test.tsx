import type { WorkflowEffectivenessItem } from "@repo/app/agents/lib/session-types";
import { render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCollaborationNetwork } from "../agent-collaboration-network";

// FEA-4136 (FEA-3537 pipeline): AgentCollaborationNetwork ships unconditionally
// on the insights dashboard and its only real logic lives in the inline Graph
// row-callbacks it hands down: `getLinkRows` computes share-of-source/target %,
// and `getNodeRows` computes per-node success rate. Each has a divide-by-zero /
// missing-node "—" guard that was never asserted.
//
// The Graph primitive itself is a d3 + ResizeObserver canvas that does not
// render usefully in jsdom, and its tooltip callbacks only fire on real pointer
// hover. So we mock Graph to a thin capture: it records the `getLinkRows` /
// `getNodeRows` props the component passed, plus the `nodes`/`links` the
// component derived from `data`/`edges`. The test then invokes those real
// callbacks with the derived graph nodes (exactly what the primitive passes at
// hover time) and asserts the emitted TooltipRow values for BOTH the populated
// arithmetic branch AND the "—" guard branch. This exercises the production
// callbacks, not a reimplementation.

// `captured` and the `vi.mock` below are module-level test infrastructure the
// mock closure references, so they stay at the top; the pure types and helpers
// that only the suite uses live at the bottom of the file per the package
// declaration-ordering convention (packages/app/AGENTS.md). `ForwardedGraphProps`
// is declared at the bottom but referenced here via hoisting.
let captured: ForwardedGraphProps | null = null;

vi.mock("@repo/design-system/components/ui/primitives/graph", () => ({
  Graph: (props: ForwardedGraphProps) => {
    captured = {
      nodes: props.nodes,
      links: props.links,
      getLinkRows: props.getLinkRows,
      getNodeRows: props.getNodeRows,
    };
    return null;
  },
}));

afterEach(() => {
  captured = null;
  vi.clearAllMocks();
});

describe("AgentCollaborationNetwork tooltip callbacks", () => {
  it("passes derived nodes and links through to Graph", () => {
    const graph = renderNetwork({
      data: [
        makeItem({ subagentType: "planner", total: 10 }),
        makeItem({ subagentType: "coder", total: 4 }),
      ],
      edges: [{ source: "planner", target: "coder", weight: 2 }],
    });

    expect(graph.nodes).toEqual([
      { id: "planner", label: "planner", value: 10 },
      { id: "coder", label: "coder", value: 4 },
    ]);
    expect(graph.links).toEqual([
      { source: "planner", target: "coder", weight: 2, label: "2x" },
    ]);
  });

  describe("getLinkRows share-of-source/target arithmetic", () => {
    it("computes both shares when source and target volumes are positive", () => {
      const graph = renderNetwork({
        data: [
          makeItem({ subagentType: "planner", total: 10 }),
          makeItem({ subagentType: "coder", total: 4 }),
        ],
        edges: [{ source: "planner", target: "coder", weight: 2 }],
      });

      const source = { id: "planner", label: "planner", value: 10 };
      const target = { id: "coder", label: "coder", value: 4 };
      const rows = graph.getLinkRows(
        { source: "planner", target: "coder", weight: 2 },
        source,
        target
      );

      expect(findRow(rows, "Sequential pairs")?.value).toBe("2x");
      // 2 / 10 * 100 = 20.0%
      expect(findRow(rows, "Share of planner")?.value).toBe("20.0%");
      // 2 / 4 * 100 = 50.0%
      expect(findRow(rows, "Share of coder")?.value).toBe("50.0%");
    });

    it("emits the em dash guard when the source volume is zero", () => {
      const graph = renderNetwork({
        data: [
          makeItem({ subagentType: "planner", total: 0 }),
          makeItem({ subagentType: "coder", total: 4 }),
        ],
        edges: [{ source: "planner", target: "coder", weight: 2 }],
      });

      const source = { id: "planner", label: "planner", value: 0 };
      const target = { id: "coder", label: "coder", value: 4 };
      const rows = graph.getLinkRows(
        { source: "planner", target: "coder", weight: 2 },
        source,
        target
      );

      // Divide-by-zero guard on the source side -> "—", target still computes.
      expect(findRow(rows, "Share of planner")?.value).toBe("—");
      expect(findRow(rows, "Share of coder")?.value).toBe("50.0%");
    });

    it("emits the em dash guard when the target volume is zero", () => {
      const graph = renderNetwork({
        data: [
          makeItem({ subagentType: "planner", total: 10 }),
          makeItem({ subagentType: "coder", total: 0 }),
        ],
        edges: [{ source: "planner", target: "coder", weight: 2 }],
      });

      const source = { id: "planner", label: "planner", value: 10 };
      const target = { id: "coder", label: "coder", value: 0 };
      const rows = graph.getLinkRows(
        { source: "planner", target: "coder", weight: 2 },
        source,
        target
      );

      // Divide-by-zero guard on the target side -> "—", source still computes.
      expect(findRow(rows, "Share of planner")?.value).toBe("20.0%");
      expect(findRow(rows, "Share of coder")?.value).toBe("—");
    });
  });

  describe("getNodeRows success-rate + missing-node fallback", () => {
    it("formats runs, sessions, and rounded success rate for a matched node", () => {
      const graph = renderNetwork({
        data: [
          makeItem({
            subagentType: "planner",
            total: 1234,
            sessions: 42,
            successRate: 87.6,
          }),
        ],
        edges: [],
      });

      const rows = graph.getNodeRows({
        id: "planner",
        label: "planner",
        value: 1234,
      });

      // node.value.toLocaleString() -> grouped digits.
      expect(findRow(rows, "Runs")?.value).toBe((1234).toLocaleString());
      expect(findRow(rows, "Sessions")?.value).toBe((42).toLocaleString());
      // successRate.toFixed(0) rounds 87.6 -> "88%".
      expect(findRow(rows, "Success rate")?.value).toBe("88%");
    });

    it("falls back to em dash success rate and zero sessions for a missing node", () => {
      const graph = renderNetwork({
        data: [makeItem({ subagentType: "planner", total: 10, sessions: 5 })],
        edges: [],
      });

      // A node id with no matching data entry (data.find returns undefined).
      const rows = graph.getNodeRows({
        id: "ghost",
        label: "ghost",
        value: 3,
      });

      expect(findRow(rows, "Runs")?.value).toBe((3).toLocaleString());
      // item?.sessions ?? 0 -> "0"
      expect(findRow(rows, "Sessions")?.value).toBe((0).toLocaleString());
      // item ? ... : "—"
      expect(findRow(rows, "Success rate")?.value).toBe("—");
    });
  });
});

type NetworkProps = ComponentProps<typeof AgentCollaborationNetwork>;

type GraphNode = { id: string; label?: string; value: number };
type GraphLink = {
  source: string;
  target: string;
  weight: number;
  label?: string;
};
type TooltipRow = { label: string; value: string };

type ForwardedGraphProps = {
  nodes: GraphNode[];
  links: GraphLink[];
  getLinkRows: (
    link: GraphLink,
    source: GraphNode,
    target: GraphNode
  ) => TooltipRow[];
  getNodeRows: (node: GraphNode) => TooltipRow[];
};

function makeItem(
  overrides: Partial<WorkflowEffectivenessItem> &
    Pick<WorkflowEffectivenessItem, "subagentType">
): WorkflowEffectivenessItem {
  return {
    total: 0,
    completed: 0,
    errors: 0,
    sessions: 0,
    successRate: 0,
    avgDuration: null,
    trend: [],
    ...overrides,
  };
}

function findRow(rows: TooltipRow[], label: string) {
  return rows.find((row) => row.label === label);
}

function renderNetwork(props: NetworkProps): ForwardedGraphProps {
  captured = null;
  render(<AgentCollaborationNetwork data={props.data} edges={props.edges} />);
  if (!captured) {
    throw new Error("Graph mock did not capture props");
  }
  return captured;
}
