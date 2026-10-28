import {
  Graph,
  resolveGraphSize,
} from "@closedloop-ai/design-system/components/ui/primitives/graph";
import { dispatchGraphReset } from "@closedloop-ai/design-system/components/ui/primitives/graph-events";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-10309. The Storybook sweep mounts `Graph` once and never moves a pointer
 * over it, so the hover highlight, the tooltip and its viewport clamp, the
 * link dedupe, the legend fallbacks and the resize handling were all
 * unexercised. jsdom has no layout: `offsetWidth` is 0 and the window is
 * 1024x768, which is what the clamp arithmetic below is computed against.
 */

const NODES = [
  { id: "a", label: "Alpha", value: 10 },
  { id: "b", label: "Beta", value: 20 },
  { id: "c", value: 30 },
];

const LINKS = [
  { source: "a", target: "b", weight: 1 },
  { source: "b", target: "c", weight: 5, label: "hot" },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type ObserverCallback = (entries: { contentRect: DOMRectReadOnly }[]) => void;

/** A ResizeObserver whose callback the test fires by hand. */
function stubResizeObserver() {
  const callbacks: ObserverCallback[] = [];
  class ManualResizeObserver {
    constructor(callback: ObserverCallback) {
      callbacks.push(callback);
    }
    observe() {
      // Reports only when the test calls `fire`.
    }
    unobserve() {
      // Nothing to release.
    }
    disconnect() {
      // Nothing to release.
    }
  }
  vi.stubGlobal("ResizeObserver", ManualResizeObserver);
  return {
    fire(entries: { contentRect: Partial<DOMRectReadOnly> }[]) {
      act(() => {
        for (const callback of callbacks) {
          callback(entries as { contentRect: DOMRectReadOnly }[]);
        }
      });
    },
  };
}

function renderGraph(props: Partial<React.ComponentProps<typeof Graph>> = {}) {
  const view = render(<Graph links={LINKS} nodes={NODES} {...props} />);
  const svg = screen.getByRole("img", { name: props.ariaLabel ?? "Graph" });
  const [linkGroup, labelGroup, hitGroup, nodeGroup] = Array.from(
    svg.querySelectorAll(":scope > g")
  );
  const tooltip = view.container.querySelector(
    '[role="tooltip"]'
  ) as HTMLDivElement;
  return {
    edgeLabels: Array.from(labelGroup.querySelectorAll("text")),
    hitTargets: Array.from(hitGroup.querySelectorAll("path")),
    links: Array.from(linkGroup.querySelectorAll("path")),
    nodes: Array.from(nodeGroup.querySelectorAll(":scope > g")),
    svg,
    tooltip,
  };
}

const tooltipText = (tooltip: HTMLElement) =>
  Array.from(tooltip.children).map((child) => child.textContent);

describe("resolveGraphSize", () => {
  const current = { width: 640, height: 340 };

  it("keeps the current object when nothing changes", () => {
    expect(resolveGraphSize({ width: 640, height: 340 }, current)).toBe(
      current
    );
  });

  it("keeps the current width and height for non-positive observations", () => {
    expect(resolveGraphSize({ width: 0, height: -5 }, current)).toBe(current);
  });

  it("floors a short observed height at the 180px minimum", () => {
    expect(resolveGraphSize({ width: 500, height: 90 }, current)).toEqual({
      width: 500,
      height: 180,
    });
  });

  it("takes a positive observed height above the minimum as is", () => {
    const next = resolveGraphSize({ width: 640, height: 400 }, current);

    expect(next).toEqual({ width: 640, height: 400 });
    expect(next).not.toBe(current);
  });
});

describe("Graph data handling", () => {
  it("renders the default empty message when no link survives the dedupe", () => {
    render(
      <Graph
        links={[
          { source: "a", target: "a", weight: 1 },
          { source: "a", target: "missing", weight: 1 },
        ]}
        nodes={NODES}
      />
    );

    expect(screen.getByText("No data")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders a custom empty message when there are no nodes", () => {
    render(<Graph emptyMessage="Nothing yet" links={LINKS} nodes={[]} />);

    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
  });

  it("drops self links, links to unknown nodes, and repeats of a pair", () => {
    const { links, edgeLabels } = renderGraph({
      links: [
        { source: "a", target: "b", weight: 3 },
        { source: "a", target: "b", weight: 9, label: "repeat" },
        { source: "b", target: "b", weight: 2 },
        { source: "b", target: "zzz", weight: 2 },
        { source: "b", target: "a", weight: 4, label: "back" },
      ],
    });

    // The first a->b wins; b->a is a different direction, so it stays.
    expect(links).toHaveLength(2);
    expect(edgeLabels.map((label) => label.textContent)).toEqual([
      "3x",
      "back",
    ]);
  });

  it("truncates node labels longer than 16 characters", () => {
    const { nodes } = renderGraph({
      nodes: [
        { id: "a", label: "Exactly16Chars!!", value: 1 },
        { id: "b", label: "Seventeen chars!!", value: 1 },
      ],
      links: [{ source: "a", target: "b", weight: 1 }],
    });

    expect(
      nodes.map((node) => node.querySelector("text")?.textContent)
    ).toEqual(["Exactly16Chars!!", "Seventeen char..."]);
  });

  it("falls back to the palette and the id in the legend", () => {
    const eleven = Array.from({ length: 11 }, (_, index) => ({
      id: `n${index}`,
      value: 1,
    }));
    render(
      <Graph
        links={[{ source: "n0", target: "n1", weight: 1 }]}
        nodes={[
          ...eleven,
          {
            id: "x",
            label: "Custom",
            value: 1,
            color: "#000000",
            strokeColor: "#ffffff",
          },
        ]}
      />
    );
    // The svg draws the same ids as node labels; only the legend has swatches.
    // Anchored on the legend's own label rather than a spacing class, so a
    // restyle does not break it.
    const legend = screen.getByText("Legend").parentElement as HTMLElement;

    const swatchOf = (text: string) =>
      within(legend).getByText(text).previousElementSibling as HTMLElement;
    expect(swatchOf("n0")).toHaveStyle({
      backgroundColor: "#6366f1",
      border: "1.5px solid #818cf8",
    });
    // The palette has ten entries, so the eleventh node wraps to the first.
    expect(swatchOf("n10")).toHaveStyle({ backgroundColor: "#6366f1" });
    expect(swatchOf("Custom")).toHaveStyle({
      backgroundColor: "#000000",
      border: "1.5px solid #ffffff",
    });
  });

  it("renders the legend and edge legend labels", () => {
    renderGraph({ edgeLegendLabel: "calls", legendLabel: "Tools" });

    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("calls")).toBeInTheDocument();
  });
});

describe("Graph hover", () => {
  it("highlights the hovered link and shows the default link tooltip", () => {
    const { links, edgeLabels, hitTargets, tooltip } = renderGraph();

    fireEvent.mouseEnter(hitTargets[0], { clientX: 10, clientY: 10 });

    expect(links.map((link) => link.getAttribute("stroke-opacity"))).toEqual([
      "0.95",
      "0.08",
    ]);
    // Hovered: max(3, scale(1) + 1) = 3. Other: max(1.5, scale(5)) = 6.
    expect(links.map((link) => link.getAttribute("stroke-width"))).toEqual([
      "3",
      "6",
    ]);
    expect(
      edgeLabels.map((label) => label.getAttribute("fill-opacity"))
    ).toEqual(["1", "0.15"]);
    expect(tooltipText(tooltip)).toEqual([
      "Alpha -> Beta",
      "Link",
      "Pairs1x",
      "Source volume10",
      "Target volume20",
    ]);
  });

  it("widens a heavy hovered link past its resting width", () => {
    const { links, hitTargets } = renderGraph();

    fireEvent.mouseEnter(hitTargets[1], { clientX: 10, clientY: 10 });

    // Hovered: max(3, scale(5) + 1) = 7. Other: max(1.5, scale(1)) = 1.5.
    expect(links.map((link) => link.getAttribute("stroke-width"))).toEqual([
      "1.5",
      "7",
    ]);
  });

  it("uses the id when a link endpoint has no label", () => {
    const { hitTargets, tooltip } = renderGraph();

    fireEvent.mouseEnter(hitTargets[1], { clientX: 10, clientY: 10 });

    expect(tooltipText(tooltip)[0]).toBe("Beta -> c");
  });

  it("uses the caller's link rows and description", () => {
    const getLinkRows = vi.fn(() => [{ label: "Custom", value: "row" }]);
    const getLinkDescription = vi.fn(() => "Why this link exists");
    const { hitTargets, tooltip } = renderGraph({
      getLinkDescription,
      getLinkRows,
    });

    fireEvent.mouseEnter(hitTargets[0], { clientX: 10, clientY: 10 });

    expect(tooltipText(tooltip)).toEqual([
      "Alpha -> Beta",
      "Link",
      "Customrow",
      "Why this link exists",
    ]);
    const [link, source, target] = getLinkRows.mock.calls[0] as unknown[];
    expect(link).toMatchObject({ weight: 1 });
    expect(source).toMatchObject({ id: "a" });
    expect(target).toMatchObject({ id: "b" });
  });

  it("highlights links touching the hovered node and shows the node tooltip", () => {
    const { links, edgeLabels, nodes, tooltip } = renderGraph();

    fireEvent.mouseEnter(nodes[0], { clientX: 10, clientY: 10 });

    expect(links.map((link) => link.getAttribute("stroke-opacity"))).toEqual([
      "0.9",
      "0.08",
    ]);
    expect(
      edgeLabels.map((label) => label.getAttribute("fill-opacity"))
    ).toEqual(["1", "0.15"]);
    expect(nodes[0].querySelector("circle")).toHaveAttribute(
      "stroke-width",
      "4"
    );
    expect(tooltipText(tooltip)).toEqual(["Alpha", "Node", "Value10"]);
  });

  it("matches a node as the target end of a link too", () => {
    const { links, nodes } = renderGraph();

    fireEvent.mouseEnter(nodes[2], { clientX: 10, clientY: 10 });

    expect(links.map((link) => link.getAttribute("stroke-opacity"))).toEqual([
      "0.08",
      "0.9",
    ]);
  });

  it("uses the id and the caller's node rows and description", () => {
    const { nodes, tooltip } = renderGraph({
      getNodeDescription: (node) => `about ${node.id}`,
      getNodeRows: (node) => [{ label: "Id", value: node.id }],
    });

    fireEvent.mouseEnter(nodes[2], { clientX: 10, clientY: 10 });

    expect(tooltipText(tooltip)).toEqual(["c", "Node", "Idc", "about c"]);
  });

  it("returns every highlight to rest on mouseleave", () => {
    const { links, edgeLabels, nodes, hitTargets, tooltip } = renderGraph();
    fireEvent.mouseEnter(nodes[0], { clientX: 10, clientY: 10 });

    fireEvent.mouseLeave(nodes[0]);

    expect(links.map((link) => link.getAttribute("stroke-opacity"))).toEqual([
      "0.55",
      "0.55",
    ]);
    expect(links.map((link) => link.getAttribute("stroke-width"))).toEqual([
      "1.5",
      "6",
    ]);
    expect(
      edgeLabels.map((label) => label.getAttribute("fill-opacity"))
    ).toEqual(["1", "1"]);
    expect(nodes[0].querySelector("circle")).toHaveAttribute(
      "stroke-width",
      "2"
    );
    expect(tooltip.style.opacity).toBe("0");

    fireEvent.mouseEnter(hitTargets[0], { clientX: 10, clientY: 10 });
    fireEvent.mouseLeave(hitTargets[0]);
    expect(links[0]).toHaveAttribute("stroke-opacity", "0.55");
  });

  it("resets the highlight when a graph reset is dispatched", () => {
    const { links, nodes } = renderGraph();
    fireEvent.mouseEnter(nodes[0], { clientX: 10, clientY: 10 });

    dispatchGraphReset();

    expect(links.map((link) => link.getAttribute("stroke-opacity"))).toEqual([
      "0.55",
      "0.55",
    ]);
    expect(nodes[0].querySelector("circle")).toHaveAttribute(
      "stroke-width",
      "2"
    );
  });

  it("hides the tooltip when the pointer leaves the svg", () => {
    // The tooltip fades in on the next frame; run frames immediately. d3
    // captured the real requestAnimationFrame at import, so the simulation is
    // unaffected.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    const { nodes, svg, tooltip } = renderGraph();
    fireEvent.mouseEnter(nodes[0], { clientX: 10, clientY: 10 });
    expect(tooltip.style.opacity).toBe("1");

    fireEvent.mouseLeave(svg);

    expect(tooltip.style.opacity).toBe("0");
  });
});

describe("Graph tooltip clamp", () => {
  const hoverAt = (clientX: number, clientY: number) => {
    const { nodes, tooltip } = renderGraph();
    fireEvent.mouseEnter(nodes[0], { clientX, clientY });
    return tooltip;
  };

  it("offsets the tooltip 14px from the pointer when it fits", () => {
    const tooltip = hoverAt(100, 100);

    expect(tooltip.style.left).toBe("114px");
    expect(tooltip.style.top).toBe("114px");
  });

  it("pins the tooltip inside the right edge using the 280px fallback width", () => {
    const tooltip = hoverAt(900, 100);

    // 1024 - 280 - 8
    expect(tooltip.style.left).toBe("736px");
  });

  it("flips the tooltip above the pointer near the bottom edge", () => {
    const tooltip = hoverAt(100, 700);

    // 700 - 160 - 14
    expect(tooltip.style.top).toBe("526px");
  });

  it("floors the tooltip at the 8px margin on the left and top", () => {
    const tooltip = hoverAt(-20, -20);

    expect(tooltip.style.left).toBe("8px");
    expect(tooltip.style.top).toBe("8px");
  });

  it("uses the tooltip's measured size when it has one", () => {
    const { nodes, tooltip } = renderGraph();
    Object.defineProperty(tooltip, "offsetWidth", { value: 100 });
    Object.defineProperty(tooltip, "offsetHeight", { value: 50 });

    fireEvent.mouseEnter(nodes[0], { clientX: 950, clientY: 740 });

    // 1024 - 100 - 8, and 740 - 50 - 14
    expect(tooltip.style.left).toBe("916px");
    expect(tooltip.style.top).toBe("676px");
  });
});

describe("Graph sizing", () => {
  it("sizes the svg to the observed container, ignoring an empty report", () => {
    const observer = stubResizeObserver();
    const { svg } = renderGraph();
    expect(svg).toHaveAttribute("viewBox", "0 0 640 340");

    observer.fire([]);
    expect(svg).toHaveAttribute("viewBox", "0 0 640 340");

    observer.fire([{ contentRect: { width: 500.9, height: 90.2 } }]);
    expect(svg).toHaveAttribute("viewBox", "0 0 500 180");
    expect(svg.style.width).toBe("500px");
  });

  it("keeps the fallback size where ResizeObserver does not exist", () => {
    vi.stubGlobal("ResizeObserver", undefined);

    const { svg } = renderGraph();

    expect(svg).toHaveAttribute("viewBox", "0 0 640 340");
  });
});
