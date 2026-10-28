import type { Graph as GraphComponent } from "@closedloop-ai/design-system/components/ui/primitives/graph";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TRANSLATE_PATTERN = /^translate\(([\d.-]+),([\d.-]+)\)$/;
const PATH_ENDPOINTS_PATTERN =
  /^M([\d.-]+),([\d.-]+) Q[\d.-]+,[\d.-]+ ([\d.-]+),([\d.-]+)$/;
const CANVAS = { width: 200, height: 180 };

/**
 * ISS-10309. `Graph`'s tick handler keeps every node centre `radius + 16` from
 * each canvas edge. On a canvas larger than the layout wants the clamp never
 * engages, so this suite uses a 200x180 box, smaller than the 250px link
 * distance, and runs the simulation to rest on a fake clock.
 *
 * d3-timer captures `performance` and `requestAnimationFrame` when it first
 * loads, so the fake clock is installed before `Graph` (and d3) are imported.
 * The import happens once per file, so this file holds ONE test: a second test
 * would install a fresh fake clock that d3 no longer reads, the simulation
 * would never tick, and the clamp assertions would pass against untouched
 * starting positions. `installs` below turns that into a named failure.
 */

let Graph: typeof GraphComponent;
let installs = 0;

beforeEach(async () => {
  installs += 1;
  if (installs > 1) {
    throw new Error(
      "graph-layout.test.tsx holds one test on purpose: d3-timer captured the first fake clock at import, so a second test would not tick. Put the new case in graph.test.tsx."
    );
  }
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
      "Date",
    ],
  });
  ({ Graph } = await import(
    "@closedloop-ai/design-system/components/ui/primitives/graph"
  ));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Reports a fixed container box as soon as the graph observes it. */
function stubContainerBox(width: number, height: number) {
  class FixedResizeObserver {
    private readonly callback: (entries: unknown[]) => void;
    constructor(callback: (entries: unknown[]) => void) {
      this.callback = callback;
    }
    observe() {
      this.callback([{ contentRect: { width, height } }]);
    }
    unobserve() {
      // Nothing to release.
    }
    disconnect() {
      // Nothing to release.
    }
  }
  vi.stubGlobal("ResizeObserver", FixedResizeObserver);
}

describe("Graph layout", () => {
  it("settles each node inside its own radius bound and draws each link between distinct points", () => {
    stubContainerBox(CANVAS.width, CANVAS.height);
    render(
      <Graph
        links={[
          { source: "a", target: "b", weight: 1 },
          { source: "b", target: "c", weight: 5 },
        ]}
        nodes={[
          { id: "a", value: 10 },
          { id: "b", value: 20 },
          { id: "c", value: 30 },
        ]}
      />
    );

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    const svg = screen.getByRole("img", { name: "Graph" });
    expect(svg).toHaveAttribute(
      "viewBox",
      `0 0 ${CANVAS.width} ${CANVAS.height}`
    );
    const [linkGroup, , , nodeGroup] = Array.from(
      svg.querySelectorAll(":scope > g")
    );
    const nodes = Array.from(nodeGroup.querySelectorAll(":scope > g"));
    expect(nodes).toHaveLength(3);

    const positions = nodes.map((node) => {
      const match = TRANSLATE_PATTERN.exec(
        node.getAttribute("transform") ?? ""
      );
      expect(match).not.toBeNull();
      const x = Number(match?.[1]);
      const y = Number(match?.[2]);
      const inset =
        Number(node.querySelector("circle")?.getAttribute("r")) + 16;
      expect(x).toBeGreaterThanOrEqual(inset);
      expect(x).toBeLessThanOrEqual(CANVAS.width - inset);
      expect(y).toBeGreaterThanOrEqual(inset);
      expect(y).toBeLessThanOrEqual(CANVAS.height - inset);
      return `${x},${y}`;
    });
    expect(new Set(positions).size).toBe(3);

    const links = Array.from(linkGroup.querySelectorAll("path"));
    expect(links).toHaveLength(2);
    for (const link of links) {
      const match = PATH_ENDPOINTS_PATTERN.exec(link.getAttribute("d") ?? "");
      expect(match).not.toBeNull();
      expect(`${match?.[1]},${match?.[2]}`).not.toBe(
        `${match?.[3]},${match?.[4]}`
      );
    }
  });
});
