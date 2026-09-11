import type { ReactNode } from "react";
import { SESSION_LIMIT_SOURCES, type SessionLimits } from "../types";
import { SessionLimitsDetail } from "./session-limits-detail";

/**
 * Fixed clock and time zone (ISS-5286). Every row carries a reset time rendered
 * both relatively and absolutely, so both have to be pinned or the canvas drifts
 * with the wall clock and the runner's zone.
 */
const NOW = new Date("2026-07-19T12:00:00.000Z");
const TIME_ZONE = "UTC";

function limits(overrides: Partial<SessionLimits> = {}): SessionLimits {
  return {
    fiveHour: { utilization: 42, resetsAt: "2026-07-19T15:00:00.000Z" },
    sevenDay: { utilization: 70, resetsAt: "2026-07-21T12:00:00.000Z" },
    sevenDayOpus: null,
    sevenDaySonnet: null,
    extraUsage: null,
    fetchedAt: "2026-07-19T11:55:00.000Z",
    source: SESSION_LIMIT_SOURCES.UsageApi,
    ...overrides,
  };
}

// PRD-538 R6 (ISS-5354): the drawer's contents, across the plan shapes it has
// to render.
// It lives inside `DrawerContent`, which does not mount until the drawer opens,
// so none of the sibling nav stories reach it — the skeleton and the stale
// caveat get covered there only because they sit in the closed trigger. Which
// rows exist is entirely plan-driven, and the row set is the thing most likely
// to look wrong without being wrong in a unit assertion: a per-model week
// duplicating the all-models week, extra usage appearing at $0, the empty state
// arriving as a bare drawer (wongk, PR #4572).
/**
 * The full list of usage bars inside the session limits drawer: one row for
 * each rate-limit window your plan has, such as the five hour window, the
 * weekly window, and any per-model weekly windows, plus extra usage credits
 * if you have them. Which rows appear depends entirely on your plan, so the
 * set of bars you see is not fixed from account to account. It is read-only,
 * with no controls of its own, and when your plan has nothing to show it
 * renders a sentence explaining why rather than leaving the drawer empty.
 */
const meta = {
  title: "Primitives/Feedback & Status/Session Limits Detail",
  component: SessionLimitsDetail,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  argTypes: {
    limits: {
      control: "object",
      description:
        "The snapshot. Which rows exist is entirely plan-driven: null out a window to drop its row.",
    },
    now: {
      control: false,
      description:
        "Pinned clock the relative reset and freshness labels are measured against.",
    },
    timeZone: { control: "text" },
  },
  args: {
    limits: limits(),
    now: NOW,
    timeZone: TIME_ZONE,
  },
};

export default meta;

/** The drawer's own width, which is where this content actually ships. */
function drawerFrame(children: ReactNode) {
  return <div className="w-96 rounded-md bg-background p-4">{children}</div>;
}

/** The common plan: the two primary windows, and nothing it does not have. */
export const PrimaryWindows = {
  render: () =>
    drawerFrame(
      <SessionLimitsDetail limits={limits()} now={NOW} timeZone={TIME_ZONE} />
    ),
};

/**
 * Every row at once: both primary windows, the per-model split, and extra usage
 * with its credit summary. This is the densest the drawer gets, and the canvas
 * that shows whether the four week-family names still read as variants of one
 * thing rather than as unrelated rows.
 */
export const EveryWindow = {
  render: () =>
    drawerFrame(
      <SessionLimitsDetail
        limits={limits({
          sevenDaySonnet: {
            utilization: 55,
            resetsAt: "2026-07-21T12:00:00.000Z",
          },
          sevenDayOpus: {
            utilization: 12,
            resetsAt: "2026-07-21T12:00:00.000Z",
          },
          extraUsage: {
            isEnabled: true,
            monthlyLimitUsd: 20,
            usedCreditsUsd: 3.5,
            utilization: 17.5,
          },
        })}
        now={NOW}
        timeZone={TIME_ZONE}
      />
    ),
};

/**
 * A subset-window plan: the per-model week is the ONLY thing this account has.
 * This is the shape behind the sidebar's fallback bar, and the reason the
 * per-model rows keep their full "Current week, Sonnet" name in both places —
 * with no all-models row beside it, a shortened name would be a second name.
 */
export const SonnetWeekOnly = {
  render: () =>
    drawerFrame(
      <SessionLimitsDetail
        limits={limits({
          fiveHour: null,
          sevenDay: null,
          sevenDaySonnet: {
            utilization: 55,
            resetsAt: "2026-07-21T12:00:00.000Z",
          },
        })}
        now={NOW}
        timeZone={TIME_ZONE}
      />
    ),
};

/**
 * Extra usage enabled, and the one row whose bar has no reset moment at all —
 * credits are a monthly ceiling, not a rolling window. The credit summary takes
 * the slot the "Resets ..." text occupies everywhere else, which is the layout
 * worth eyeballing.
 */
export const ExtraUsageEnabled = {
  render: () =>
    drawerFrame(
      <SessionLimitsDetail
        limits={limits({
          extraUsage: {
            isEnabled: true,
            monthlyLimitUsd: 20,
            usedCreditsUsd: 3.5,
            utilization: 17.5,
          },
        })}
        now={NOW}
        timeZone={TIME_ZONE}
      />
    ),
};

/**
 * A stale snapshot. The rows keep their real figures — they are real, just not
 * current — and the footer swaps from a drifting duration to the capture time.
 * Awkward to reach in the running app, which is exactly why it is here.
 */
export const StaleSnapshot = {
  render: () =>
    drawerFrame(
      <SessionLimitsDetail
        limits={limits({ fetchedAt: "2026-07-19T11:20:00.000Z" })}
        now={NOW}
        timeZone={TIME_ZONE}
      />
    ),
};

/**
 * Nothing resolved: a sentence explaining why, not an empty drawer. The user
 * opened this deliberately, so silence would read as broken; the copy names the
 * plan requirement rather than reporting a fetch outcome nobody asked about.
 */
export const NothingAvailable = {
  render: () =>
    drawerFrame(
      <SessionLimitsDetail
        limits={limits({ fiveHour: null, sevenDay: null })}
        now={NOW}
        timeZone={TIME_ZONE}
      />
    ),
};
