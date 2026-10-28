import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import {
  completeSessionsTrace,
  sessionsPanelDetail,
} from "../branch-sessions-panel-fixtures";
import {
  BranchSessionsTimelinePanel,
  type BranchSessionsTimelinePanelProps,
} from "../branch-sessions-timeline-tab";
import { BRANCH_TRACE_SESSION_LINKS_LABEL } from "../branch-trace-session-links";

const TWO_SESSIONS_RE = /2 sessions/;

function panel(
  detail = sessionsPanelDetail,
  over: Partial<BranchSessionsTimelinePanelProps> = {}
) {
  return (
    <NavigationProvider adapter={createMemoryNavigation().adapter}>
      <BranchSessionsTimelinePanel
        detail={detail}
        getSessionHref={(sessionId) => `/fixture-org/sessions/${sessionId}`}
        scrollElementRef={createRef<HTMLDivElement>()}
        trace={{ data: completeSessionsTrace, isLoading: false }}
        {...over}
      />
    </NavigationProvider>
  );
}

function sessionLinks() {
  return screen.queryByRole("navigation", {
    name: BRANCH_TRACE_SESSION_LINKS_LABEL,
  });
}

function countToggle() {
  return screen.getByRole("button", { name: TWO_SESSIONS_RE });
}

// ISS-12448: the heading's session links are collapsed by default and open
// from the "N sessions" count (Nerys Applethwaite, 2026-10-19).
describe("Branch trace session links disclosure (ISS-12448)", () => {
  it("starts collapsed and opens and closes from the session count", async () => {
    render(panel());

    expect(sessionLinks()).toBeNull();
    expect(countToggle()).toHaveAttribute("aria-expanded", "false");
    // Collapsed links stay in the DOM, hidden, so aria-controls resolves.
    expect(
      document.getElementById(countToggle().getAttribute("aria-controls") ?? "")
    ).toHaveAttribute("hidden");

    await userEvent.click(countToggle());
    const nav = sessionLinks();
    expect(nav).not.toBeNull();
    expect(countToggle()).toHaveAttribute("aria-expanded", "true");
    expect(countToggle()).toHaveAttribute("aria-controls", nav?.id);

    await userEvent.click(countToggle());
    expect(sessionLinks()).toBeNull();
  });

  it("collapses again when the panel moves to another Branch", async () => {
    const { rerender } = render(panel());
    await userEvent.click(countToggle());
    expect(sessionLinks()).not.toBeNull();

    rerender(panel({ ...sessionsPanelDetail, id: "another-branch" }));

    expect(sessionLinks()).toBeNull();
    expect(countToggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the links open when the heading shows no count to toggle them", () => {
    render(
      panel(sessionsPanelDetail, {
        showBranchContext: false,
        trace: {
          data: { ...completeSessionsTrace, qualifyingSessionCount: null },
          isLoading: false,
        },
      })
    );

    expect(sessionLinks()).not.toBeNull();
    expect(screen.queryByRole("button", { name: TWO_SESSIONS_RE })).toBeNull();
  });
});
