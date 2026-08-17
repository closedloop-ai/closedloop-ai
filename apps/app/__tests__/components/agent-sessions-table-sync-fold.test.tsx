/**
 * ISS-4847: the sync-state fold on the PRIMARY web `/sessions` table adapter
 * (`apps/app/components/agent-sessions/sessions-table.tsx`).
 *
 * This adapter is NOT the shared `SyncedSessionsTable` — the web Sessions route
 * mounts its own wrapper, and #4202 wired the fold only into the shared one. The
 * result was a flag that visibly did nothing on the main web Sessions list while
 * the dashboard/telemetry embeds and Desktop adopted it. These tests drive THIS
 * adapter through the real flag provider, so the two adapters can't drift again.
 */
import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SESSION_STATUS_SYNC_BADGE_TEST_ID } from "@repo/app/agents/lib/session-sync-presentation";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionsTable } from "@/components/agent-sessions/sessions-table";

// Render TooltipContent inline (not in a Portal) so the folded pill's copy is
// assertable without simulating hover.
vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const UPLOADING_ROW_NAME = "Web uploading session";
const FAILED_ROW_NAME = "Web failed uploading session";
// ISS-5279: there is no separate Syncing badge any more — the row's own Status
// pill carries the state, marked with `data-session-sync-state`.
const STATUS_BADGE_TEST_ID = SESSION_STATUS_SYNC_BADGE_TEST_ID;
const PULSE_RING_CLASS_RE = /motion-safe:animate-status-pulse-ring/;

const uploadingActiveItem = createAgentSessionListItemFixture({
  id: "web-uploading",
  name: UPLOADING_ROW_NAME,
  status: SESSION_STATUS.ACTIVE,
  cloudSyncState: AgentSessionCloudSyncState.Pending,
  transcriptDisposition: TranscriptDisposition.Syncing,
});

// ISS-5279: an ACTIVE row whose transcript upload stopped without completing —
// the "we stopped knowing" case a pulse must never quietly turn into "done".
const stalledUploadItem = createAgentSessionListItemFixture({
  id: "web-stalled-upload",
  name: "Web stalled upload session",
  status: SESSION_STATUS.ACTIVE,
  cloudSyncState: AgentSessionCloudSyncState.Pending,
  transcriptDisposition: TranscriptDisposition.FailedTransient,
});

const failedUploadingItem = createAgentSessionListItemFixture({
  id: "web-failed-uploading",
  name: FAILED_ROW_NAME,
  status: SESSION_STATUS.ERROR,
  cloudSyncState: AgentSessionCloudSyncState.Pending,
  transcriptDisposition: TranscriptDisposition.Syncing,
});

function renderWebSessionsTable(
  items: ReturnType<typeof createAgentSessionListItemFixture>[],
  enabledFlags: readonly string[] = []
) {
  return render(
    <SessionsTable
      getSessionHref={(item) => `/sessions/${item.id}`}
      items={items}
    />,
    {
      wrapper: ({ children }) => (
        <AppCoreStoryProviders enabledFlags={enabledFlags}>
          {children}
        </AppCoreStoryProviders>
      ),
    }
  );
}

// Every default data column EXCEPT Status — the View-menu state wongk's
// hidden-column case describes.
// ISS-5666: `qualifiers` listed explicitly. The set means "everything but
// Status" and predates the `Signals` column, so leaving that id out was
// incidental — but with the qualifiers-column gate retired the omission would
// HIDE the column these cases read the disclosure from.
const VISIBLE_COLUMNS_WITHOUT_STATUS = new Set([
  "name",
  "owner",
  "cost",
  "repo",
  "branch",
  "pr",
  "qualifiers",
  "started",
]);

describe("web /sessions table — ISS-4847 sync-state fold", () => {
  // ISS-5366: with `sessions-honest-unknown-states` retired ON the row's
  // DISPLAYED status is folded against the staleness cutoff, and the sync fold
  // only applies to a row that reads Active. The shared fixture's
  // `lastActivityAt` is a fixed date, so against the real clock every row here
  // would read "Stale" and nothing would fold — the suite would pass on
  // vacuously-unfolded rows. Pin the clock just after that timestamp.
  const NOW = new Date("2026-06-01T14:45:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ONE pulsing Status pill, still labelled with the run status, and the name cell drops its inline sync badge", () => {
    renderWebSessionsTable([uploadingActiveItem]);

    // This is the ISS-4847 regression: before the fix this adapter never read the
    // flag, so nothing on the primary web Sessions list ever changed.
    const statusBadge = screen.getByTestId(STATUS_BADGE_TEST_ID);
    // ISS-5279: the pill keeps the LIFECYCLE word — sync is a second dimension,
    // not a Status value — and pulses a ring to say the transcript is still uploading.
    expect(statusBadge).toHaveTextContent("Active");
    expect(statusBadge.className).toMatch(PULSE_RING_CLASS_RE);
    // The duplicate Mike filed repeatedly: a "Syncing" pill next to the run
    // status. Assert the SECOND pill is absent, not merely that a pill exists.
    expect(screen.queryByText("Syncing")).not.toBeInTheDocument();
    // ISS-5279: and no separate dot either.
    expect(
      screen.queryByTestId("session-liveness-dot")
    ).not.toBeInTheDocument();
    // The inline name-cell sync badge is gone: one place to look, no duplicate.
    const nameCell = screen.getByText(UPLOADING_ROW_NAME).closest("span");
    expect(nameCell?.textContent).not.toContain("Syncing");
  });

  it("a row whose upload is NOT in flight gets no pill mark", () => {
    // PR review's resolution, driven through the real adapter. A
    // `failedTransient` verdict is not in flight, so the Status pill says
    // nothing about transport — it is the ordinary Active pill, unmarked.
    renderWebSessionsTable([stalledUploadItem]);

    expect(screen.queryByTestId(STATUS_BADGE_TEST_ID)).not.toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    // This case used to also assert the verdict stayed in the Name cell.
    // ISS-5770 removed the `Signals` column that disclosure rendered into, so
    // there is no list-side cell left to state it in; it now renders on Session
    // Detail's Sync row. What this case still owns is the fold: a not-in-flight
    // row gets the ordinary unmarked Active pill rather than a transport claim.
  });

  it("an uploading FAILED row keeps its real outcome", () => {
    renderWebSessionsTable([failedUploadingItem]);

    // The fold is Active-only, so a Failed row is never folded — no pulse over a
    // settled outcome.
    expect(screen.queryByTestId(STATUS_BADGE_TEST_ID)).not.toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
  it("the Status column is hidden: the fold stands down (ISS-4848)", () => {
    // wongk: hiding Status from the View menu removes the Status cell entirely,
    // so the folded pill has nowhere to render. The fold gates on Status
    // visibility so it stands down rather than marking a pill that is absent.
    render(
      <SessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[uploadingActiveItem]}
        visibleColumns={VISIBLE_COLUMNS_WITHOUT_STATUS}
      />,
      {
        wrapper: ({ children }) => (
          <AppCoreStoryProviders>{children}</AppCoreStoryProviders>
        ),
      }
    );

    expect(screen.queryByTestId(STATUS_BADGE_TEST_ID)).not.toBeInTheDocument();
  });
});
