/**
 * ISS-5131: the Duration rule on the PRIMARY web `/sessions` table adapter
 * (`apps/app/components/agent-sessions/sessions-table.tsx`).
 *
 * This adapter is NOT the shared `SyncedSessionsTable` — the web Sessions route
 * mounts its own wrapper, and the two have drifted before (the ISS-4847
 * sync-fold miss the sibling `agent-sessions-table-sync-fold.test.tsx` exists to
 * prevent). So this pins the ADAPTER, not the resolver: a session must render
 * the same Duration here as it does in the shared list and on its own detail
 * page.
 */

import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionsTable } from "@/components/agent-sessions/sessions-table";

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const EM_DASH_REGEX = /^—$/;
const UNMEASURABLE_ROW_NAME = "Web terminal, no end instant";
const INFLATED_ROW_NAME = "Web sync-inflated wallClock";
const DURATION_HEADER_LABEL = "Duration";

// A terminal session with no end instant: one instant is not a span.
const unmeasurableItem = createAgentSessionListItemFixture({
  id: "web-unmeasurable",
  name: UNMEASURABLE_ROW_NAME,
  status: SESSION_STATUS.INACTIVE,
  startedAt: new Date("2026-06-10T10:00:00.000Z"),
  lastActivityAt: new Date("2026-06-10T10:00:00.000Z"),
  endedAt: null,
  wallClock: null,
});

// The reported session `019fb3e3`: COMPLETED, but its `lastActivityAt` tracks
// SYNC time six days past `endedAt`, and the collector's `wallClock` was derived
// from that same anchor — 170h 30m for a 31h 4m run.
const inflatedCompletedItem = createAgentSessionListItemFixture({
  id: "web-inflated-completed",
  name: INFLATED_ROW_NAME,
  status: SESSION_STATUS.INACTIVE,
  startedAt: new Date("2026-07-28T14:58:31.028Z"),
  endedAt: new Date("2026-07-29T22:02:53.365Z"),
  lastActivityAt: new Date("2026-08-04T17:28:37.425Z"),
  wallClock: "170h 30m",
});

function renderWebSessionsTable() {
  return render(
    <SessionsTable
      getSessionHref={(item) => `/sessions/${item.id}`}
      items={[unmeasurableItem, inflatedCompletedItem]}
      visibleColumns={new Set(["name", "duration"])}
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
  // Resolve the Duration cell by its HEADER position, the same way the shared
  // `SyncedSessionsTable` suite does. A row carries trailing cells the header
  // does not label (the row-actions menu), so "the last child" is not the
  // Duration cell.
  const headerRow = screen.getByText("Session").closest(".grid");
  if (!(headerRow instanceof HTMLElement)) {
    throw new Error("Could not find the sessions table header row");
  }
  const durationIndex = [...headerRow.children].findIndex(
    (cell) => cell.textContent?.trim() === DURATION_HEADER_LABEL
  );
  if (durationIndex === -1) {
    throw new Error("Could not find the Duration column header");
  }
  const row = screen.getByText(sessionName).closest(".group.grid");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Could not find sessions table row for ${sessionName}`);
  }
  const cell = row.children[durationIndex];
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`Could not find the Duration cell for ${sessionName}`);
  }
  return cell.textContent?.trim() ?? "";
}

describe("web /sessions table — ISS-5131 Duration wall-time rule", () => {
  it("measures a terminal row start -> endedAt, ignoring a later lastActivityAt and the collector wallClock", () => {
    renderWebSessionsTable();

    expect(durationCellText(INFLATED_ROW_NAME)).toBe("31h 4m");
    expect(durationCellText(INFLATED_ROW_NAME)).not.toBe("170h 30m");
  });

  it("renders the no-data dash for a terminal row with no end instant", () => {
    renderWebSessionsTable();

    // Never a fabricated "0s", and never a span against `now()` that would keep
    // growing on a finished session.
    expect(durationCellText(UNMEASURABLE_ROW_NAME)).toMatch(EM_DASH_REGEX);
    expect(durationCellText(UNMEASURABLE_ROW_NAME)).not.toBe(
      durationCellText(INFLATED_ROW_NAME)
    );
  });
});
