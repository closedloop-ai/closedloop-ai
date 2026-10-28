import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  TranscriptAvailability,
  type TranscriptFileDescriptor,
} from "@repo/api/src/types/desktop-transcripts";
import { SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY } from "@repo/api/src/types/session-transcript-never-expected-flag";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../../shared/storybook/fixture-fetch";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";

/**
 * ISS-7516, WEB half — the same distinction #5713 shipped on the desktop, now
 * reaching `apps/app` from the served `dataSyncLevel` instead of from a
 * device-local setting the web cannot see.
 *
 * This file is deliberately a SIBLING of
 * `session-transcript-never-expected.test.tsx` rather than an edit of it. That
 * file pins the panel's rendering contract given a verdict; this one pins where
 * the WEB's verdict comes from. Same panel, same copy constants, same flag — the
 * point of the ticket is that there is exactly one disclosure mechanism.
 *
 * Everything is graded on `AgentSessionDetailView`, the composite BOTH shells
 * mount, and the web shell passes NO `transcriptNeverExpected` prop at all —
 * exactly as `apps/app` does in production. A spec that rendered the panel
 * directly, or that passed the prop by hand, would stay green if the fold were
 * deleted from the view.
 *
 * Copy is pinned as independent literals, not imported from the module under
 * test, so a copy change that erased the distinction cannot make this agree with
 * itself.
 */

const SESSION_ID = "session-transcript-never-expected-web-1";
const NEVER_EXPECTED_TITLE = "Transcript stays on this machine";
const NEVER_EXPECTED_REASON = /data sync level, not a stalled upload/i;
/**
 * The remedy must point at the machine that RECORDED the session, never at the
 * reader's own. A web reader has no data sync level at all, so second-person
 * wording here is an instruction they cannot carry out (review, #5737).
 *
 * Pinned as two assertions on purpose: the positive alone stays green if the
 * copy names the source machine AND still opens "Your data sync level", which
 * is the exact half-fix worth catching.
 */
const REMEDY_NAMES_SOURCE_MACHINE = /source machine's data sync level/i;
const REMEDY_ADDRESSES_THE_READER =
  /your data sync level|still on this machine/i;
const PENDING_TITLE = "Transcript still syncing";
const PENDING_NOTICE = /once the source machine uploads it/i;
const FLAGS = [SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY] as const;
/** The Properties pane's Sync row, found by its own label rather than position. */
const SYNC_ROW_LABEL = "Sync";
const NO_TRANSCRIPT_ROW_VALUE = /^No transcript(\s|$|\s·)/;

function missingDescriptor(): TranscriptFileDescriptor {
  return {
    fileKey: "main",
    availability: TranscriptAvailability.Missing,
    url: null,
    byteSize: null,
    rawSha256: null,
    uploadedAt: null,
    lastObservedAt: null,
    permanentFailureReason: null,
  };
}

function transcriptRoute(): FixtureRoute {
  return {
    method: "GET",
    path: `/agent-sessions/${SESSION_ID}/transcript`,
    respond: () => ({ sessionId: SESSION_ID, files: [missingDescriptor()] }),
  };
}

/**
 * A session whose main transcript is absent, parameterized ONLY by the served
 * level. Every case below shares this fixture so the level is provably the only
 * difference between a never-expected render and a pending one.
 */
function session(dataSyncLevel?: DataSyncLevel): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    ...(dataSyncLevel === undefined ? {} : { dataSyncLevel }),
    transcripts: [
      {
        fileKey: "main",
        availability: TranscriptAvailability.Missing,
        uploadedAt: null,
        permanentFailureReason: null,
      },
    ],
  });
}

/** Fails any byte fetch, so a read that should never happen is observable. */
function stubBytes(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request) =>
      Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
    )
  );
}

/** Mounts exactly what `apps/app` mounts: no `transcriptNeverExpected` prop. */
function renderWeb(input: {
  dataSyncLevel?: DataSyncLevel;
  enabledFlags?: readonly string[];
}) {
  stubBytes();
  return render(
    <AppCoreStoryProviders
      apiRoutes={[transcriptRoute()]}
      enabledFlags={input.enabledFlags}
    >
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session(input.dataSyncLevel)}
      />
    </AppCoreStoryProviders>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web session detail — a transcript that was never queued", () => {
  it("states the settled absence, in text, for a metadata-level machine", async () => {
    renderWeb({ dataSyncLevel: DataSyncLevel.Metadata, enabledFlags: FLAGS });

    expect(await screen.findByText(NEVER_EXPECTED_TITLE)).toBeInTheDocument();
    // AC2: the reason is discoverable — the reader can tell this from a stalled
    // upload. Asserted on text content, not `toBeVisible`, which passes for an
    // `sr-only` node that changes nothing on screen (WCAG 1.4.1: the difference
    // must not be carried by hue).
    expect(screen.getByText(NEVER_EXPECTED_REASON)).toBeInTheDocument();
    expect(screen.queryByText(PENDING_TITLE)).toBeNull();
    expect(screen.queryByText(PENDING_NOTICE)).toBeNull();
  });

  it("points the remedy at the source machine, not at the web reader", async () => {
    renderWeb({ dataSyncLevel: DataSyncLevel.Metadata, enabledFlags: FLAGS });

    expect(
      await screen.findByText(REMEDY_NAMES_SOURCE_MACHINE)
    ).toBeInTheDocument();
    expect(screen.queryByText(REMEDY_ADDRESSES_THE_READER)).toBeNull();
  });

  it("keeps the not-yet-arrived wording for a full-level machine mid-upload", async () => {
    // THE POSITIVE SIBLING. Same fixture, same flag, only the level differs.
    // Without it, deleting the pending branch outright — or folding every level
    // to never-expected — would leave the case above green while telling every
    // `full`-level machine its real in-flight upload is never coming.
    renderWeb({ dataSyncLevel: DataSyncLevel.Full, enabledFlags: FLAGS });

    expect(await screen.findByText(PENDING_TITLE)).toBeInTheDocument();
    expect(screen.getByText(PENDING_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(NEVER_EXPECTED_TITLE)).toBeNull();
  });

  it("keeps the not-yet-arrived wording when the server reports no level at all", async () => {
    // THE ABSENT CASE. A server that predates the column, or a desktop build
    // that does not send it, must leave the page byte-identical to today. If
    // absence were defaulted to a transcript-excluding level this would fail —
    // and in production it would stamp the settled wording over every session in
    // the org during a rollout.
    renderWeb({ enabledFlags: FLAGS });

    expect(await screen.findByText(PENDING_TITLE)).toBeInTheDocument();
    expect(screen.getByText(PENDING_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(NEVER_EXPECTED_TITLE)).toBeNull();
  });

  it("stays closed by default: a metadata-level session renders nothing new with the flag off", async () => {
    // ISS-4779 closed-by-default, asserted on the web gate specifically. The
    // desktop Labs toggle is a different registry; this is the PostHog side.
    renderWeb({ dataSyncLevel: DataSyncLevel.Metadata });

    expect(await screen.findByText(PENDING_TITLE)).toBeInTheDocument();
    expect(screen.getByText(PENDING_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(NEVER_EXPECTED_TITLE)).toBeNull();
  });
});

describe("web session detail — the Sync row never outranks the transcript", () => {
  it("does not say No transcript over a transcript that actually arrived", async () => {
    // The regression the ISS-7516 WEB half introduced and this gate closes.
    //
    // A served `dataSyncLevel` records what the recording machine QUEUED at its
    // last sync; the transcript summary records what ARRIVED. They disagree
    // exactly when the level is stale — and the panel's own remedy copy tells
    // the reader to make that happen ("Switch to Full transcripts … including
    // this one"). Follow it, and the sweep uploads the transcript while the
    // session row keeps its old `metadata` stamp. Without the availability gate
    // the Properties Sync row then read "No transcript" directly above the
    // rendered transcript — a fresh contradiction on the same screen, which is
    // the precise defect this ticket exists to remove.
    stubBytes();
    render(
      <AppCoreStoryProviders
        apiRoutes={[transcriptRoute()]}
        enabledFlags={FLAGS}
      >
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={{
            ...session(DataSyncLevel.Metadata),
            transcriptDisposition: TranscriptDisposition.Synced,
            transcripts: [
              {
                fileKey: "main",
                availability: TranscriptAvailability.Available,
                uploadedAt: "2026-08-22T12:00:00.000Z",
                permanentFailureReason: null,
              },
            ],
          }}
        />
      </AppCoreStoryProviders>
    );

    await userEvent.click(screen.getByRole("button", { name: "Properties" }));

    expect(await screen.findByText(SYNC_ROW_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(NO_TRANSCRIPT_ROW_VALUE)).toBeNull();
  });

  it("still says No transcript when the transcript really is absent", async () => {
    // POSITIVE SIBLING on the same row and the same locator. Without it, a gate
    // that suppressed the override unconditionally would pass the case above
    // while silently un-shipping the disclosure.
    stubBytes();
    render(
      <AppCoreStoryProviders
        apiRoutes={[transcriptRoute()]}
        enabledFlags={FLAGS}
      >
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={session(DataSyncLevel.Metadata)}
        />
      </AppCoreStoryProviders>
    );

    await userEvent.click(screen.getByRole("button", { name: "Properties" }));

    expect(await screen.findByText(SYNC_ROW_LABEL)).toBeInTheDocument();
    expect(screen.getByText(NO_TRANSCRIPT_ROW_VALUE)).toBeInTheDocument();
  });
});
