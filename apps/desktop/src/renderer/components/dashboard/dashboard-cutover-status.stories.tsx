import {
  CloudReadCutoverBlocker,
  type CloudReadCutoverDecision,
  CloudReadCutoverLatch,
  DesktopAppCoreMode,
} from "../../shared-agent-sessions/desktop-app-core-mode";
import { DashboardCutoverStatus } from "./dashboard-cutover-status";

/**
 * ISS-5477: the visible half of the read-source hold — the dashboard header's
 * "we are still uploading, here is how much is left" line.
 *
 * Worth fixtures because this only appears during a live first-run sync drain,
 * which is a narrow window to catch in the running app, and because its whole
 * job is a count: a garbled or missing remainder is the regression, and the
 * unit test asserts the show/hide branches rather than the rendered text.
 *
 * The `cutover` prop is the story/test seam over the
 * `DesktopAppCoreProvider`-injected decision (same convention as
 * `agents-view.tsx`'s `dataSource`), so each branch can be pinned directly.
 *
 * Shares its shape deliberately with `ScanStatus` in `dashboard-header-actions`
 * — same row, same muted mono, same pulse dot, same live region — because the
 * two are the same kind of statement about work in progress and only one of
 * them is ever on screen at a time.
 */
const meta = {
  title: "Primitives/Feedback & Status/Cutover Status",
  component: DashboardCutoverStatus,
  tags: ["autodocs"],
  argTypes: {
    analyzing: { control: "boolean" },
    cutover: {
      control: "object",
      description:
        "Overrides the provider-injected decision. `blocker` and `mode` decide whether the line speaks at all.",
    },
  },
  parameters: { layout: "padded" },
};

export default meta;

function decision(
  overrides: Partial<CloudReadCutoverDecision> = {}
): CloudReadCutoverDecision {
  return {
    blocker: CloudReadCutoverBlocker.SyncDraining,
    cloudHoldsHistory: false,
    deadLetteredCount: 0,
    failedOpen: false,
    itemsRemaining: 3401,
    latch: CloudReadCutoverLatch.None,
    mode: DesktopAppCoreMode.Local,
    ...overrides,
  };
}

/**
 * The main event: the backlog is draining and the wait has a legible size.
 * "Uploading history" is the announced part; the count is `aria-hidden` because
 * it refetches while the drain runs and would otherwise re-announce constantly.
 */
export const Draining = {
  args: {
    analyzing: false,
    cutover: decision(),
  },
};

/**
 * A lane that cannot measure what it owes reports `itemsRemaining: null`. An
 * unmeasured remainder is NOT a zero, so the line says nothing about size
 * rather than claiming "0 to go" — the reassuring number that would silently
 * omit a whole lane.
 */
export const DrainingWithoutCount = {
  args: {
    analyzing: false,
    cutover: decision({ itemsRemaining: null }),
  },
};

/** A single remaining item — the count is rendered verbatim, not pluralised prose. */
export const DrainingLastItem = {
  args: {
    analyzing: false,
    cutover: decision({ itemsRemaining: 1 }),
  },
};

/**
 * A lane that has not established that it owes nothing. Still genuinely "we are
 * working on it", so it speaks — with whatever remainder is known.
 */
export const SyncNotEstablished = {
  args: {
    analyzing: false,
    cutover: decision({
      blocker: CloudReadCutoverBlocker.SyncNotEstablished,
      itemsRemaining: 12,
    }),
  },
};

/**
 * Hidden: `ScanStatus` owns the scan phase and says the same thing better, so
 * the two never stack in one header row. Renders nothing.
 */
export const HiddenWhileAnalyzing = {
  args: {
    analyzing: true,
    cutover: decision(),
  },
};

/**
 * Hidden: offline is not progress. A pulsing "we're working on it" line here
 * would be a lie about work that is not happening.
 */
export const HiddenWhenOffline = {
  args: {
    analyzing: false,
    cutover: decision({ blocker: CloudReadCutoverBlocker.Offline }),
  },
};

/**
 * Hidden: already cut over. The badge's own detail covers the catching-up case,
 * and a header line about a view that IS the workspace would just be nagging.
 */
export const HiddenOnceCutOver = {
  args: {
    analyzing: false,
    cutover: decision({ mode: DesktopAppCoreMode.Cloud }),
  },
};
