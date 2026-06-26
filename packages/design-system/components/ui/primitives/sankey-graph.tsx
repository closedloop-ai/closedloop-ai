// @ts-nocheck
"use client";

import * as d3 from "d3";
import { sankey, sankeyLinkHorizontal } from "d3-sankey";
import { useEffect, useMemo, useRef, useState } from "react";

type SankeyFlow = {
  source: string;
  target: string;
  value: number;
};

type SankeyNodeTotal = {
  id: string;
  value: number;
};

type SankeyNodeDatum = {
  id: string;
};

type SankeyLinkDatum = {
  uid: string;
};

type SankeyGraphProps = {
  flows: SankeyFlow[];
  totals: SankeyNodeTotal[];
  palette?: Record<string, string>;
  ariaLabel?: string;
  emptyMessage?: string;
  labelFormatter?: (id: string) => string;
};

const MARGIN = { top: 24, right: 140, bottom: 24, left: 140 };
const NODE_WIDTH = 14;
const NODE_PADDING = 18;
const MIN_NODE_HEIGHT = 6;

function defaultColor(name: string) {
  return (
    {
      Read: "#3b82f6",
      Write: "#22c55e",
      Edit: "#eab308",
      Bash: "#ef4444",
      Grep: "#a855f7",
      Glob: "#ec4899",
      Agent: "#6366f1",
    }[name] ?? "#64748b"
  );
}

function splitId(name: string) {
  return name.replace(/_(source|target)$/, "");
}

function buildInput(flows: SankeyFlow[]) {
  const sourceNames = new Set(flows.map((flow) => flow.source));
  const targetNames = new Set(flows.map((flow) => flow.target));
  const bothSides = new Set<string>();
  for (const name of sourceNames) {
    if (targetNames.has(name)) {
      bothSides.add(name);
    }
  }

  const sourceId = (name: string) =>
    (bothSides.has(name) ? `${name}_source` : name);
  const targetId = (name: string) =>
    (bothSides.has(name) ? `${name}_target` : name);

  const links = flows.map((flow, index) => ({
    source: sourceId(flow.source),
    target: targetId(flow.target),
    value: Math.max(1, flow.value),
    uid: `link-${index}`,
  }));

  const nodeIds = new Set<string>();
  for (const link of links) {
    nodeIds.add(link.source);
    nodeIds.add(link.target);
  }

  return {
    nodes: Array.from(nodeIds).map((id) => ({ id })),
    links,
  };
}

function setTooltipPosition(
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
  if (nextLeft + width > window.innerWidth - margin) {
    nextLeft = window.innerWidth - width - margin;
  }
  if (nextLeft < margin) {
    nextLeft = margin;
  }
  if (nextTop + height > window.innerHeight - margin) {
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
  rows: Array<{ label: string; value: string }>
) {
  tooltip.textContent = "";

  const titleElement = document.createElement("p");
  titleElement.style.cssText =
    "font-size:12px;font-weight:600;color:#e2e8f0;margin:0 0 2px";
  titleElement.textContent = title;
  tooltip.appendChild(titleElement);

  const subtitleElement = document.createElement("p");
  subtitleElement.style.cssText =
    "font-size:10px;color:#64748b;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.05em";
  subtitleElement.textContent = subtitle;
  tooltip.appendChild(subtitleElement);

  for (const row of rows) {
    const rowElement = document.createElement("div");
    rowElement.style.cssText =
      "display:flex;justify-content:space-between;gap:16px;font-size:11px;line-height:1.6";

    const labelElement = document.createElement("span");
    labelElement.style.color = "#64748b";
    labelElement.textContent = row.label;

    const valueElement = document.createElement("span");
    valueElement.style.cssText =
      "color:#cbd5e1;font-weight:500;font-variant-numeric:tabular-nums";
    valueElement.textContent = row.value;

    rowElement.appendChild(labelElement);
    rowElement.appendChild(valueElement);
    tooltip.appendChild(rowElement);
  }
}

export function SankeyGraph({
  flows,
  totals,
  palette,
  ariaLabel = "Sankey graph",
  emptyMessage = "No data",
  labelFormatter = (id) => id,
}: SankeyGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 700, height: 420 });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const width = Math.floor(entry.contentRect.width);
      if (width > 0) {
        setSize((current) => ({ ...current, width }));
      }
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const totalUsage = useMemo(
    () => totals.reduce((sum, total) => sum + total.value, 0),
    [totals]
  );

  const isEmpty = flows.length === 0 || flows.every((flow) => flow.value === 0);

  useEffect(() => {
    const uniqueCount = new Set(flows.flatMap((flow) => [flow.source, flow.target]))
      .size;
    const height = Math.max(
      320,
      Math.min(600, uniqueCount * (NODE_PADDING + 20) + MARGIN.top + MARGIN.bottom)
    );
    setSize((current) => ({ ...current, height }));
  }, [flows]);

  useEffect(() => {
    const svg = svgRef.current;
    const tooltip = tooltipRef.current;
    if (!(svg && tooltip) || isEmpty) {
      return;
    }

    const { width, height } = size;
    const innerWidth = width - MARGIN.left - MARGIN.right;
    const innerHeight = height - MARGIN.top - MARGIN.bottom;
    if (innerWidth <= 0 || innerHeight <= 0) {
      return;
    }

    const { nodes: rawNodes, links: rawLinks } = buildInput(flows);
    if (rawNodes.length === 0) {
      return;
    }

    const generator = sankey<SankeyNodeDatum, SankeyLinkDatum>()
      .nodeId((node) => node.id)
      .nodeWidth(NODE_WIDTH)
      .nodePadding(NODE_PADDING)
      .nodeSort(null)
      .extent([
        [0, 0],
        [innerWidth, innerHeight],
      ]);

    const graph = generator({
      nodes: rawNodes.map((node) => ({ ...node })),
      links: rawLinks.map((link) => ({ ...link })),
    });

    for (const node of graph.nodes) {
      if (node.y0 !== undefined && node.y1 !== undefined) {
        const heightValue = node.y1 - node.y0;
        if (heightValue < MIN_NODE_HEIGHT) {
          const midpoint = (node.y0 + node.y1) / 2;
          node.y0 = midpoint - MIN_NODE_HEIGHT / 2;
          node.y1 = midpoint + MIN_NODE_HEIGHT / 2;
        }
      }
    }
    generator.update(graph);

    const totalMap = new Map(totals.map((total) => [total.id, total.value]));
    const outgoingMap = new Map<string, number>();
    const incomingMap = new Map<string, number>();
    for (const link of graph.links) {
      const source = (link.source as { id: string }).id;
      const target = (link.target as { id: string }).id;
      outgoingMap.set(source, (outgoingMap.get(source) ?? 0) + (link.value ?? 0));
      incomingMap.set(target, (incomingMap.get(target) ?? 0) + (link.value ?? 0));
    }

    const root = d3.select(svg);
    root.selectAll("*").remove();
    root
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("preserveAspectRatio", "xMidYMid meet");

    const defs = root.append("defs");
    graph.links.forEach((link, index) => {
      const source = link.source as { id: string; x1?: number };
      const target = link.target as { id: string; x0?: number };
      const gradient = defs
        .append("linearGradient")
        .attr("id", `sankey-link-${index}`)
        .attr("gradientUnits", "userSpaceOnUse")
        .attr("x1", source.x1 ?? 0)
        .attr("x2", target.x0 ?? 0);

      const sourceColor = palette?.[splitId(source.id)] ?? defaultColor(splitId(source.id));
      const targetColor = palette?.[splitId(target.id)] ?? defaultColor(splitId(target.id));
      gradient.append("stop").attr("offset", "0%").attr("stop-color", sourceColor);
      gradient.append("stop").attr("offset", "100%").attr("stop-color", targetColor);
    });

    const chartRoot = root
      .append("g")
      .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

    const pathGenerator = sankeyLinkHorizontal();

    chartRoot
      .append("g")
      .selectAll("path")
      .data(graph.links)
      .join("path")
      .attr("d", (link) => pathGenerator(link) ?? "")
      .attr("stroke", (_link, index) => `url(#sankey-link-${index})`)
      .attr("stroke-width", (link) => Math.max(1, link.width ?? 1))
      .attr("fill", "none")
      .attr("stroke-opacity", 0.18)
      .on("mouseenter", function (event: MouseEvent, link) {
        d3.select(this).attr("stroke-opacity", 0.48);
        const source = link.source as { id: string };
        const target = link.target as { id: string };
        const sourceTotal = outgoingMap.get(source.id) ?? 0;
        const targetTotal = incomingMap.get(target.id) ?? 0;

        renderTooltip(tooltip, `${labelFormatter(splitId(source.id))} -> ${labelFormatter(splitId(target.id))}`, "Flow", [
          { label: "Count", value: (link.value ?? 0).toLocaleString() },
          {
            label: "Share of source",
            value:
              sourceTotal > 0
                ? `${(((link.value ?? 0) / sourceTotal) * 100).toFixed(1)}%`
                : "—",
          },
          {
            label: "Share of target",
            value:
              targetTotal > 0
                ? `${(((link.value ?? 0) / targetTotal) * 100).toFixed(1)}%`
                : "—",
          },
        ]);
        setTooltipPosition(tooltip, event.clientX, event.clientY);
      })
      .on("mouseleave", function () {
        d3.select(this).attr("stroke-opacity", 0.18);
        tooltip.style.opacity = "0";
      });

    const nodes = chartRoot
      .append("g")
      .selectAll("g")
      .data(graph.nodes)
      .join("g");

    nodes
      .append("rect")
      .attr("x", (node) => node.x0 ?? 0)
      .attr("y", (node) => node.y0 ?? 0)
      .attr("width", (node) => (node.x1 ?? 0) - (node.x0 ?? 0))
      .attr("height", (node) =>
        Math.max(MIN_NODE_HEIGHT, (node.y1 ?? 0) - (node.y0 ?? 0))
      )
      .attr("rx", 2)
      .attr("fill", (node) => palette?.[splitId(node.id)] ?? defaultColor(splitId(node.id)))
      .attr("fill-opacity", 0.92)
      .on("mouseenter", function (event: MouseEvent, node) {
        const count = totalMap.get(splitId(node.id)) ?? 0;
        renderTooltip(tooltip, labelFormatter(splitId(node.id)), "Node", [
          { label: "Count", value: count.toLocaleString() },
          {
            label: "Share of total",
            value:
              totalUsage > 0 ? `${((count / totalUsage) * 100).toFixed(1)}%` : "—",
          },
        ]);
        setTooltipPosition(tooltip, event.clientX, event.clientY);
      })
      .on("mouseleave", () => {
        tooltip.style.opacity = "0";
      });

    nodes.each(function (node) {
      const element = d3.select(this);
      const x0 = node.x0 ?? 0;
      const x1 = node.x1 ?? 0;
      const y0 = node.y0 ?? 0;
      const y1 = node.y1 ?? 0;
      const label = labelFormatter(splitId(node.id));
      const count = totalMap.get(splitId(node.id)) ?? 0;
      const percent =
        totalUsage > 0 ? ` ${((count / totalUsage) * 100).toFixed(1)}%` : "";
      const isRightSide = (x0 + x1) / 2 > innerWidth / 2;
      const text = element
        .append("text")
        .attr("x", isRightSide ? x1 + 8 : x0 - 8)
        .attr("y", y0 + (y1 - y0) / 2)
        .attr("dy", "0.35em")
        .attr("text-anchor", isRightSide ? "start" : "end")
        .style("font-size", "12px")
        .style("fill", "#e2e8f0");

      text.append("tspan").text(label).style("font-weight", "500");
      if (percent) {
        text
          .append("tspan")
          .text(percent)
          .style("fill", "#64748b")
          .style("font-size", "11px");
      }
    });
  }, [ariaLabel, flows, isEmpty, labelFormatter, palette, size, totalUsage, totals]);

  if (isEmpty) {
    return (
      <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="relative" ref={containerRef}>
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
        style={{ display: "block", width: "100%", height: size.height }}
      />
      <div
        aria-hidden="true"
        className="fixed z-50 rounded-lg border border-[#2a2a4a] bg-[#12121f] px-3 py-2 shadow-2xl pointer-events-none"
        ref={tooltipRef}
        role="tooltip"
        style={{
          display: "block",
          opacity: 0,
          left: 0,
          top: 0,
          minWidth: 200,
          transition: "opacity 120ms ease-out",
        }}
      />
    </div>
  );
}
