// @ts-nocheck
"use client";

import * as d3 from "d3";
import { useEffect, useMemo, useRef, useState } from "react";
import { GRAPH_RESET_EVENT } from "./graph-events";

// Fallback dimensions used before the ResizeObserver reports the real container
// box (and in non-DOM environments). The graph sizes to its parent so it stays
// inside the enclosing card instead of computing an unbounded height (FEA-3622).
const FALLBACK_WIDTH = 640;
const FALLBACK_HEIGHT = 340;
const MIN_GRAPH_HEIGHT = 180;

/**
 * Resolve the graph's box from an observed container `contentRect`, keeping it
 * bounded by that container (FEA-3622). A non-positive dimension (observer fired
 * before layout) falls back to the current size; a positive height is floored at
 * `MIN_GRAPH_HEIGHT` so a very short card still renders a usable canvas.
 */
export function resolveGraphSize(
  observed: { width: number; height: number },
  current: { width: number; height: number }
): { width: number; height: number } {
  const width = observed.width > 0 ? observed.width : current.width;
  const height =
    observed.height > 0
      ? Math.max(MIN_GRAPH_HEIGHT, observed.height)
      : current.height;
  return width === current.width && height === current.height
    ? current
    : { width, height };
}

type GraphNode = {
  id: string;
  label?: string;
  value: number;
  color?: string;
  strokeColor?: string;
};

type GraphLink = {
  source: string;
  target: string;
  weight: number;
  label?: string;
};

type TooltipRow = {
  label: string;
  value: string;
};

type SimulationNode = GraphNode & d3.SimulationNodeDatum;
type SimulationLink = GraphLink & d3.SimulationLinkDatum<SimulationNode>;

type GraphProps = {
  nodes: GraphNode[];
  links: GraphLink[];
  ariaLabel?: string;
  emptyMessage?: string;
  legendLabel?: string;
  edgeLegendLabel?: string;
  getNodeRows?: (node: GraphNode) => TooltipRow[];
  getLinkRows?: (
    link: GraphLink,
    source: GraphNode,
    target: GraphNode
  ) => TooltipRow[];
  getNodeDescription?: (node: GraphNode) => string | undefined;
  getLinkDescription?: (
    link: GraphLink,
    source: GraphNode,
    target: GraphNode
  ) => string | undefined;
};

const DEFAULT_NODE_COLORS = [
  "#6366f1",
  "#3b82f6",
  "#22c55e",
  "#a855f7",
  "#f59e0b",
  "#ec4899",
  "#06b6d4",
  "#f97316",
  "#ef4444",
  "#14b8a6",
];

const DEFAULT_NODE_STROKES = [
  "#818cf8",
  "#60a5fa",
  "#4ade80",
  "#c084fc",
  "#fbbf24",
  "#f472b6",
  "#22d3ee",
  "#fb923c",
  "#f87171",
  "#2dd4bf",
];

function clampTooltip(
  tooltip: HTMLDivElement,
  left: number,
  top: number
) {
  tooltip.style.opacity = "0";
  const width = tooltip.offsetWidth || 280;
  const height = tooltip.offsetHeight || 160;
  const margin = 8;

  let nextLeft = left + 14;
  let nextTop = top + 14;

  if (nextLeft + width > globalThis.window.innerWidth - margin) {
    nextLeft = globalThis.window.innerWidth - width - margin;
  }
  if (nextLeft < margin) {
    nextLeft = margin;
  }
  if (nextTop + height > globalThis.window.innerHeight - margin) {
    nextTop = top - height - 14;
  }
  if (nextTop < margin) {
    nextTop = margin;
  }

  tooltip.style.left = `${nextLeft}px`;
  tooltip.style.top = `${nextTop}px`;
  requestAnimationFrame(() => {
    tooltip.style.opacity = "1";
  });
}

function renderTooltip(
  tooltip: HTMLDivElement,
  title: string,
  subtitle: string,
  rows: TooltipRow[],
  description?: string
) {
  tooltip.textContent = "";

  const titleElement = globalThis.document.createElement("p");
  titleElement.style.cssText =
    "font-size:12px;font-weight:600;color:#e2e8f0;margin:0 0 2px";
  titleElement.textContent = title;
  tooltip.appendChild(titleElement);

  const subtitleElement = globalThis.document.createElement("p");
  subtitleElement.style.cssText =
    "font-size:10px;color:#64748b;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.05em";
  subtitleElement.textContent = subtitle;
  tooltip.appendChild(subtitleElement);

  for (const row of rows) {
    const rowElement = globalThis.document.createElement("div");
    rowElement.style.cssText =
      "display:flex;justify-content:space-between;gap:16px;font-size:11px;line-height:1.6";

    const labelElement = globalThis.document.createElement("span");
    labelElement.style.color = "#64748b";
    labelElement.textContent = row.label;

    const valueElement = globalThis.document.createElement("span");
    valueElement.style.cssText =
      "color:#cbd5e1;font-weight:500;font-variant-numeric:tabular-nums";
    valueElement.textContent = row.value;

    rowElement.appendChild(labelElement);
    rowElement.appendChild(valueElement);
    tooltip.appendChild(rowElement);
  }

  if (description) {
    const descriptionElement = globalThis.document.createElement("p");
    descriptionElement.style.cssText =
      "font-size:11px;color:#94a3b8;line-height:1.45;margin:8px 0 0;padding-top:8px;border-top:1px solid #2a2a4a";
    descriptionElement.textContent = description;
    tooltip.appendChild(descriptionElement);
  }
}

export function Graph({
  nodes,
  links,
  ariaLabel = "Graph",
  emptyMessage = "No data",
  legendLabel = "Legend",
  edgeLegendLabel = "A runs before B",
  getNodeRows,
  getLinkRows,
  getNodeDescription,
  getLinkDescription,
}: GraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<d3.Simulation<SimulationNode, SimulationLink> | null>(
    null
  );
  // Clears the bespoke tooltip + hover highlight back to their resting state.
  // Populated by the d3 effect (which owns the selections) and invoked when a
  // `GRAPH_RESET_EVENT` fires — i.e. when this graph's DOM node is relocated or
  // moved without a `mouseleave` (widget expand/collapse, keyboard-driven), so a
  // frozen tooltip/highlight cannot survive the transition. See `graph-events`.
  const resetInteractionRef = useRef<(() => void) | null>(null);
  // The rendered SVG box, tracked from the flex-1 container so the force layout
  // fills its card without overflowing it. Both dimensions come from the parent;
  // the graph never derives its own height (FEA-3622).
  const [size, setSize] = useState({
    width: FALLBACK_WIDTH,
    height: FALLBACK_HEIGHT,
  });

  const graphData = useMemo(() => {
    const nodeMap = new Map<string, GraphNode>();
    nodes.forEach((node, index) => {
      nodeMap.set(node.id, {
        ...node,
        color: node.color ?? DEFAULT_NODE_COLORS[index % DEFAULT_NODE_COLORS.length],
        strokeColor:
          node.strokeColor ??
          DEFAULT_NODE_STROKES[index % DEFAULT_NODE_STROKES.length],
      });
    });

    const dedupedLinks: GraphLink[] = [];
    const seen = new Set<string>();
    for (const link of links) {
      if (link.source === link.target) {
        continue;
      }
      if (!(nodeMap.has(link.source) && nodeMap.has(link.target))) {
        continue;
      }
      const key = `${link.source}->${link.target}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      dedupedLinks.push({
        ...link,
        label: link.label ?? `${link.weight}x`,
      });
    }

    return {
      nodes: [...nodeMap.values()],
      links: dedupedLinks,
      isEmpty: nodeMap.size === 0 || dedupedLinks.length === 0,
    };
  }, [links, nodes]);

  // Track the flex-1 container box so the graph fills its card without
  // overflowing it (FEA-3622). Keyed on `isEmpty` so the observer (re)attaches
  // once the graph DOM mounts — the empty state early-returns before the
  // container ref exists, so a `[]`-deps effect would never observe it.
  useEffect(() => {
    const element = containerRef.current;
    if (
      !element ||
      graphData.isEmpty ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const observed = {
        width: Math.floor(entry.contentRect.width),
        height: Math.floor(entry.contentRect.height),
      };
      setSize((current) => resolveGraphSize(observed, current));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [graphData.isEmpty]);

  // Reset the tooltip + hover highlight when a host relocates this graph (widget
  // expand/collapse) or moves it via a keyboard action that never crosses the
  // pointer out of the SVG, since neither fires the `mouseleave` that would
  // otherwise clear them. `resetInteractionRef` is populated by the d3 effect;
  // the `?.()` guard makes this a no-op while the graph is empty or not yet
  // built. Mounted once and torn down on unmount so no listener leaks.
  useEffect(() => {
    if (globalThis.document === undefined) {
      return;
    }
    const handleReset = () => {
      resetInteractionRef.current?.();
    };
    globalThis.document.addEventListener(GRAPH_RESET_EVENT, handleReset);
    return () =>
      globalThis.document.removeEventListener(GRAPH_RESET_EVENT, handleReset);
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    const tooltip = tooltipRef.current;

    if (!(svg && container && tooltip) || graphData.isEmpty) {
      return;
    }

    simulationRef.current?.stop();

    // Size to the observed container box so the graph is bounded by its card
    // (FEA-3622) — no width-derived height that can exceed the card and overlap
    // the widget below it.
    const width = size.width;
    const height = size.height;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;

    const root = d3.select(svg);
    root.selectAll("*").remove();

    const defs = root.append("defs");
    defs
      .append("marker")
      .attr("id", "graph-arrowhead")
      .attr("viewBox", "0 0 10 6")
      .attr("refX", 10)
      .attr("refY", 3)
      .attr("markerWidth", 8)
      .attr("markerHeight", 5)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,0 L10,3 L0,6 Z")
      .attr("fill", "#64748b");

    const simNodes = graphData.nodes.map((node) => ({ ...node }));
    const nodeById = new Map(simNodes.map((node) => [node.id, node]));
    const simLinks = graphData.links.map((link) => ({
      ...link,
      source: nodeById.get(link.source) ?? link.source,
      target: nodeById.get(link.target) ?? link.target,
    }));

    const valueExtent = d3.extent(simNodes, (node) => node.value) as [
      number,
      number,
    ];
    const radiusScale = d3
      .scaleSqrt()
      .domain([
        Math.max(1, valueExtent[0] ?? 1),
        Math.max(2, valueExtent[1] ?? 2),
      ])
      .range([22, 46])
      .clamp(true);

    const weightExtent = d3.extent(simLinks, (link) => link.weight) as [
      number,
      number,
    ];
    const strokeScale = d3
      .scaleLinear()
      .domain([
        Math.max(1, weightExtent[0] ?? 1),
        Math.max(2, weightExtent[1] ?? 2),
      ])
      .range([1.5, 6])
      .clamp(true);

    const linkGroup = root.append("g");
    const linkElements = linkGroup
      .selectAll<SVGPathElement, SimulationLink>("path")
      .data(simLinks)
      .join("path")
      .attr("fill", "none")
      .attr("stroke", "#64748b")
      .attr("stroke-opacity", 0.55)
      .attr("stroke-width", (link) => Math.max(1.5, strokeScale(link.weight)))
      .attr("marker-end", "url(#graph-arrowhead)");

    const labelGroup = root.append("g");
    const edgeLabels = labelGroup
      .selectAll<SVGTextElement, SimulationLink>("text")
      .data(simLinks)
      .join("text")
      .attr("fill", "#94a3b8")
      .attr("font-size", "9px")
      .attr("font-weight", "600")
      .attr("text-anchor", "middle")
      .text((link) => link.label ?? `${link.weight}x`);

    const hitGroup = root.append("g");
    const hitTargets = hitGroup
      .selectAll<SVGPathElement, SimulationLink>("path")
      .data(simLinks)
      .join("path")
      .attr("fill", "none")
      .attr("stroke", "transparent")
      .attr("stroke-width", 16)
      .attr("cursor", "pointer");

    const nodeGroup = root.append("g");
    const nodeElements = nodeGroup
      .selectAll<SVGGElement, SimulationNode>("g")
      .data(simNodes)
      .join("g")
      .attr("cursor", "grab");

    nodeElements
      .append("circle")
      .attr("r", (node) => radiusScale(node.value))
      .attr("fill", (node) => node.color ?? DEFAULT_NODE_COLORS[0])
      .attr("fill-opacity", 0.82)
      .attr("stroke", (node) => node.strokeColor ?? DEFAULT_NODE_STROKES[0])
      .attr("stroke-width", 2);

    nodeElements
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", (node) => radiusScale(node.value) + 14)
      .attr("fill", "#cbd5e1")
      .attr("font-size", "10px")
      .attr("font-weight", "500")
      .text((node) => {
        const label = node.label ?? node.id;
        return label.length > 16 ? `${label.slice(0, 14)}...` : label;
      });

    // Full return to the resting state: hide the tooltip AND clear every hover
    // highlight (link stroke-opacity/width, edge-label opacity, node
    // stroke-width). This is the shared body of both `mouseleave` handlers, and
    // is also what a `GRAPH_RESET_EVENT` invokes when the graph is relocated or
    // moved with no `mouseleave` (widget expand/collapse, keyboard-driven), so a
    // frozen tooltip/highlight can't survive that transition.
    const resetInteraction = () => {
      linkElements
        .attr("stroke-opacity", 0.55)
        .attr("stroke-width", (link) => Math.max(1.5, strokeScale(link.weight)));
      edgeLabels.attr("fill-opacity", 1);
      nodeElements.selectAll("circle").attr("stroke-width", 2);
      tooltip.style.opacity = "0";
    };
    resetInteractionRef.current = resetInteraction;

    hitTargets
      .on("mouseenter", (event: MouseEvent, link) => {
        const source = link.source as SimulationNode;
        const target = link.target as SimulationNode;

        linkElements
          .attr("stroke-opacity", (current) => (current === link ? 0.95 : 0.08))
          .attr("stroke-width", (current) =>
            current === link
              ? Math.max(3, strokeScale(current.weight) + 1)
              : Math.max(1.5, strokeScale(current.weight))
          );
        edgeLabels.attr("fill-opacity", (current) => (current === link ? 1 : 0.15));

        renderTooltip(
          tooltip,
          `${source.label ?? source.id} -> ${target.label ?? target.id}`,
          "Link",
          getLinkRows?.(link, source, target) ?? [
            { label: "Pairs", value: `${link.weight}x` },
            { label: "Source volume", value: source.value.toLocaleString() },
            { label: "Target volume", value: target.value.toLocaleString() },
          ],
          getLinkDescription?.(link, source, target)
        );
        clampTooltip(tooltip, event.clientX, event.clientY);
      })
      .on("mouseleave", () => {
        resetInteraction();
      });

    nodeElements
      .on("mouseenter", (event: MouseEvent, node) => {
        linkElements.attr("stroke-opacity", (link) => {
          const source = link.source as SimulationNode;
          const target = link.target as SimulationNode;
          return source.id === node.id || target.id === node.id ? 0.9 : 0.08;
        });
        edgeLabels.attr("fill-opacity", (link) => {
          const source = link.source as SimulationNode;
          const target = link.target as SimulationNode;
          return source.id === node.id || target.id === node.id ? 1 : 0.15;
        });

        d3.select(event.currentTarget as SVGGElement)
          .select("circle")
          .attr("stroke-width", 4);

        renderTooltip(
          tooltip,
          node.label ?? node.id,
          "Node",
          getNodeRows?.(node) ?? [{ label: "Value", value: node.value.toLocaleString() }],
          getNodeDescription?.(node)
        );
        clampTooltip(tooltip, event.clientX, event.clientY);
      })
      .on("mouseleave", () => {
        resetInteraction();
      });

    const drag = d3
      .drag<SVGGElement, SimulationNode>()
      .on("start", (event, node) => {
        if (!event.active) {
          simulation.alphaTarget(0.12).restart();
        }
        node.fx = node.x;
        node.fy = node.y;
      })
      .on("drag", (event, node) => {
        node.fx = event.x;
        node.fy = event.y;
      })
      .on("end", (event, node) => {
        if (!event.active) {
          simulation.alphaTarget(0);
        }
        node.fx = null;
        node.fy = null;
      });

    nodeElements.call(drag);

    const simulation = d3
      .forceSimulation<SimulationNode>(simNodes)
      .force(
        "link",
        d3
          .forceLink<SimulationNode, SimulationLink>(simLinks)
          .id((node) => node.id)
          .distance(250)
      )
      .force("charge", d3.forceManyBody<SimulationNode>().strength(-800))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force(
        "collision",
        d3.forceCollide<SimulationNode>().radius(
          (node) => radiusScale(node.value) + 30
        )
      )
      .force("x", d3.forceX(width / 2).strength(0.03))
      .force("y", d3.forceY(height / 2).strength(0.03))
      .alpha(0.5)
      .on("tick", () => {
        for (const node of simNodes) {
          const radius = radiusScale(node.value) + 16;
          node.x = Math.max(radius, Math.min(width - radius, node.x ?? width / 2));
          node.y = Math.max(radius, Math.min(height - radius, node.y ?? height / 2));
        }

        const pathFor = (link: SimulationLink) => {
          const source = link.source as SimulationNode;
          const target = link.target as SimulationNode;
          const sx = source.x ?? 0;
          const sy = source.y ?? 0;
          const tx = target.x ?? 0;
          const ty = target.y ?? 0;
          const dx = tx - sx;
          const dy = ty - sy;
          const distance = Math.sqrt(dx * dx + dy * dy) || 1;
          const sourceRadius = radiusScale(source.value);
          const targetRadius = radiusScale(target.value) + 8;
          const x1 = sx + (dx / distance) * sourceRadius;
          const y1 = sy + (dy / distance) * sourceRadius;
          const x2 = tx - (dx / distance) * targetRadius;
          const y2 = ty - (dy / distance) * targetRadius;
          const mx = (x1 + x2) / 2 - dy * 0.1;
          const my = (y1 + y2) / 2 + dx * 0.1;
          return `M${x1},${y1} Q${mx},${my} ${x2},${y2}`;
        };

        linkElements.attr("d", pathFor);
        hitTargets.attr("d", pathFor);

        edgeLabels.each(function (link) {
          const source = link.source as SimulationNode;
          const target = link.target as SimulationNode;
          const sx = source.x ?? 0;
          const sy = source.y ?? 0;
          const tx = target.x ?? 0;
          const ty = target.y ?? 0;
          const dx = tx - sx;
          const dy = ty - sy;
          d3.select(this)
            .attr("x", (sx + tx) / 2 - dy * 0.1)
            .attr("y", (sy + ty) / 2 + dx * 0.1 - 4);
        });

        nodeElements.attr(
          "transform",
          (node) => `translate(${node.x ?? 0},${node.y ?? 0})`
        );
      });

    simulationRef.current = simulation;
    return () => {
      simulation.stop();
      // Drop the reset closure so a `GRAPH_RESET_EVENT` between this teardown and
      // the next rebuild (e.g. the graph going empty) doesn't touch detached d3
      // selections; the effect reassigns it on every rebuild.
      resetInteractionRef.current = null;
    };
  }, [
    getLinkDescription,
    getLinkRows,
    getNodeDescription,
    getNodeRows,
    graphData.isEmpty,
    graphData.links,
    graphData.nodes,
    size,
  ]);

  if (graphData.isEmpty) {
    return (
      <div className="flex h-full min-h-[180px] items-center justify-center text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      {/* The SVG fills the flexible region; the ResizeObserver on this box
          drives `size`, keeping the graph inside its card (FEA-3622). */}
      <div className="relative min-h-0 flex-1 overflow-hidden" ref={containerRef}>
        <svg
          aria-label={ariaLabel}
          onMouseLeave={() => {
            const tooltip = tooltipRef.current;
            if (tooltip) {
              tooltip.style.opacity = "0";
            }
          }}
          ref={svgRef}
          role="img"
          style={{
            display: "block",
            width: "100%",
            height: size.height,
            background: "transparent",
          }}
        />
      </div>
      <div
        aria-hidden="true"
        className="fixed z-50 rounded-lg border border-[#2a2a4a] bg-[#12121f] px-3 py-2 shadow-2xl pointer-events-none"
        ref={tooltipRef}
        role="tooltip"
        style={{
          opacity: 0,
          left: 0,
          top: 0,
          minWidth: 172,
          transition: "opacity 120ms ease-out",
        }}
      />
      <div className="mt-3 flex shrink-0 flex-wrap items-center gap-3 px-1">
        <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          {legendLabel}
        </span>
        {graphData.nodes.map((node, index) => (
          <div className="flex items-center gap-1.5" key={node.id}>
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{
                backgroundColor:
                  node.color ?? DEFAULT_NODE_COLORS[index % DEFAULT_NODE_COLORS.length],
                border: `1.5px solid ${
                  node.strokeColor ??
                  DEFAULT_NODE_STROKES[index % DEFAULT_NODE_STROKES.length]
                }`,
              }}
            />
            <span className="text-[11px] text-muted-foreground">
              {node.label ?? node.id}
            </span>
          </div>
        ))}
        <div className="ml-2 flex items-center gap-1.5">
          <svg className="shrink-0" height="8" width="20">
            <line x1="0" x2="14" y1="4" y2="4" stroke="#64748b" strokeWidth="1.5" />
            <polygon fill="#64748b" points="14,1 20,4 14,7" />
          </svg>
          <span className="text-[11px] text-muted-foreground">
            {edgeLegendLabel}
          </span>
        </div>
      </div>
    </div>
  );
}
