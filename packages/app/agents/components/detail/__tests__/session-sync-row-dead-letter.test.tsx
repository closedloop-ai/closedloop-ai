import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptAvailability } from "@repo/api/src/types/desktop-transcripts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../../shared/storybook/fixture-fetch";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";

/**
 * ISS-11427: the Properties Sync row of a session the desktop sync lane
 * dead-lettered says which kind it is, through the composed detail view the
 * shells mount. Labels are the operator's (Marisol Ashgrove, 2026-10-05), pinned
 * here as independent literals so the suite does not agree with whatever the
 * module happens to say.
 */

const SESSION_ID = "session-sync-row-dead-letter-1";
const SYNC_ROW_LABEL = "Sync";
const DEAD_LETTER_VALUE = /^Dead letter(\s|$)/;
const ABANDONED_VALUE = /^Abandoned(\s|$)/;

function transcriptRoute(): FixtureRoute {
  return {
    method: "GET",
    path: `/agent-sessions/${SESSION_ID}/transcript`,
    respond: () => ({ sessionId: SESSION_ID, files: [] }),
  };
}

function session(
  cloudSyncState: AgentSessionCloudSyncState
): AgentSessionDetail {
  return {
    ...createAgentSessionDetailFixture({
      id: SESSION_ID,
      harness: "claude",
      transcripts: [
        {
          fileKey: "main",
          availability: TranscriptAvailability.Missing,
          uploadedAt: null,
          permanentFailureReason: null,
        },
      ],
    }),
    cloudSyncState,
  };
}

async function renderSyncRow(
  cloudSyncState: AgentSessionCloudSyncState
): Promise<HTMLElement> {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request) =>
      Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
    )
  );
  render(
    <AppCoreStoryProviders apiRoutes={[transcriptRoute()]}>
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session(cloudSyncState)}
      />
    </AppCoreStoryProviders>
  );
  await userEvent.click(screen.getByRole("button", { name: "Properties" }));
  const label = await screen.findByText(SYNC_ROW_LABEL);
  const row = label.parentElement;
  if (!row) {
    throw new Error("Sync row label is not inside a property row");
  }
  return row;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentSessionDetailView — Sync row for a dead-lettered session", () => {
  it("says Dead letter for a session the lane will retry", async () => {
    const row = await renderSyncRow(AgentSessionCloudSyncState.DeadLetter);

    expect(within(row).getByText(DEAD_LETTER_VALUE)).toBeInTheDocument();
  });

  it("says Abandoned for a session no path will retry", async () => {
    const row = await renderSyncRow(AgentSessionCloudSyncState.Abandoned);

    expect(within(row).getByText(ABANDONED_VALUE)).toBeInTheDocument();
  });
});
