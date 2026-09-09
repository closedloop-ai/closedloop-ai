import type { ReactNode } from "react";
import { SESSION_LIMIT_SOURCES, type SessionLimits } from "../types";
import { SessionLimitsProvenance } from "./session-limits-provenance";

/**
 * Fixed clock and time zone (ISS-5286). Every label here is either a duration
 * measured against `now` or a time zone-formatted instant, so an unpinned story
 * would render differently on every run.
 */
const NOW = new Date("2026-07-19T12:00:00.000Z");
const TIME_ZONE = "UTC";

function provenance(
  fetchedAt: string | null,
  source: SessionLimits["source"] = SESSION_LIMIT_SOURCES.UsageApi
) {
  return { fetchedAt, source };
}

/**
 * PRD-538 R6 (ISS-5354): the detail drawer's provenance footer, across the
 * states it swaps wording for.
 *
 * It renders inside `DrawerContent`, which does not mount until the drawer
 * opens, so the sibling nav story never reaches it. The stale path is the one
 * worth looking at and the one hardest to reach any other way: producing it in
 * the running app means waiting past the five-minute display horizon or moving
 * the clock (wongk, PR #4572).
 *
 * The two wordings are not cosmetic variants. Fresh leads with a duration and
 * puts the instant behind it; stale drops the duration entirely and states the
 * capture time, because a duration keeps drifting while the drawer sits open and
 * a snapshot that stopped refreshing must read as "the figures are from THEN".
 */
const meta = {
  title: "App Core/Session Limits/Session Limits Provenance",
  component: SessionLimitsProvenance,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  argTypes: {
    limits: {
      control: "object",
      description:
        "Just the two provenance fields. `fetchedAt` null renders nothing at all; `source` takes a SESSION_LIMIT_SOURCES value, or null for no tooltip.",
    },
    now: {
      control: false,
      description:
        "Pinned clock the relative freshness label is measured against.",
    },
    timeZone: { control: "text" },
  },
  args: {
    limits: provenance("2026-07-19T11:55:00.000Z"),
    now: NOW,
    timeZone: TIME_ZONE,
  },
};

export default meta;

/** The drawer's width, and the rule the footer hangs beneath. */
function drawerFrame(children: ReactNode) {
  return <div className="w-96 rounded-md bg-background p-4">{children}</div>;
}

/**
 * Current, with a source to reveal. The relative label leads and the absolute
 * instant follows it in parentheses; the dotted underline is the only hint that
 * the producer is available on hover or focus, so it has to be visible without
 * shouting.
 */
export const CurrentWithSource = {
  render: () =>
    drawerFrame(
      <SessionLimitsProvenance
        limits={provenance("2026-07-19T11:55:00.000Z")}
        now={NOW}
        timeZone={TIME_ZONE}
      />
    ),
};

/**
 * Current, with no source recorded. No tooltip affordance at all rather than an
 * empty one: a dotted underline promising a detail that does not exist is a
 * control that lies about what it does.
 */
export const CurrentWithoutSource = {
  render: () =>
    drawerFrame(
      <SessionLimitsProvenance
        limits={provenance("2026-07-19T11:55:00.000Z", null)}
        now={NOW}
        timeZone={TIME_ZONE}
      />
    ),
};

/**
 * Stale: 40 minutes old, well past the five-minute display horizon. The relative
 * duration is gone and the wording is the same "As of ..." the sidebar caveat
 * uses, from the same selector, so the drawer and the footer above it cannot
 * describe the same snapshot's currency two different ways.
 */
export const Stale = {
  render: () =>
    drawerFrame(
      <SessionLimitsProvenance
        limits={provenance("2026-07-19T11:20:00.000Z")}
        now={NOW}
        timeZone={TIME_ZONE}
      />
    ),
};

/** Stale and sourceless: the caveat still leads, still with no false tooltip. */
export const StaleWithoutSource = {
  render: () =>
    drawerFrame(
      <SessionLimitsProvenance
        limits={provenance("2026-07-19T11:20:00.000Z", null)}
        now={NOW}
        timeZone={TIME_ZONE}
      />
    ),
};

/**
 * No capture time: renders nothing, and the canvas is empty on purpose. A footer
 * saying "Updated" with nothing after it, or a border rule under no content,
 * would both be affordances for information the snapshot does not carry. This
 * has a story so "renders nothing" stays a reviewed outcome rather than
 * something noticed only when it regresses into an empty bordered strip.
 */
export const NoCaptureTime = {
  render: () =>
    drawerFrame(
      <SessionLimitsProvenance
        limits={provenance(null)}
        now={NOW}
        timeZone={TIME_ZONE}
      />
    ),
};
