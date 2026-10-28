import { Graph } from "@closedloop-ai/design-system/components/ui/primitives/graph";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-11299. The real d3 force simulation seeds every node's position before
 * the first tick and runs on its own timer, so the tick's missing-position
 * fallbacks never run and the drag handlers cannot be pinned to a result.
 * This file replaces `forceSimulation` with a manual one: it never seeds a
 * position, records `alphaTarget`, and ticks only when a test calls `tick`.
 * The rest of d3 (selections, scales, drag) is real.
 */

const simulationState = vi.hoisted(() => ({
  alphaTargets: [] as number[],
  tick: (() => undefined) as () => void,
}));

vi.mock("d3", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const forceSimulation = () => {
    const simulation = {
      alpha: () => simulation,
      alphaTarget: (value: number) => {
        simulationState.alphaTargets.push(value);
        return simulation;
      },
      force: () => simulation,
      on: (name: string, handler: () => void) => {
        if (name === "tick") {
          simulationState.tick = handler;
        }
        return simulation;
      },
      restart: () => simulation,
      stop: () => simulation,
    };
    return simulation;
  };
  return { ...actual, forceSimulation };
});

const NODES = [
  { id: "a", label: "Alpha", value: 10 },
  { id: "c", value: 10 },
];

beforeEach(() => {
  simulationState.alphaTargets = [];
  simulationState.tick = () => undefined;
  // Hold the 640x340 fallback box so tick positions are fixed.
  vi.stubGlobal("ResizeObserver", undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * d3-drag reads `event.view` to attach its move/up listeners. jsdom rejects
 * the test realm's `window` as a `view` init member, so set it afterwards.
 */
function press(target: Element | Window, type: "mousedown" | "mouseup") {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: 5,
    clientY: 5,
  });
  Object.defineProperty(event, "view", { value: window });
  fireEvent(target, event);
}

function renderGraph() {
  const view = render(
    <Graph links={[{ source: "c", target: "a", weight: 2 }]} nodes={NODES} />
  );
  const svg = screen.getByRole("img", { name: "Graph" });
  const [linkGroup, labelGroup, hitGroup, nodeGroup] = Array.from(
    svg.querySelectorAll(":scope > g")
  );
  return {
    edgeLabels: Array.from(labelGroup.querySelectorAll("text")),
    hitTargets: Array.from(hitGroup.querySelectorAll("path")),
    links: Array.from(linkGroup.querySelectorAll("path")),
    nodes: Array.from(nodeGroup.querySelectorAll(":scope > g")),
    tooltip: view.container.querySelector('[role="tooltip"]') as HTMLDivElement,
  };
}

describe("Graph link tooltip", () => {
  it("uses the id when the link's source has no label", () => {
    const { hitTargets, tooltip } = renderGraph();

    fireEvent.mouseEnter(hitTargets[0], { clientX: 10, clientY: 10 });

    expect(tooltip.firstElementChild?.textContent).toBe("c -> Alpha");
  });
});

describe("Graph tick", () => {
  it("centres nodes with no position in the 640x340 fallback box", () => {
    const { nodes } = renderGraph();

    simulationState.tick();

    expect(nodes.map((node) => node.getAttribute("transform"))).toEqual([
      "translate(320,170)",
      "translate(320,170)",
    ]);
  });

  it("draws a finite path between two nodes at the same point", () => {
    const { links, hitTargets, edgeLabels } = renderGraph();

    simulationState.tick();

    // Zero distance is treated as 1, so the direction terms are 0, not NaN.
    expect(links[0]).toHaveAttribute("d", "M320,170 Q320,170 320,170");
    expect(hitTargets[0]).toHaveAttribute("d", "M320,170 Q320,170 320,170");
    expect(edgeLabels[0]).toHaveAttribute("x", "320");
    expect(edgeLabels[0]).toHaveAttribute("y", "166");
  });
});

describe("Graph drag", () => {
  it("heats the simulation on drag start and cools it on drag end", () => {
    const { nodes } = renderGraph();

    press(nodes[0], "mousedown");
    expect(simulationState.alphaTargets).toEqual([0.12]);

    press(window, "mouseup");
    expect(simulationState.alphaTargets).toEqual([0.12, 0]);
  });

  it("pins the node at its position on drag start and releases both axes on drag end", () => {
    const { nodes } = renderGraph();
    simulationState.tick();
    const datum = (nodes[0] as Element & { __data__: SimNodeDatum }).__data__;

    press(nodes[0], "mousedown");
    expect(datum.fx).toBe(datum.x);
    expect(datum.fy).toBe(datum.y);
    expect(datum.fx).toEqual(expect.any(Number));

    press(window, "mouseup");
    expect(datum.fx).toBeNull();
    expect(datum.fy).toBeNull();
  });

  it("leaves the simulation alone for a gesture that starts while another is active", () => {
    const { nodes } = renderGraph();

    press(nodes[0], "mousedown");
    // A second press before release is a second gesture with `active` = 1.
    press(nodes[1], "mousedown");
    // The release ends that second gesture, still with `active` = 1.
    press(window, "mouseup");

    expect(simulationState.alphaTargets).toEqual([0.12]);
  });
});

/** The d3 datum a rendered node group carries: the simulation node itself. */
type SimNodeDatum = {
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
};
