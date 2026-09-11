import type { Meta, StoryObj } from "@storybook/react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import type { DotColor } from "./activity-dot-rendering";
import type { ActivityMarker } from "./session-timeline-axis";
import { EventDotTooltip } from "./session-timeline-strip-parts";
import { getTooltipAnchor, type TooltipAnchor } from "./viewport-tooltip";

// The Session Timeline's PER-DOT event card.
// ISS-5819 (#4753 review, krisw-story-reviewer): `EventDotTooltip` was promoted
// to an exported module in this PR, and its opposite number two files over
// (`ActivityBucketTooltip`) has carried its own story file since ISS-5563 for
// exactly the reasons that apply here — the card is reachable in the real strip
// only by hovering one 6px dot, and the populated parent-view story documents
// the rail's hover STATE without ever rendering the card's contents.
// What each story is for:
// - {@link SingleEvent} — the common case, and the one that pins the ABSENCE of
//   the count line: "N events" appears only past one, so a card that always
//   printed it would read "1 events" and go unnoticed in a screenshot.
// - {@link MultipleEvents} — the count line present, and the list's own rhythm
//   with several rows in one lane.
// - {@link LongMixedList} — the wrapping and overflow question, which is the
//   only thing here that cannot be judged from the markup: long labels of mixed
//   kinds in one card, at the width the real surface gives it.
// No `autodocs` tag, matching `activity-bucket-tooltip.stories.tsx`: this card
// portals to `document.body` at `position: fixed`, so a docs page rendering
// every story at once would stack them all on the same viewport coordinates.
/**
 * The hover card for one dot on the Session Timeline's event rail, listing
 * the events, such as prompts, commits or failures, that happened in that
 * moment with their time and a short label. Reach for it only within that
 * timeline; it is the event rail's counterpart to the Activity Bucket
 * Tooltip, which is the hover card for the timeline's cost bars instead of
 * its event dots. A count like '4 events' only appears once more than one
 * event sits behind the dot, so a single event never gets mislabeled as a
 * count of one.
 */
const meta = {
  title: "Primitives/Overlays/Session Timeline Event Dot Tooltip",
  component: EventDotTooltip,
  tags: ["autodocs"],
  argTypes: {
    anchor: { control: "object" },
    /*
     * `DotColor` is a bare union with no companion array anywhere in the repo
     * (the rail's own `DOT_ORDER` is module-private), so these are copied from
     * the union itself: b human steering, g commits and PRs, r failures and
     * limits.
     */
    color: { control: "radio", options: ["b", "g", "r"] },
    events: { control: "object" },
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EventDotTooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The `anchor` arg's starting value: a zero rect, used for the single render
 * before {@link EventDotStage} has measured the stand-in dot. The card renders
 * hidden until it has measured itself, so this is the same pre-measurement state
 * the real strip passes through rather than a placeholder anyone sees.
 */
const UNMEASURED_ANCHOR: TooltipAnchor = {
  bottom: 0,
  height: 0,
  left: 0,
  right: 0,
  top: 0,
  width: 0,
};

/**
 * One event in the blue "human steering" lane. The head names the LANE, not the
 * event — the card is opened from a lane's dot, and the rows below it are what
 * the lane actually holds — and with a single event there is no count line.
 */
export const SingleEvent: Story = {
  args: {
    anchor: UNMEASURED_ANCHOR,
    color: "b",
    events: [
      dotEvent("prompt", "Try the desktop adapter instead", "9:05 AM", 412),
    ],
  },
  render: (args) => (
    <EventDotStage
      {...args}
      caption="One event: the head names the lane, and there is no count line — 'N events' appears only past one, so a card that always printed it would read '1 events'."
    />
  ),
};

/**
 * Several events behind one dot, which is the ordinary state at a coarse scale:
 * the rail draws ONE dot per lane per column however many events fell in it, so
 * the card is where the reader finds out it was four rather than one.
 */
export const MultipleEvents: Story = {
  args: {
    anchor: UNMEASURED_ANCHOR,
    color: "r",
    events: [
      dotEvent("fail", "CI failed — flaky seed", "9:12 AM", 501),
      dotEvent("limit", "Throttled for 5m", "9:14 AM", 508),
      dotEvent("fail", "Retry failed — same seed", "9:19 AM", 530),
      dotEvent("limit", "Throttled for 5m", "9:21 AM", 537),
    ],
  },
  render: (args) => (
    <EventDotStage
      {...args}
      caption="Four events behind one dot, which is ordinary at a coarse scale: the rail draws one dot per lane per column however many events fell in it. The count line is what tells the reader that."
    />
  ),
};

/**
 * The wrapping and overflow case, which is the only question here the markup
 * cannot answer on its own: long labels, mixed kinds, in one card. A transcript
 * summary is free text and routinely runs past the card's width.
 */
export const LongMixedList: Story = {
  args: {
    anchor: UNMEASURED_ANCHOR,
    color: "g",
    events: [
      dotEvent(
        "commit",
        "refactor(sessions): move the timeline strip's presentational parts into a sibling module so the grandfathered detail view keeps shrinking",
        "9:31 AM",
        604
      ),
      dotEvent(
        "pr",
        "ISS-5819: give the Session Timeline a clock window and its three controls",
        "9:33 AM",
        611
      ),
      dotEvent("commit", "fix: exact locator", "9:36 AM", 620),
    ],
  },
  render: (args) => (
    <EventDotStage
      {...args}
      caption="Long, mixed-kind labels in one card — a transcript summary is free text and routinely overruns. This is the wrapping/overflow check the markup cannot answer for itself."
    />
  ),
};

/**
 * The card is anchored to a viewport rect, not to a parent box, so a story that
 * rendered it bare would float it against the canvas origin with nothing to read
 * it against. This stage puts a stand-in DOT on screen, measures it with the
 * same {@link getTooltipAnchor} the real rail uses, and hands the rect over — so
 * each story shows the card where a hover would put it, and the flip/clamp logic
 * runs for real. Mirrors `activity-bucket-tooltip.stories.tsx`'s stage.
 */
function EventDotStage({
  anchor: initialAnchor,
  caption,
  color,
  events,
}: Readonly<{
  anchor: TooltipAnchor;
  caption: ReactNode;
  color: DotColor;
  events: Omit<ActivityMarker, "x">[];
}>) {
  const dotRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<TooltipAnchor>(initialAnchor);

  useLayoutEffect(() => {
    if (dotRef.current) {
      setAnchor(getTooltipAnchor(dotRef.current));
    }
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minHeight: "60vh",
        padding: 24,
      }}
    >
      <p style={{ fontSize: 13, margin: 0, maxWidth: "48rem", opacity: 0.75 }}>
        {caption}
      </p>
      {/* A stand-in for one dot, at the size the rail actually draws. */}
      <div className={`sd3-dot d-${color}`} ref={dotRef} />
      <EventDotTooltip anchor={anchor} color={color} events={events} />
    </div>
  );
}

function dotEvent(
  kind: ActivityMarker["kind"],
  label: string,
  t: string,
  row: number
): Omit<ActivityMarker, "x"> {
  return { kind, label, t, tl: row };
}
