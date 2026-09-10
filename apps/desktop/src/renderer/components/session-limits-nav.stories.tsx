import { SessionLimitsNav } from "@repo/app/session-limits/components/session-limits-nav";
import {
  type SessionLimits,
  type SessionLimitsState,
  SessionLimitsStatus,
} from "@repo/app/session-limits/types";
import type { ReactNode } from "react";

/**
 * Fixed clock and time zone so the relative labels ("in 3h") and the absolute
 * datetimes are stable across machines and CI, rather than drifting with the
 * snapshot's real age.
 */
const NOW = new Date("2026-07-19T12:00:00.000Z");
const TIME_ZONE = "UTC";

/**
 * PRD-538 R6 (ISS-5354): the sidebar-footer session-limit summary, across the
 * states it must keep apart.
 *
 * The unit tests prove WHICH state is chosen; they cannot prove that the three
 * non-data states look different from each other, and that is the whole claim
 * here. The failure this feature is most exposed to is a bar that renders empty
 * because nothing was fetched and reads exactly like a real 0% — so the loading
 * skeleton, the stale caveat, and a measured zero are all on this canvas
 * together, where a regression that collapsed any two of them would be visible
 * at a glance rather than shipping silently.
 *
 * Rendered in a sidebar-width column with the sidebar's own background, because
 * these bars only ever appear ~14rem wide and a component that looks balanced at
 * page width can still wrap its reset line in the only place it actually ships.
 */
const meta = {
  title: "Composites/App Shell/Session Limits Nav",
  component: SessionLimitsNav,
  tags: ["autodocs"],
  argTypes: {
    state: {
      control: "object",
      description:
        "The four-state snapshot contract. Loading, Unavailable and Ready render differently, so a nullable value cannot stand in for it.",
      table: { category: "Data" },
    },
    now: {
      control: false,
      description: "Injectable clock, so relative labels are stable in CI.",
      table: { category: "Data" },
    },
    timeZone: {
      control: "text",
      description:
        "Injectable time zone, so tests are not hostage to the runner's TZ.",
      table: { category: "Data" },
    },
  },
  args: {
    now: NOW,
    state: ready(baseLimits()),
    timeZone: TIME_ZONE,
  },
  parameters: {
    layout: "centered",
  },
};

export default meta;

function baseLimits(overrides: Partial<SessionLimits> = {}): SessionLimits {
  return {
    fiveHour: { utilization: 42, resetsAt: "2026-07-19T15:00:00.000Z" },
    sevenDay: { utilization: 70, resetsAt: "2026-07-21T12:00:00.000Z" },
    sevenDayOpus: { utilization: 12, resetsAt: "2026-07-21T12:00:00.000Z" },
    sevenDaySonnet: { utilization: 55, resetsAt: "2026-07-21T12:00:00.000Z" },
    extraUsage: {
      isEnabled: true,
      monthlyLimitUsd: 20,
      usedCreditsUsd: 3.5,
      utilization: 17.5,
    },
    fetchedAt: "2026-07-19T11:59:00.000Z",
    source: "usage_api",
    ...overrides,
  };
}

function ready(limits: SessionLimits): SessionLimitsState {
  return { status: SessionLimitsStatus.Ready, limits };
}

/** The sidebar footer's real width and surface, so wrapping is honest. */
function sidebarFrame(children: ReactNode) {
  return (
    <div className="w-56 rounded-md bg-sidebar p-2 text-sidebar-foreground">
      {children}
    </div>
  );
}

/** Populated: both primary bars, recently captured, nothing caveated. */
export const Populated = {
  render: () =>
    sidebarFrame(
      <SessionLimitsNav
        now={NOW}
        state={ready(baseLimits())}
        timeZone={TIME_ZONE}
      />
    ),
};

/**
 * STATE 1 — not yet fetched. A skeleton, deliberately NOT two empty tracks: an
 * empty `Progress` here would be pixel-identical to the genuine-zero story
 * below, which is precisely the lie PRD-538 R6 forbids.
 */
export const Loading = {
  render: () =>
    sidebarFrame(
      <SessionLimitsNav
        now={NOW}
        state={{ status: SessionLimitsStatus.Loading }}
        timeZone={TIME_ZONE}
      />
    ),
};

/**
 * STATE 2 — no subscription credential, so the feature hides itself entirely.
 * The frame renders empty on purpose. This is the COMMON case on macOS, not an
 * edge case: capture never reads the Keychain (PRD-538 R5), so a Keychain-only
 * Claude sign-in lands here. It has a story so that "hidden" stays a reviewed,
 * intentional outcome rather than something only noticed when it regresses into
 * a dead, unclickable affordance.
 */
export const UnavailableNoCredential = {
  render: () =>
    sidebarFrame(
      <SessionLimitsNav
        now={NOW}
        state={{ status: SessionLimitsStatus.Unavailable }}
        timeZone={TIME_ZONE}
      />
    ),
};

/**
 * STATE 3 — a real snapshot that stopped refreshing. The figures still render,
 * because they are real, but they are dated to when they were captured instead
 * of being presented as current.
 */
export const StaleSnapshot = {
  render: () =>
    sidebarFrame(
      <SessionLimitsNav
        now={NOW}
        state={ready(baseLimits({ fetchedAt: "2026-07-19T11:20:00.000Z" }))}
        timeZone={TIME_ZONE}
      />
    ),
};

/**
 * STATE 4 — a measured zero. Empty tracks that mean exactly what they say: this
 * user has used none of either window. Sits next to `Loading` on purpose; if the
 * two ever render alike, the feature has started lying.
 */
export const GenuineZero = {
  render: () =>
    sidebarFrame(
      <SessionLimitsNav
        now={NOW}
        state={ready(
          baseLimits({
            fiveHour: { utilization: 0, resetsAt: "2026-07-19T15:00:00.000Z" },
            sevenDay: { utilization: 0, resetsAt: "2026-07-21T12:00:00.000Z" },
          })
        )}
        timeZone={TIME_ZONE}
      />
    ),
};

/**
 * The LONGEST fallback title ("Current week, Sonnet") beside a three-digit
 * percentage —
 * the widest the summary row can get. This is where the title/percent row runs
 * out of sidebar first, so it is the story that proves the truncation holds
 * rather than the row wrapping or the percentage being pushed off.
 */
export const NarrowestFit = {
  render: () =>
    sidebarFrame(
      <SessionLimitsNav
        now={NOW}
        state={ready(
          baseLimits({
            fiveHour: null,
            sevenDay: null,
            sevenDayOpus: null,
            sevenDaySonnet: {
              utilization: 100,
              resetsAt: "2026-07-21T12:00:00.000Z",
            },
            extraUsage: null,
          })
        )}
        timeZone={TIME_ZONE}
      />
    ),
};

/**
 * A utilization that is not a measurement (a null/NaN across the IPC boundary).
 * `Progress` renders it as an indeterminate hatch and the text reads "Usage
 * unknown" — deliberately NOT an empty track next to "0% used", which would be
 * indistinguishable from `GenuineZero` below.
 */
export const UsageUnknown = {
  render: () =>
    sidebarFrame(
      <SessionLimitsNav
        now={NOW}
        state={ready(
          baseLimits({
            fiveHour: {
              utilization: Number.NaN,
              resetsAt: "2026-07-19T15:00:00.000Z",
            },
          })
        )}
        timeZone={TIME_ZONE}
      />
    ),
};

/**
 * A plan that exposes only the weekly window. The summary must still render one
 * bar rather than an empty trigger — the drawer is the only place the per-model
 * splits and credits are readable, so it has to stay reachable.
 */
export const WeeklyWindowOnly = {
  render: () =>
    sidebarFrame(
      <SessionLimitsNav
        now={NOW}
        state={ready(baseLimits({ fiveHour: null }))}
        timeZone={TIME_ZONE}
      />
    ),
};
