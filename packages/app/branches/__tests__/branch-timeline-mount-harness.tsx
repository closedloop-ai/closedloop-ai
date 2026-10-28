// Side-effect only. The timeline header's Radix `ToggleGroup` needs the jsdom
// pointer-capture shims to accept a real click, and neither adapter suite loads
// them: `apps/app` hand-rolls scrollIntoView + matchMedia only, `apps/desktop`
// declares no `setupFiles`. Imported here rather than added to either global
// setup so the shims reach these specs without changing what passing suites
// already measure.
import "../../../typescript-config/vitest-jsdom-setup";
import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
} from "@repo/api/src/types/branch-trace";
import { BranchDetailTabParam } from "@repo/api/src/types/notification-routes";
import { fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
// Cross-slice by design: `shared/storybook` owns the provider stack both shells
// inject, and a feature slice is allowed to depend on `shared/*`.
import { AppCoreStoryProviders } from "../../shared/storybook/decorators";
import type { BranchesDataSource } from "../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../data-source/provider";
import { makeBranchDetail, makeBranchSession } from "./branch-fixtures";

/**
 * ISS-8771 — the provider scaffold a Branch-timeline ADAPTER spec needs to mount
 * the REAL `BranchDetailPage` → `BranchSessionsTimelineTab` on each shell.
 *
 * Shared rather than inlined into one spec because the requirement is
 * per-SURFACE (#6566 review, whitlockk): both shells select `12h` today without
 * asserting anything about where the column lands, so neither would notice the
 * axis returning to the epoch grid. A web-only spec proves nothing about the
 * Electron renderer, and a second copy of the fixture is how the two surfaces'
 * expectations drift apart.
 *
 * WHAT AN ADAPTER SPEC ADDS OVER THE PACKAGE SUITE, stated so the claim is not
 * larger than the coverage. The grid arithmetic itself is pinned in
 * `branches/lib/__tests__/branch-timeline-canonical-window.test.ts`; neither
 * shell passes a scale, window, or grid prop, so there is no seam through which
 * the two could compute different columns. What these specs pin is the RENDER
 * PATH: that each shell's own module resolution, provider set, and jsdom setup
 * actually deliver the canonical axis to a reader who selects `12h`. A shell
 * that stubbed the tab, wrapped it in a local timeline, or reintroduced a
 * per-call column override would keep the package suite green and red these.
 */
export function BranchTimelineMountHarness({
  children,
  dataSource = loadedTraceBranchesSource,
}: {
  children: ReactNode;
  /** Replaces the loaded-trace source, e.g. to serve a failed hydration. */
  dataSource?: BranchesDataSource;
}) {
  return (
    <AppCoreStoryProviders>
      <BranchesDataSourceProvider dataSource={dataSource}>
        {children}
      </BranchesDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

/**
 * The timeline tab fetches its trace lazily through the data-source port, and
 * `detailForLoadedTimelineSessions` charts only the Sessions the trace reports
 * LOADED. Without an injected source the harness transport answers a generic
 * success, every Session reads unloaded, and the tab honestly renders its
 * no-bars message — so a spec that skipped this would assert "every bar is on
 * the local half-day" over zero bars and pass against any grid.
 *
 * `items` is deliberately EMPTY: the fixture's span is carried by the Session's
 * own `startedAt`/`endedAt`, so a burst covers the whole run rather than
 * collapsing onto whichever instants a trace row happened to carry.
 */
const loadedTraceBranchesSource: BranchesDataSource = {
  scope: "branch-timeline-mount-harness",
  analytics: () => Promise.reject(new Error("analytics unused")),
  comments: () => Promise.reject(new Error("comments unused")),
  detail: () => Promise.reject(new Error("detail unused")),
  list: () => Promise.reject(new Error("list unused")),
  pageData: () => Promise.reject(new Error("pageData unused")),
  trace: (id: string) =>
    Promise.resolve({
      aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
      completeness: { state: BranchTraceCompletenessState.Complete },
      items: [],
      qualifyingSessionCount: 1,
      sessions: [
        {
          identity: {
            artifactId: CANONICAL_GRID_SESSION_ID,
            name: null,
            navigableRef: id,
            slug: null,
          },
          state: BranchTraceSessionHydrationState.Loaded,
        },
      ],
    }),
  usage: () => Promise.reject(new Error("usage unused")),
};

/**
 * +05:30 — the discriminator. Its local half-days are 18:30Z and 06:30Z, which
 * no UTC `12h` boundary ever equals, so a column floored on the epoch cannot
 * coincidentally satisfy the assertion. In UTC every grid agrees and the spec
 * would pass against the arithmetic it exists to catch.
 */
export const CANONICAL_GRID_TIMEZONE = "Asia/Kolkata";

/**
 * The `12h` scale control's accessible name, and the only two clock readings a
 * `12h` column may start on.
 *
 * Independent literals, deliberately not derived from `TimelineScaleControl` or
 * from `formatClock`: reading them off the code under test is what keeps a spec
 * green after that code stops rendering the control or stops labelling the
 * local half-day.
 */
export const TWELVE_HOUR_SCALE_CONTROL_LABEL = "12h timeline scale";
export const LOCAL_HALF_DAY_CLOCK_LABELS: readonly string[] = ["12am", "12pm"];

/** The tab a spec must open for Radix to mount the timeline panel at all. */
export const SESSIONS_TIMELINE_TAB = BranchDetailTabParam.SessionsTimeline;

/**
 * A branch whose activity spans several local half-days, so `12h` renders more
 * than one column and the axis has somewhere to drift TO.
 *
 * Anchored on instants rather than on a wall-clock literal: the fixture must
 * mean the same span in every zone a spec pins, and only the rendered COLUMN is
 * supposed to move with the viewer's clock.
 */
export const CANONICAL_GRID_SESSION_ID = "canonical-grid";

export function makeCanonicalGridBranchDetail(): BranchPageDetail {
  return makeBranchDetail({
    estimatedCostUsd: 120,
    lastActivityAt: "2026-06-06T00:00:00.000Z",
    sessionIds: [CANONICAL_GRID_SESSION_ID],
    sessions: [
      makeBranchSession({
        endedAt: "2026-06-06T00:00:00.000Z",
        estimatedCostUsd: 120,
        ownerUserId: "u1",
        ownerUserName: "Cosimo",
        sessionId: CANONICAL_GRID_SESSION_ID,
        startedAt: "2026-06-01T00:00:00.000Z",
      }),
    ],
  });
}

/**
 * Move the rendered axis to `12h` the way a reader does — through the control.
 *
 * `fireEvent` rather than `user-event`: `apps/desktop` does not depend on the
 * latter, and a helper both shells share cannot need a package only one of them
 * installs. Queried by accessible NAME rather than by role so the spec survives
 * the control's underlying primitive changing shape.
 */
export async function selectTwelveHourScale(): Promise<void> {
  fireEvent.click(
    await screen.findByLabelText(TWELVE_HOUR_SCALE_CONTROL_LABEL)
  );
}

/**
 * The clock reading each rendered bar announces as its start — read off the
 * accessible name, which is the only statement of a column's instant a reader
 * ever receives.
 *
 * `formatTimelineBarLabel` composes `"<weekday> <clock> · <cost> · <breakdown>"`
 * (or `"… · idle"`), so the clock is the last token of the first segment.
 */
export function timelineBarClockLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".bq-bar"))
    .map((bar) => bar.getAttribute("aria-label") ?? "")
    .filter((label) => label.length > 0)
    .map((label) => (label.split(" · ")[0] ?? "").split(" ").at(-1) ?? "");
}
