import type { Meta, StoryObj } from "@storybook/react";
import { useLayoutEffect, useRef, useState } from "react";
import { expect } from "storybook/test";
import {
  getTimelineTooltipAnchor,
  type TooltipAnchor,
  useViewportTooltipStyle,
  ViewportTooltipPortal,
} from "./viewport-tooltip";

/**
 * ISS-5698: the shared viewport-anchored tooltip infrastructure, isolated.
 *
 * This module exports no component of its own — it exports a hook, a portal, and
 * two anchor readers — so the subject on the canvas is {@link ViewportTooltipDemo},
 * a thin harness that mounts the REAL `useViewportTooltipStyle` and the REAL
 * `ViewportTooltipPortal` and prints back what they resolved. Nothing about the
 * positioning is reimplemented here; the readout beside each card is the hook's
 * own `placement` and `style`, so a story cannot claim a placement the hook did
 * not produce.
 *
 * The reason this needs stories at all: the flip and the clamps are decided
 * against the LIVE viewport, so they are the one part of this module a unit test
 * cannot see. jsdom reports a zero-sized rect for every element, which means a
 * test measures a tooltip of height 0 and gets "above" for nearly every anchor —
 * the near-top flip, the edge clamps, and the over-tall card only become
 * distinguishable in a real browser, on a real canvas, which is what these are.
 *
 * No `autodocs`: every card portals to `document.body` at `position: fixed`, so a
 * docs page rendering the whole file at once would stack all seven at the same
 * viewport coordinates and none of them would be legible.
 * `activity-bucket-tooltip.stories.tsx` — the first consumer of this hook — omits
 * the tag for exactly the same reason.
 */

/** Where the stand-in control sits, expressed relative to the LIVE viewport
 *  rather than as fixed pixels: "near the right edge" is a statement about the
 *  window, and a hardcoded `left` would mean something different on every canvas
 *  size the story is opened at. */
const TooltipAnchorPreset = {
  LeftEdge: "leftEdge",
  RightEdge: "rightEdge",
  Roomy: "roomy",
  TopEdge: "topEdge",
} as const;
type TooltipAnchorPreset =
  (typeof TooltipAnchorPreset)[keyof typeof TooltipAnchorPreset];

/** The stand-in control's size — a Session Timeline cost bar. */
const BAR_WIDTH = 18;
const BAR_HEIGHT = 64;

/** The single render before {@link ViewportTooltipDemo} has read the viewport.
 *  The hook renders the card hidden until it has measured itself anyway, so this
 *  is the same pre-measurement frame the real strip passes through — not a
 *  placeholder a reader ever sees. */
const UNMEASURED_ANCHOR: TooltipAnchor = {
  bottom: 0,
  height: 0,
  left: 0,
  right: 0,
  top: 0,
  width: 0,
};

/** A rect from a top-left origin, in the shape `getBoundingClientRect` returns. */
function barAnchor(left: number, top: number): TooltipAnchor {
  return {
    bottom: top + BAR_HEIGHT,
    height: BAR_HEIGHT,
    left,
    right: left + BAR_WIDTH,
    top,
    width: BAR_WIDTH,
  };
}

/** Exhaustive by construction: a new preset fails typecheck here rather than
 *  silently falling through to a default anchor. */
const ANCHOR_PRESETS: Readonly<
  Record<TooltipAnchorPreset, (width: number, height: number) => TooltipAnchor>
> = {
  [TooltipAnchorPreset.LeftEdge]: (_width, height) =>
    barAnchor(0, Math.round(height / 2)),
  [TooltipAnchorPreset.RightEdge]: (width, height) =>
    barAnchor(width - BAR_WIDTH, Math.round(height / 2)),
  [TooltipAnchorPreset.Roomy]: (width, height) =>
    barAnchor(Math.round(width / 2 - BAR_WIDTH / 2), Math.round(height / 2)),
  [TooltipAnchorPreset.TopEdge]: (width) =>
    barAnchor(Math.round(width / 2 - BAR_WIDTH / 2), 8),
};

/** The readout cells, queried by the `play` functions. Attributes rather than
 *  text: "above" and "below" are ordinary words that appear in card copy too. */
const PLACEMENT_READOUT = "[data-readout='placement']";
const VISIBILITY_READOUT = "[data-readout='visibility']";

/** An ordinary card body — a couple of lines, the size the shipped
 *  `ActivityBucketTooltip` renders at. */
const SHORT_ROWS = ["claude-opus-4  ·  $6.75", "claude-sonnet-4  ·  $0.46"];

/** A body tall enough to exceed the viewport, so the card's own
 *  `maxHeight: calc(100vh - 24px)` and the top clamp both engage. */
const TALL_ROWS = Array.from(
  { length: 40 },
  (_entry, index) => `bucket ${String(index).padStart(2, "0")}  ·  $0.0${index}`
);

/**
 * The harness: a stand-in control outlined where the anchor says it is, the real
 * portalled card hanging off it, and a readout of what the hook decided.
 *
 * The outline matters. A card floating alone proves nothing — "flipped above"
 * only means something next to the thing it flipped above — so the anchor rect
 * is drawn at the same fixed coordinates the hook was handed.
 */
function ViewportTooltipDemo({
  attached = true,
  caption,
  label,
  preset,
  rows = SHORT_ROWS,
}: Readonly<{
  /**
   * Whether the hook's `ref` reaches the card. Detached, `ref.current` stays
   * null, the layout effect returns before measuring, and the hook holds its
   * initial hidden style — the honest way to pin the pre-measurement frame with
   * the real hook rather than restating `getHiddenTooltipStyle` in a story.
   */
  attached?: boolean;
  caption: string;
  label: string;
  preset: TooltipAnchorPreset;
  rows?: readonly string[];
}>) {
  const [anchor, setAnchor] = useState<TooltipAnchor>(UNMEASURED_ANCHOR);
  const { placement, ref, style } = useViewportTooltipStyle(anchor);

  useLayoutEffect(() => {
    setAnchor(
      ANCHOR_PRESETS[preset](globalThis.innerWidth, globalThis.innerHeight)
    );
  }, [preset]);

  return (
    <div className="flex flex-col gap-3 p-6">
      <p className="max-w-2xl text-muted-foreground text-sm">{caption}</p>
      <dl className="grid max-w-xs grid-cols-2 gap-x-4 text-xs">
        <dt className="text-muted-foreground">placement</dt>
        <dd data-readout="placement">{placement}</dd>
        <dt className="text-muted-foreground">visibility</dt>
        <dd data-readout="visibility">{String(style.visibility)}</dd>
      </dl>
      <div
        aria-hidden
        style={{
          border: "2px solid var(--primary)",
          borderRadius: 2,
          height: anchor.height,
          left: anchor.left,
          pointerEvents: "none",
          position: "fixed",
          top: anchor.top,
          width: anchor.width,
        }}
      />
      <ViewportTooltipPortal>
        <div
          className="sd3-tip"
          data-placement={placement}
          ref={attached ? ref : undefined}
          style={style}
        >
          <div className="sd3-tip-h">
            <b>{label}</b>
          </div>
          {rows.map((row) => (
            <div className="sd3-tip-meta" key={row}>
              {row}
            </div>
          ))}
        </div>
      </ViewportTooltipPortal>
    </div>
  );
}

const meta = {
  title: "Primitives/Overlays/Viewport Tooltip",
  component: ViewportTooltipDemo,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ViewportTooltipDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The default outcome, and the one nearly every hover produces: there is room
 * over the control, so the card hangs ABOVE it and never covers the strip the
 * pointer is moving along.
 */
export const AbovePreferred: Story = {
  args: {
    caption:
      "Room above the control, so the card takes the preferred placement and leaves the strip itself uncovered.",
    label: "14:00 - 14:15",
    preset: TooltipAnchorPreset.Roomy,
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector<HTMLElement>(PLACEMENT_READOUT)
    ).toHaveTextContent("above");
  },
};

/**
 * The flip. The control is 8px from the top of the window, so the preferred
 * placement would put the card off screen entirely — it goes BELOW instead.
 *
 * This is the branch a unit test cannot pin honestly: the decision reads the
 * card's measured height, and in jsdom that is 0, so a test agrees with this
 * story for the wrong reason. Read it in the browser.
 */
export const BelowNearTopEdge: Story = {
  args: {
    caption:
      "No room above: the preferred placement would leave the card off screen, so it flips below the control.",
    label: "00:00 - 00:15",
    preset: TooltipAnchorPreset.TopEdge,
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector<HTMLElement>(PLACEMENT_READOUT)
    ).toHaveTextContent("below");
  },
};

/**
 * The horizontal clamp, left. The card centres on its control, so a control at
 * `left: 0` would put half the card past the window edge. It is clamped to a
 * 12px gutter instead and stops centring — the card is deliberately allowed to
 * sit off-centre rather than be cut off.
 */
export const ClampedToLeftEdge: Story = {
  args: {
    caption:
      "Control flush with the left edge: centring would push half the card off screen, so it clamps to the 12px gutter.",
    label: "First bucket",
    preset: TooltipAnchorPreset.LeftEdge,
  },
};

/**
 * The same clamp, mirrored. This is the edge that actually bites in production —
 * the Session Timeline's last bucket sits at the right of the strip, and it is
 * the widest cards (a multi-model decomposition) that overhang furthest.
 */
export const ClampedToRightEdge: Story = {
  args: {
    caption:
      "Control flush with the right edge, which is where the production strip's last bucket sits and where the widest cards overhang.",
    label: "Last bucket",
    preset: TooltipAnchorPreset.RightEdge,
  },
};

/**
 * A card taller than the window. Two guards engage together: the top clamp keeps
 * the card's head on screen, and its own `maxHeight: calc(100vh - 24px)` makes
 * the body scroll rather than run off the bottom.
 *
 * Reachable in production — a bucket with many models, or a grouped cut with
 * many segments, produces exactly this — and it is the case where getting it
 * wrong silently hides the total the reader came for.
 */
export const TallerThanViewport: Story = {
  args: {
    caption:
      "A card taller than the window: the head stays clamped on screen and the body scrolls, rather than the card running off the bottom.",
    label: "40 buckets",
    preset: TooltipAnchorPreset.Roomy,
    rows: TALL_ROWS,
  },
};

/**
 * The frame before measurement. The hook renders the card HIDDEN and only
 * reveals it once it has measured itself — without that, a card would paint one
 * frame at the wrong coordinates and visibly jump into place on every hover.
 *
 * Pinned by withholding the hook's `ref` from the card, which freezes the real
 * hook in its initial state rather than restating that state in the story. On
 * the canvas: the anchor outline is there, the card is not.
 */
export const HiddenBeforeMeasurement: Story = {
  args: {
    attached: false,
    caption:
      "Pre-measurement: the card is rendered but hidden until the hook has measured it, so a hover never shows it jumping into position.",
    label: "Never painted",
    preset: TooltipAnchorPreset.Roomy,
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector<HTMLElement>(VISIBILITY_READOUT)
    ).toHaveTextContent("hidden");
  },
};

/**
 * ISS-5548's column hit target, which is the other anchor reader this module
 * exports. A `.reach` bar's clickable and outlined region is its `::before` — the
 * whole column — but `getBoundingClientRect()` reports only the element's own
 * border box, so anchoring to that box parks the readout at the column floor
 * while the outline lights up well above it.
 *
 * {@link ReachAnchorStage} lays out a short bar inside a padded, bottom-aligned
 * strip and measures it with {@link getTimelineTooltipAnchor}: the outline on the
 * canvas should cover the whole COLUMN, not the 18px stub at its foot. The
 * helper falls back to the bar's own rect when the strip has no geometry, which
 * is what keeps it safe in jsdom and in the frame before first layout.
 */
export const ReachColumnAnchor: Story = {
  args: {
    caption:
      "Column hit target: the readout hangs off the outlined column the pointer actually lights up, not off the short bar at its foot.",
    label: "Quiet bucket",
    preset: TooltipAnchorPreset.Roomy,
  },
  render: (args) => (
    <ReachAnchorStage caption={args.caption} label={args.label} />
  ),
};

/** The strip's inner height and padding, mirroring the shipped `.sd3-bars2`
 *  geometry the real `::before` hit box resolves against. */
const STRIP_HEIGHT = 120;
const STRIP_PADDING_TOP = 16;

/** A deliberately short bar — the quiet bucket ISS-5548 exists for, where the
 *  column and the bar are furthest apart. */
const SHORT_BAR_HEIGHT = 14;

/**
 * Lays out a real bottom-aligned strip, measures the short bar inside it with
 * {@link getTimelineTooltipAnchor}, and hands the resulting rect to the same
 * hidden-then-measured card path every other story uses.
 */
function ReachAnchorStage({
  caption,
  label,
}: Readonly<{ caption: string; label: string }>) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<TooltipAnchor>(UNMEASURED_ANCHOR);
  const { placement, ref, style } = useViewportTooltipStyle(anchor);

  useLayoutEffect(() => {
    if (barRef.current) {
      setAnchor(getTimelineTooltipAnchor(barRef.current));
    }
  }, []);

  return (
    <div className="flex flex-col gap-3 p-6">
      <p className="max-w-2xl text-muted-foreground text-sm">{caption}</p>
      <div
        style={{
          alignItems: "flex-end",
          display: "flex",
          height: STRIP_HEIGHT,
          paddingTop: STRIP_PADDING_TOP,
        }}
      >
        <div
          className="reach"
          ref={barRef}
          style={{
            background: "var(--muted)",
            borderRadius: 2,
            height: SHORT_BAR_HEIGHT,
            width: BAR_WIDTH,
          }}
        />
      </div>
      <div
        aria-hidden
        style={{
          border: "2px solid var(--primary)",
          borderRadius: 2,
          height: anchor.height,
          left: anchor.left,
          pointerEvents: "none",
          position: "fixed",
          top: anchor.top,
          width: anchor.width,
        }}
      />
      <ViewportTooltipPortal>
        <div
          className="sd3-tip"
          data-placement={placement}
          ref={ref}
          style={style}
        >
          <div className="sd3-tip-h">
            <b>{label}</b>
          </div>
          <div className="sd3-tip-meta">0 events | 0 tool calls</div>
        </div>
      </ViewportTooltipPortal>
    </div>
  );
}
