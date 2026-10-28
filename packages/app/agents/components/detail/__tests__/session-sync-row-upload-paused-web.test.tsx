import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import {
  TranscriptAvailability,
  type TranscriptFileDescriptor,
} from "@repo/api/src/types/desktop-transcripts";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../../shared/storybook/fixture-fetch";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";

/**
 * ISS-9884, WEB detail flow — the Sync row tells a paused upload from a retry.
 *
 * `failedTransient` is reached both by an ordinary retryable upload failure and
 * by the desktop lane giving up at its 24h environmental wall clock, and only
 * `transcriptDispositionReason` tells them apart. The fold is unit-tested on its
 * own, but a detail payload that dropped the reason falls back to "Sync failed,
 * retrying" and every isolated test stays green. So the pair is graded here on
 * `AgentSessionDetailView`, the composite both shells mount, with the no-reason
 * retry as the control.
 *
 * Copy is pinned as independent literals, not imported from the module under
 * test, so a copy change that erased the distinction cannot agree with itself.
 */

const SESSION_ID = "session-sync-row-upload-paused-web-1";
const SYNC_ROW_LABEL = "Sync";
const PAUSED_ROW_VALUE = /^Upload paused(\s|$)/;
const RETRYING_ROW_VALUE = /^Sync failed, retrying(\s|$)/;

type SyncCase = {
  availability: TranscriptAvailability;
  reason: TranscriptSkipReason | null;
};

/** What the cloud serves for a transcript the desktop lane gave up on. */
const PAUSED: SyncCase = {
  availability: TranscriptAvailability.PermanentlyUnavailable,
  reason: TranscriptSkipReason.EnvironmentUnavailable,
};

/** An ordinary retryable upload failure: same disposition, no reason. */
const RETRYING: SyncCase = {
  availability: TranscriptAvailability.UploadFailed,
  reason: null,
};

function descriptor(input: SyncCase): TranscriptFileDescriptor {
  return {
    fileKey: "main",
    availability: input.availability,
    url: null,
    byteSize: null,
    rawSha256: null,
    uploadedAt: null,
    lastObservedAt: null,
    permanentFailureReason: input.reason,
  };
}

function session(input: SyncCase): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    transcriptDisposition: TranscriptDisposition.FailedTransient,
    ...(input.reason === null
      ? {}
      : { transcriptDispositionReason: input.reason }),
    transcripts: [
      {
        fileKey: "main",
        availability: input.availability,
        uploadedAt: null,
        permanentFailureReason: input.reason,
      },
    ],
  });
}

/** Mounts what `apps/app` mounts, then opens the Properties pane. */
async function renderWebDetail(input: SyncCase): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request) =>
      Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
    )
  );
  const transcriptRoute: FixtureRoute = {
    method: "GET",
    path: `/agent-sessions/${SESSION_ID}/transcript`,
    respond: () => ({ sessionId: SESSION_ID, files: [descriptor(input)] }),
  };
  render(
    <AppCoreStoryProviders apiRoutes={[transcriptRoute]}>
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session(input)}
      />
    </AppCoreStoryProviders>
  );
  await userEvent.click(screen.getByRole("button", { name: "Properties" }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web session detail — the Sync row tells a paused upload from a retry", () => {
  it("says Upload paused for failedTransient + environment_unavailable", async () => {
    await renderWebDetail(PAUSED);

    expect(await screen.findByText(SYNC_ROW_LABEL)).toBeInTheDocument();
    expect(screen.getByText(PAUSED_ROW_VALUE)).toBeInTheDocument();
    expect(screen.queryByText(RETRYING_ROW_VALUE)).toBeNull();
  });

  it("keeps Sync failed, retrying for the same disposition with no reason", async () => {
    await renderWebDetail(RETRYING);

    expect(await screen.findByText(SYNC_ROW_LABEL)).toBeInTheDocument();
    expect(screen.getByText(RETRYING_ROW_VALUE)).toBeInTheDocument();
    expect(screen.queryByText(PAUSED_ROW_VALUE)).toBeNull();
  });
});
