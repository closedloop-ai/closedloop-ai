import { Button } from "@repo/design-system/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@repo/design-system/components/ui/drawer";
import { formatUsedLabel } from "../lib/format";
import { selectSessionLimitStaleCaveat } from "../lib/freshness";
import { selectSummaryBars } from "../lib/summary-bars";
import {
  hasAnySessionLimit,
  type SessionLimits,
  type SessionLimitsState,
  SessionLimitsStatus,
} from "../types";
import { SessionLimitsBars } from "./session-limits-bars";
import { SessionLimitsDetail } from "./session-limits-detail";
import { SessionLimitsLoading } from "./session-limits-loading";
import { SessionLimitsStaleNote } from "./session-limits-stale-note";

export type SessionLimitsNavProps = {
  /**
   * The four-state snapshot contract, not a nullable value: "still fetching"
   * and "nothing to show" are different answers and this component renders them
   * differently (PRD-538 R6).
   */
  state: SessionLimitsState;
  now?: Date;
  /** Injectable time zone so tests are not hostage to the runner's TZ. */
  timeZone?: string;
};

/**
 * Sidebar-footer entry point (PRD-538): the compact two-bar summary, clickable
 * to open a read-only detail drawer.
 *
 * The three non-data states are deliberately distinct:
 *  - LOADING renders a skeleton, never an empty bar that would read as 0%.
 *  - UNAVAILABLE renders nothing at all, so a user with no subscription
 *    credential sees no dead affordance. This is the COMMON case on macOS, not
 *    an edge case: the capture path never reads the Keychain (PRD-538 R5), so a
 *    Keychain-only sign-in lands here.
 *  - READY-but-stale renders the real figures, dated to when they were captured.
 *
 * A genuine 0% is none of the above — it is READY data and renders as a real,
 * empty bar.
 *
 * Each branch owns its own padding rather than inheriting a wrapper from the
 * sidebar, so the "render nothing" branches leave no padded gap behind.
 */
export function SessionLimitsNav({
  state,
  now,
  timeZone,
}: SessionLimitsNavProps) {
  if (state.status === SessionLimitsStatus.Loading) {
    return (
      <div className="px-2 pb-1">
        {/* The inner padding mirrors the trigger's own `px-2 py-1.5` below.
            Without it the whole block slid 8px right and 6px down the moment
            the snapshot landed, which is precisely the jump the skeleton is
            here to avoid. */}
        <div className="px-2 py-1.5">
          <SessionLimitsLoading />
        </div>
      </div>
    );
  }
  if (state.status === SessionLimitsStatus.Unavailable) {
    return null;
  }
  if (!hasAnySessionLimit(state.limits)) {
    return null;
  }

  return (
    <div className="px-2 pb-1">
      <SessionLimitsNavReady
        limits={state.limits}
        now={now}
        timeZone={timeZone}
      />
    </div>
  );
}

type SessionLimitsNavReadyProps = {
  limits: SessionLimits;
  now?: Date;
  timeZone?: string;
};

/** The populated summary + its detail drawer, once a snapshot exists. */
function SessionLimitsNavReady({
  limits,
  now,
  timeZone,
}: SessionLimitsNavReadyProps) {
  return (
    <Drawer>
      <DrawerTrigger
        aria-label={summaryAccessibleName(limits, now, timeZone)}
        className="flex w-full flex-col gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent"
        data-testid="session-limits-nav-trigger"
        type="button"
      >
        <SessionLimitsBars limits={limits} now={now} timeZone={timeZone} />
        <SessionLimitsStaleNote
          fetchedAt={limits.fetchedAt}
          now={now}
          timeZone={timeZone}
        />
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Session limits</DrawerTitle>
          <DrawerDescription>
            How much of your Claude subscription you have used.
          </DrawerDescription>
        </DrawerHeader>
        <div className="px-4">
          <SessionLimitsDetail limits={limits} now={now} timeZone={timeZone} />
        </div>
        {/* A modal dialog needs a visible way out, not only the Escape key and
            an overlay click — and without a focusable child the focus scope has
            nowhere to land on open, leaving keyboard users behind the trap. */}
        <DrawerFooter className="sm:flex-row sm:justify-end">
          <DrawerClose asChild>
            <Button className="sm:w-auto" variant="outline">
              Close
            </Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * The trigger's accessible name, built from the same figures AND the same
 * freshness verdict it draws.
 *
 * An `aria-label` on a button replaces its whole subtree for name computation,
 * so the per-bar labels and the "42% used" text inside it are never announced —
 * a static "View session limits" left a screen-reader user having to open the
 * drawer to learn a number a sighted user reads at a glance. Sourced from
 * {@link selectSummaryBars} so the spoken figures and the drawn ones are the
 * same selection.
 *
 * The stale caveat has to be spoken here for the same reason, and it matters
 * more than the figures do. {@link SessionLimitsStaleNote} renders inside this
 * button, so the label was swallowing it: the one state built to stop the UI
 * claiming currency was invisible to the only user who cannot see the caveat
 * sitting right there, leaving them with figures presented as current that are
 * not. It comes from {@link selectSessionLimitStaleCaveat}, the same selector
 * the visible note uses, so the spoken and drawn versions cannot disagree about
 * whether these numbers are from now.
 */
function summaryAccessibleName(
  limits: SessionLimits,
  now: Date | undefined,
  timeZone: string | undefined
): string {
  const parts = selectSummaryBars(limits).map((bar) => {
    const used = formatUsedLabel(bar.limit.utilization) ?? "usage unknown";
    return `${bar.title} ${used}`;
  });
  const caveat = selectSessionLimitStaleCaveat(limits.fetchedAt, now, timeZone);
  if (parts.length === 0) {
    return caveat
      ? `View session limits. ${caveat.label}`
      : "View session limits";
  }
  const summary = `Session limits: ${parts.join(", ")}`;
  return caveat
    ? `${summary}. ${caveat.label}. View details`
    : `${summary}. View details`;
}
