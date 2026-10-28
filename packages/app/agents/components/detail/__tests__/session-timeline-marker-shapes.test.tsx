import { readFileSync } from "node:fs";
import path from "node:path";
import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  type DotColor,
  getDotShape,
  getDotShapeClassName,
} from "../activity-dot-rendering";
import type { ActivityMarker } from "../session-timeline-axis";
import { SessionTimelineDotRail } from "../session-timeline-dot-rail";
import { SessionTimelineMarkSwatch } from "../session-timeline-mark-swatch";
import { type TraceEventGroup, TraceEventRow } from "../trace-event-row";
import {
  TraceMarkPalette,
  TraceMarkPaletteProvider,
} from "../trace-mark-bullet";

/**
 * ISS-12117 — every Session Timeline mark has its own SHAPE (steering square,
 * commits & PRs circle, failures & limits diamond), because the three hues
 * share the one arc the bars leave free and cannot separate the marks alone.
 *
 * These assert on the DOM each surface actually renders — the rail's dot
 * buttons, the swatch the legend and hover card use, and the transcript's
 * event bullet — and on the stylesheet rule that turns the class into a
 * drawn shape. jsdom loads no stylesheet and computes no geometry, so the
 * rotation and scale themselves are NOT observable here; the Storybook
 * `PaletteKey` stories are where the drawn shapes are checked.
 */

const LANES: readonly DotColor[] = ["b", "g", "r"];
const DRAWS_CONTENT = /content:\s*""/;
const FILLS_WITH_CURRENT_COLOR = /background:\s*currentColor/;

const TIMELINE_CSS = readFileSync(
  path.resolve(import.meta.dirname, "../../../../styles-session-timeline.css"),
  "utf8"
);

describe("Session Timeline marker shapes (ISS-12117)", () => {
  it("gives each lane a shape of its own", () => {
    const shapes = LANES.map((color) => getDotShape(color));
    expect(new Set(shapes).size).toBe(LANES.length);
    expect(shapes).toEqual(["square", "circle", "diamond"]);
  });

  it("draws each rail dot with its lane's shape class", () => {
    const { container } = render(
      <SessionTimelineDotRail
        buckets={[bucket()]}
        cells={[
          {
            b: [dotEvent("prompt")],
            g: [dotEvent("commit")],
            r: [dotEvent("fail")],
          },
        ]}
        disabled={false}
        hoverDot={null}
        onHoverDot={vi.fn()}
        onJump={vi.fn()}
      />
    );

    for (const color of LANES) {
      const dot = container.querySelector(`.sd3-dot.d-${color}`);
      expect(dot).toHaveClass(getDotShapeClassName(color));
      expect(dot).toHaveAttribute("data-shape", getDotShape(color));
    }
  });

  it.each(LANES)(
    "draws the %s swatch with the class the rail uses",
    (color) => {
      const { container } = render(<SessionTimelineMarkSwatch color={color} />);
      expect(container.firstElementChild).toHaveClass(
        getDotShapeClassName(color)
      );
    }
  );

  it.each(["g", "r"] as const)(
    "draws the transcript's %s event bullet as the rail's mark",
    (dot) => {
      const { container } = render(<TraceEventRow group={eventGroup(dot)} />);
      expect(container.querySelector(".st-sys-dot")).toHaveClass(
        getDotShapeClassName(dot)
      );
    }
  );

  // tamsinb on #8516: SessionTrace also renders under Branch detail, whose
  // rail still draws round shared-token dots (ISS-12180), so its transcript
  // keeps those to match the dot a reader clicked.
  it.each(["g", "r"] as const)(
    "keeps Branch detail's %s transcript bullet round, like its rail",
    (dot) => {
      const { container } = render(
        <TraceMarkPaletteProvider palette={TraceMarkPalette.BranchTimeline}>
          <TraceEventRow group={eventGroup(dot)} />
        </TraceMarkPaletteProvider>
      );
      const bullet = container.querySelector(".st-sys-dot");
      expect(bullet).toHaveClass(`d-${dot}`);
      expect(bullet).not.toHaveClass(getDotShapeClassName(dot));
      expect(bullet).not.toHaveAttribute("style");
    }
  );

  it("leaves a steering transcript row without a bullet, as before", () => {
    const { container } = render(<TraceEventRow group={eventGroup("b")} />);
    expect(container.querySelector(".st-sys-dot")).toBeNull();
  });

  /**
   * The class only draws something because a `::before` rule paints it. A
   * class rename on either side would leave every DOM assertion above green
   * while the strip drew nothing.
   */
  it.each(LANES)("has a stylesheet rule that paints the %s shape", (color) => {
    const selector = `.${getDotShapeClassName(color)}::before`;
    const bodies = ruleBodiesFor(selector);
    expect(bodies.join("\n")).toMatch(DRAWS_CONTENT);
    expect(bodies.join("\n")).toMatch(FILLS_WITH_CURRENT_COLOR);
  });
});

/** Every rule body whose selector list names `selector` exactly. */
function ruleBodiesFor(selector: string): string[] {
  const bodies: string[] = [];
  for (const match of TIMELINE_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(
    /([^{}]+)\{([^{}]*)\}/g
  )) {
    const selectors = (match[1] ?? "").split(",").map((part) => part.trim());
    if (selectors.includes(selector)) {
      bodies.push(match[2] ?? "");
    }
  }
  return bodies;
}

function bucket(): ActivityBucket {
  return {
    byModel: {},
    cCache: 0,
    cIn: 0,
    cOut: 0,
    key: "b0",
    label: "0m",
    tl0: 0,
    toolStart: 0,
    total: 0,
  };
}

function dotEvent(kind: ActivityMarker["kind"]): Omit<ActivityMarker, "x"> {
  return { kind, label: "seeded", t: "9:05 AM", tl: 1 };
}

function eventGroup(dot: DotColor): TraceEventGroup {
  return {
    item: {
      dot,
      t: "2026-06-10T12:03:30.000Z",
      text: "Seeded event",
      type: "event",
    } as TraceEventGroup["item"],
    kind: "event",
    row: 1,
  };
}
