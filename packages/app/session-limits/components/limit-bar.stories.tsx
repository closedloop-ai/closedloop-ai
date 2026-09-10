import type { ReactNode } from "react";
import type { RateLimit } from "../types";
import { LimitBar } from "./limit-bar";

/**
 * Fixed clock and time zone (ISS-5286). The reset line is relative ("in 3h") and
 * the absolute variant is time-zone formatted, so an unpinned story would render
 * differently on every run and on every machine.
 */
const NOW = new Date("2026-07-19T12:00:00.000Z");
const TIME_ZONE = "UTC";
const RESETS_AT = "2026-07-19T15:00:00.000Z";

function limit(utilization: number, resetsAt: string | null = RESETS_AT) {
  return { utilization, resetsAt } satisfies RateLimit;
}

/**
 * PRD-538 R6 (ISS-5354): one usage meter, across the urgency scale it colours
 * itself by.
 *
 * The scale is the one signal a user near their cap actually reads, and it is
 * the hardest thing here to see any other way: the rendered text is identical at
 * 74% and at 91%, so a DOM assertion has to reach for a class name, and
 * reproducing it live needs an account genuinely sitting near its ceiling. A
 * canvas with every band on it at once turns "did the colour still change" into
 * a glance (wongk, PR #4572).
 *
 * `showResetDateTime` gets a canvas for the same reason. The drawer turns it on
 * and the sidebar leaves it off, so the two renderings of the same reset moment
 * only ever appear in different places in the real app and can drift apart
 * without either one looking wrong on its own.
 */
const meta = {
  title: "Composites/Sessions/Detail/Limit Bar",
  component: LimitBar,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  argTypes: {
    className: { control: false },
    limit: {
      control: "object",
      description:
        "The window this meter draws. A non-finite `utilization` is the honest unknown, and renders the hatch rather than a measured zero.",
    },
    now: {
      control: false,
      description: "Pinned clock the relative reset label is measured against.",
    },
    showResetDateTime: { control: "boolean" },
    subtext: { control: "text" },
    timeZone: { control: "text" },
    title: { control: "text" },
  },
  args: {
    limit: limit(42),
    now: NOW,
    showResetDateTime: false,
    subtext: null,
    timeZone: TIME_ZONE,
    title: "Current session",
  },
};

export default meta;

/**
 * The sidebar footer's real width and surface. These bars only ever ship ~14rem
 * wide, and a meter that looks balanced at page width can still wrap its reset
 * line in the only place it actually appears.
 */
function sidebarFrame(children: ReactNode) {
  return (
    <div className="w-56 rounded-md bg-sidebar p-2 text-sidebar-foreground">
      {children}
    </div>
  );
}

/** The drawer's width, where the absolute reset time has room to sit inline. */
function drawerFrame(children: ReactNode) {
  return <div className="w-96 rounded-md bg-background p-4">{children}</div>;
}

/**
 * The whole scale in one canvas, which is the point of this file. Neutral holds
 * everything below 75, amber takes over at 75, red at 90 — with both sides of
 * each threshold present so a boundary that slipped by one is visible rather
 * than merely untested.
 */
export const UrgencyScale = {
  render: () =>
    sidebarFrame(
      <div className="flex flex-col gap-3">
        <LimitBar
          limit={limit(20)}
          now={NOW}
          timeZone={TIME_ZONE}
          title="Resting (20%)"
        />
        <LimitBar
          limit={limit(74)}
          now={NOW}
          timeZone={TIME_ZONE}
          title="Just under warning (74%)"
        />
        <LimitBar
          limit={limit(75)}
          now={NOW}
          timeZone={TIME_ZONE}
          title="Warning (75%)"
        />
        <LimitBar
          limit={limit(89)}
          now={NOW}
          timeZone={TIME_ZONE}
          title="Just under destructive (89%)"
        />
        <LimitBar
          limit={limit(90)}
          now={NOW}
          timeZone={TIME_ZONE}
          title="Destructive (90%)"
        />
        <LimitBar
          limit={limit(100)}
          now={NOW}
          timeZone={TIME_ZONE}
          title="At the ceiling (100%)"
        />
      </div>
    ),
};

/** The resting band, which is where these bars sit almost all of the time. */
export const Resting = {
  render: () =>
    sidebarFrame(
      <LimitBar
        limit={limit(42)}
        now={NOW}
        timeZone={TIME_ZONE}
        title="Current session"
      />
    ),
};

/** Past 75%: close enough that the colour is doing the warning, not the length. */
export const Warning = {
  render: () =>
    sidebarFrame(
      <LimitBar
        limit={limit(78)}
        now={NOW}
        timeZone={TIME_ZONE}
        title="Current session"
      />
    ),
};

/** Past 90%: about to be cut off, which is the only question this bar answers. */
export const Destructive = {
  render: () =>
    sidebarFrame(
      <LimitBar
        limit={limit(94)}
        now={NOW}
        timeZone={TIME_ZONE}
        title="Current session"
      />
    ),
};

/**
 * A utilization that is not a measurement. The track carries a hatch rather than
 * a fill, held still rather than sweeping, in the quietest tone available — an
 * amount nobody measured must not read as a measured zero, as work still in
 * flight, or as any particular severity.
 */
export const UsageUnknown = {
  render: () =>
    sidebarFrame(
      <LimitBar
        limit={limit(Number.NaN, null)}
        now={NOW}
        timeZone={TIME_ZONE}
        title="Current session"
      />
    ),
};

/**
 * `showResetDateTime`, which only the drawer turns on. The relative label keeps
 * its place and the absolute moment follows it, so "in 3h" is still answerable
 * without doing the arithmetic. The sidebar leaves this off because the absolute
 * time wraps at ~14rem; compare against `Resting` above.
 */
export const WithResetDateTime = {
  render: () =>
    drawerFrame(
      <LimitBar
        limit={limit(78)}
        now={NOW}
        showResetDateTime
        timeZone={TIME_ZONE}
        title="Current session"
      />
    ),
};

/**
 * The drawer's fullest row: a credit summary ahead of the reset text, at a
 * warning-band utilization. The subtext and the reset line share one line box,
 * so this is where they are most likely to collide.
 */
export const WithSubtextAndResetDateTime = {
  render: () =>
    drawerFrame(
      <LimitBar
        limit={limit(82)}
        now={NOW}
        showResetDateTime
        subtext="$3.50 of $20.00"
        timeZone={TIME_ZONE}
        title="Extra usage"
      />
    ),
};
