import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  completeSessionsTrace,
  partialSessionsTrace,
  sessionsPanelDetail,
} from "../branch-sessions-panel-fixtures";
import {
  BRANCH_SESSIONS_EMPTY_TITLE,
  type BranchSessionsStateContentMap,
} from "../branch-sessions-panel-states";
import {
  BranchSessionsTimelinePanel,
  type BranchSessionsTimelinePanelProps,
  TIMELINE_NOT_LOADED_COVERAGE_NOTE,
} from "../branch-sessions-timeline-tab";
import { BRANCH_TRACE_SESSION_LINKS_LABEL } from "../branch-trace-session-links";

// Fixture wording: the panel ships none for error/permission; the host
// supplies it (ISS-10797).
const STATE_CONTENT = {
  error: {
    description: "Fixture: error description",
    title: "Fixture: error title",
  },
  permission: {
    description: "Fixture: permission description",
    title: "Fixture: permission title",
  },
};

const ERROR_STATE = { state: "error" } as const;
const SESSIONS_COUNT_RE = /sessions/;
const PERMISSION_STATE = { state: "permission" } as const;

function traceHeading() {
  return screen.getByText("Combined session trace", { exact: false });
}

/**
 * ISS-10793. The Sessions panel takes its data as props, so every state is
 * reachable without a data source; copy is located through the constants the
 * panel renders, not re-typed literals.
 */

function panel(over: Partial<BranchSessionsTimelinePanelProps> = {}) {
  return (
    <BranchSessionsTimelinePanel
      detail={sessionsPanelDetail}
      scrollElementRef={createRef<HTMLDivElement>()}
      stateContent={STATE_CONTENT}
      trace={{ data: completeSessionsTrace, isLoading: false }}
      {...over}
    />
  );
}

function renderPanel(over: Partial<BranchSessionsTimelinePanelProps> = {}) {
  return render(panel(over));
}

function skeleton() {
  return document.querySelector('[data-slot="skeleton"]');
}

describe("BranchSessionsTimelinePanel", () => {
  it("renders the timeline and combined trace from the trace it is given", () => {
    renderPanel();

    expect(traceHeading()).toHaveTextContent(
      "Combined session trace · 2 sessions"
    );
  });

  it("shows the loading skeleton while the host's trace is loading", () => {
    renderPanel({ trace: { data: undefined, isLoading: true } });

    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(
      screen.queryByText("Combined session trace")
    ).not.toBeInTheDocument();
  });

  // #7918 review: a supplied `state` wins over `trace.isLoading` (the prop's
  // documented contract), so a host can show `empty` on a cold query.
  it.each([
    ["empty", () => screen.getByText(BRANCH_SESSIONS_EMPTY_TITLE)],
    ["error", () => screen.getByRole("alert")],
    ["permission", () => screen.getByText(STATE_CONTENT.permission.title)],
  ] as const)(
    "lets a supplied %s state win over the trace's own loading flag",
    (state, locate) => {
      renderPanel({
        state,
        trace: { data: undefined, isLoading: true },
      });

      expect(locate()).toBeVisible();
      expect(skeleton()).toBeNull();
    }
  );

  it("shows the skeleton for a first-paint loading even with a trace in hand", () => {
    renderPanel({
      state: "loading",
      trace: { data: completeSessionsTrace, isLoading: false },
    });

    expect(skeleton()).not.toBeNull();
    expect(
      screen.queryByText("Combined session trace", { exact: false })
    ).not.toBeInTheDocument();
  });

  // Nerys's ArtifactTab ruling (ISS-10791): a later loading is a refetch, so
  // the rendered timeline stays mounted -- playhead, scroll and drafts
  // survive -- and is marked busy, instead of being swapped for the skeleton.
  it("keeps the rendered timeline mounted and busy through a refetch", () => {
    const scrollElementRef = createRef<HTMLDivElement>();
    const onRenderedSessionsChange = vi.fn();
    const props = { onRenderedSessionsChange, scrollElementRef };
    const { rerender } = renderPanel({ ...props, state: "ready" });
    const scrollBefore = scrollElementRef.current;

    act(() => {
      rerender(panel({ ...props, state: "loading" }));
    });

    expect(skeleton()).toBeNull();
    expect(scrollBefore).not.toBeNull();
    expect(scrollElementRef.current).toBe(scrollBefore);
    expect(scrollBefore?.isConnected).toBe(true);
    expect(
      document
        .querySelector(".bq-sessions-workspace")
        ?.getAttribute("aria-busy")
    ).toBe("true");
    expect(onRenderedSessionsChange.mock.lastCall).toEqual([
      { coverageNote: null, sessionIds: ["s1", "s2"] },
    ]);

    act(() => {
      rerender(panel({ ...props, state: "ready" }));
    });
    expect(
      document
        .querySelector(".bq-sessions-workspace")
        ?.hasAttribute("aria-busy")
    ).toBe(false);
  });

  // A host that maps a still-loading query to `ready` would otherwise get the
  // trace-unavailable warning, a load that reads as a failure.
  it("keeps the skeleton when the host says ready before any trace arrives", () => {
    renderPanel({
      state: "ready",
      trace: { data: undefined, isLoading: true },
    });

    expect(skeleton()).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a partial trace visible with its coverage notes", () => {
    renderPanel({ trace: { data: partialSessionsTrace, isLoading: false } });

    expect(traceHeading()).toHaveTextContent("1 of 2 sessions rendered");
    expect(screen.queryByText(BRANCH_SESSIONS_EMPTY_TITLE)).toBeNull();
    expect(screen.queryByText(STATE_CONTENT.error.title)).toBeNull();
  });

  it("shows the empty state the host asks for, not an empty timeline", () => {
    renderPanel({ state: "empty" });

    expect(screen.getByText(BRANCH_SESSIONS_EMPTY_TITLE)).toBeVisible();
    expect(
      screen.queryByText("Combined session trace")
    ).not.toBeInTheDocument();
  });

  it("shows the error state as an alert with Retry", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderPanel({ onRetry, ...ERROR_STATE });

    expect(screen.getByRole("alert")).toHaveTextContent(
      STATE_CONTENT.error.title
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps permission distinct from empty and failed", () => {
    renderPanel(PERMISSION_STATE);

    expect(screen.getByText(STATE_CONTENT.permission.title)).toBeVisible();
    expect(screen.queryByText(BRANCH_SESSIONS_EMPTY_TITLE)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("takes the host's wording as a map keyed by state, each entry complete", () => {
    const both: BranchSessionsStateContentMap = STATE_CONTENT;
    const noDescription: BranchSessionsStateContentMap = {
      // @ts-expect-error -- a permission entry without its description.
      permission: { title: "Fixture: title" },
    };
    const noTitle: BranchSessionsStateContentMap = {
      // @ts-expect-error -- an error entry without its title.
      error: { description: "Fixture: description" },
    };
    const emptyEntry: BranchSessionsStateContentMap = {
      // @ts-expect-error -- `empty` uses shipped copy and takes no wording.
      empty: STATE_CONTENT.error,
    };
    expect([both, noDescription, noTitle, emptyEntry]).toHaveLength(4);
  });

  // Runtime guard for hosts the types cannot see: no empty heading, no alert
  // that announces nothing.
  it("renders the error icon and Retry alone when its wording is missing", () => {
    renderPanel({ onRetry: vi.fn(), state: "error", stateContent: {} });

    expect(
      document.querySelector(
        '[data-branch-sessions-state="error"] svg.lucide-circle-alert'
      )
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector('[data-slot="alert-title"]')).toBeNull();
  });

  it("renders the lock alone when the permission wording is blank", () => {
    renderPanel({
      state: "permission",
      stateContent: { permission: { description: "", title: "  " } },
    });

    expect(
      document.querySelector('[data-branch-sessions-state="permission"] svg')
    ).not.toBeNull();
    expect(document.querySelector('[data-slot="empty-title"]')).toBeNull();
  });

  // ISS-12210: the heading names each counted Session as a link to the host's
  // Session route; the partial fixture withholds s2, so its name must not link.
  it("links each rendered Session's name to the host's Session route", async () => {
    render(
      <NavigationProvider adapter={createMemoryNavigation().adapter}>
        {panel({
          getSessionHref: (sessionId) => `/fixture-org/sessions/${sessionId}`,
          trace: { data: partialSessionsTrace, isLoading: false },
        })}
      </NavigationProvider>
    );
    // ISS-12448: the links open from the heading's count.
    await userEvent.click(
      screen.getByRole("button", { expanded: false, name: SESSIONS_COUNT_RE })
    );

    const nav = screen.getByRole("navigation", {
      name: BRANCH_TRACE_SESSION_LINKS_LABEL,
    });
    const links = within(nav).getAllByRole("link");
    expect(
      links.map((link) => [link.textContent, link.getAttribute("href")])
    ).toEqual([
      ["Fixture: Implement Branch Details", "/fixture-org/sessions/s1"],
    ]);
  });

  it("names no Sessions when the host supplies no Session route", () => {
    renderPanel();

    expect(traceHeading()).toBeInTheDocument();
    // ISS-12448: neither the links nor their toggle exist, collapsed or not.
    expect(
      screen.queryByRole("navigation", {
        hidden: true,
        name: BRANCH_TRACE_SESSION_LINKS_LABEL,
      })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: SESSIONS_COUNT_RE })
    ).toBeNull();
  });

  // A failed trace read leaves `traceResult` null and the heading counting the
  // whole Branch; naming those as "in this trace" would claim a trace that
  // never loaded.
  it("names no Sessions when the trace could not be read", () => {
    render(
      <NavigationProvider adapter={createMemoryNavigation().adapter}>
        {panel({
          getSessionHref: (sessionId) => `/fixture-org/sessions/${sessionId}`,
          trace: { data: null, isLoading: false },
        })}
      </NavigationProvider>
    );

    expect(traceHeading()).toBeInTheDocument();
    // ISS-12448: neither the links nor their toggle exist, collapsed or not.
    expect(
      screen.queryByRole("navigation", {
        hidden: true,
        name: BRANCH_TRACE_SESSION_LINKS_LABEL,
      })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: SESSIONS_COUNT_RE })
    ).toBeNull();
  });

  it("reports the rendered sessions to the comments rail", () => {
    const onRenderedSessionsChange = vi.fn();
    renderPanel({
      onRenderedSessionsChange,
      trace: { data: partialSessionsTrace, isLoading: false },
    });

    expect(onRenderedSessionsChange).toHaveBeenLastCalledWith({
      coverageNote:
        "Comments are shown only for Sessions rendered in this incomplete timeline.",
      sessionIds: ["s1"],
    });
  });

  // marisolashgrove / #7918 review: the panel mounts inside the Branch detail
  // page, which owns the document outline, so its in-panel zero-state must not
  // emit a heading of its own.
  it.each([{ state: "empty" } as const, PERMISSION_STATE])(
    "keeps the $state zero-state out of the document outline",
    (stateProps) => {
      renderPanel(stateProps);

      expect(screen.queryByRole("heading")).toBeNull();
    }
  );

  // whitlockk / #7918 review: the rail must not offer comments on sessions the
  // panel is not showing. `loading` is the case the first guard missed -- a
  // host holding a cached trace while its refetch is in flight.
  // The note reuses this file's shipped "until the timeline loads" copy; `empty`
  // has nothing to comment on and carries none.
  it.each([
    [{ state: "loading" } as const, TIMELINE_NOT_LOADED_COVERAGE_NOTE],
    [{ state: "empty" } as const, null],
    [ERROR_STATE, TIMELINE_NOT_LOADED_COVERAGE_NOTE],
    [PERMISSION_STATE, TIMELINE_NOT_LOADED_COVERAGE_NOTE],
  ] as const)(
    "clears the rail's session ids and sets its note when the host state is %o",
    (stateProps, coverageNote) => {
      const onRenderedSessionsChange = vi.fn();
      renderPanel({
        onRenderedSessionsChange,
        ...stateProps,
        trace: { data: completeSessionsTrace, isLoading: false },
      });

      expect(onRenderedSessionsChange.mock.lastCall).toEqual([
        { coverageNote, sessionIds: [] },
      ]);
    }
  );

  // The one literal pin on the shipped copy; the cases above use the constant.
  it("keeps production's shipped rail-note wording", () => {
    expect(TIMELINE_NOT_LOADED_COVERAGE_NOTE).toBe(
      "Session comment coverage is unavailable until the timeline loads."
    );
  });

  it("keeps the shipped rail note while no host state is set and no trace has loaded", () => {
    const onRenderedSessionsChange = vi.fn();
    renderPanel({
      onRenderedSessionsChange,
      trace: { data: undefined, isLoading: true },
    });

    expect(onRenderedSessionsChange.mock.lastCall).toEqual([
      {
        coverageNote: TIMELINE_NOT_LOADED_COVERAGE_NOTE,
        sessionIds: [],
      },
    ]);
  });

  it("still reports the rendered sessions when the host state is ready", () => {
    const onRenderedSessionsChange = vi.fn();
    renderPanel({
      onRenderedSessionsChange,
      state: "ready",
      trace: { data: completeSessionsTrace, isLoading: false },
    });

    expect(onRenderedSessionsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionIds: ["s1", "s2"] })
    );
  });

  it("attaches the host's scroll element to the panel's scroll container", () => {
    const scrollElementRef = createRef<HTMLDivElement>();
    renderPanel({ scrollElementRef });

    expect(scrollElementRef.current).toHaveClass("sd3-scroll");
  });
});
