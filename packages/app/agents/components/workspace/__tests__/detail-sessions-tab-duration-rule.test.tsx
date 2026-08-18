/**
 * ISS-5131: the Duration rule on the agent-component detail Sessions tab.
 *
 * The THIRD caller of `agentSessionToSessionTableRow`, reached through
 * `adaptAgentComponentSessions` -> `sessionsFor`. It paints `row.durationLabel`
 * through the SAME shared `SessionsTable` the Sessions list uses and passes no
 * `visibleColumns`, so the Duration column is on. This pins that the tab renders
 * the same number for a session as the main list and the session's own detail
 * page do — a surface that drifted would put two Durations for one session in
 * front of the same reader.
 */
import type { AgentComponent } from "@repo/api/src/types/agent-component";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DetailSessionsTab } from "../detail-sessions-tab";

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const EM_DASH_REGEX = /^—$/;
const INFLATED_ROW_NAME = "Tab inflated completed";
const UNMEASURABLE_ROW_NAME = "Tab unmeasurable";

const inflatedCompletedItem = createAgentSessionListItemFixture({
  id: "tab-inflated-completed",
  name: INFLATED_ROW_NAME,
  status: SESSION_STATUS.INACTIVE,
  startedAt: new Date("2026-07-28T14:58:31.028Z"),
  endedAt: new Date("2026-07-29T22:02:53.365Z"),
  lastActivityAt: new Date("2026-08-04T17:28:37.425Z"),
  wallClock: "170h 30m",
});

const unmeasurableItem = createAgentSessionListItemFixture({
  id: "tab-unmeasurable",
  name: UNMEASURABLE_ROW_NAME,
  status: SESSION_STATUS.INACTIVE,
  startedAt: new Date("2026-06-10T10:00:00.000Z"),
  endedAt: null,
  lastActivityAt: new Date("2026-06-10T10:00:00.000Z"),
  wallClock: null,
});

// The tab passes `component` straight through to the adapter and never reads it
// for the mapping, so the narrow shape the prop type needs is enough here.
const component = {
  id: "component-1",
  name: "Test component",
} as AgentComponent;

function renderTab() {
  return render(
    <DetailSessionsTab
      component={component}
      sessions={[inflatedCompletedItem, unmeasurableItem]}
    />,
    {
      wrapper: ({ children }) => (
        <AppCoreStoryProviders enabledFlags={[]}>
          {children}
        </AppCoreStoryProviders>
      ),
    }
  );
}

function durationCellText(sessionName: string): string {
  const row = screen.getByText(sessionName).closest(".group.grid");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Could not find sessions table row for ${sessionName}`);
  }
  const headerRow = document.querySelector(".grid");
  if (!(headerRow instanceof HTMLElement)) {
    throw new Error("Could not find the sessions table header row");
  }
  const headerLabels = Array.from(headerRow.children).map((child) =>
    child.textContent?.trim()
  );
  const durationIndex = headerLabels.indexOf("Duration");
  if (durationIndex < 0) {
    throw new Error("The Duration column is not rendered in this tab");
  }
  const cell = row.children[durationIndex];
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`Could not find the Duration cell for ${sessionName}`);
  }
  return cell.textContent?.trim() ?? "";
}

describe("DetailSessionsTab Duration cell — ISS-5131 wall-time rule", () => {
  it("measures a terminal row start -> endedAt, ignoring a later lastActivityAt and the collector wallClock", () => {
    renderTab();

    expect(durationCellText(INFLATED_ROW_NAME)).toBe("31h 4m");
    expect(durationCellText(INFLATED_ROW_NAME)).not.toBe("170h 30m");
  });

  it("renders the no-data dash for a terminal row with no end instant", () => {
    renderTab();

    expect(durationCellText(UNMEASURABLE_ROW_NAME)).toMatch(EM_DASH_REGEX);
  });
});
