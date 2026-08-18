import type {
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import {
  TranscriptAvailability,
  type TranscriptFileDescriptor,
} from "@repo/api/src/types/desktop-transcripts";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../../shared/storybook/fixture-fetch";
import {
  type TranscriptBytesTransport,
  TranscriptBytesTransportProvider,
} from "../../../data-source/transcript-bytes-transport";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionTranscriptPanel } from "../session-transcript-panel";

/**
 * FEA-3634: the `missing` availability state, split into its own file so the
 * (already large) main `session-transcript-panel.test.tsx` stays under the
 * file-size ceiling — same split as the FEA-3489 force-archive coverage.
 *
 * `missing` is what the server synthesizes when it holds no `SessionTranscript`
 * row at all, i.e. nothing has reached the archive from the machine where the
 * session ran. It used to fall through to the generic "No transcript is
 * available" empty state, which reads as a product bug and names neither the
 * reason nor the harness lane.
 *
 * The copy is deliberately a WAITING state rather than a terminal one:
 * `deriveTranscriptDisposition` folds `missing` into the same `syncing` verdict
 * as `uploadPending`, and that verdict renders as a "Syncing" badge on this same
 * page, so a "never uploaded" dead end here would contradict it.
 *
 * These tests pin the explicit state, the `unknown`-harness guard, precedence
 * over the generic retryable error on the desktop, that a real local projection
 * still wins, and that the generic empty state is narrowed rather than removed.
 */

const SESSION_ID = "session-transcript-missing-1";
const RETRY_BUTTON_NAME = /retry/i;
const NOT_SYNCED_TITLE = "Transcript still syncing";
const NOT_SYNCED_NOTICE =
  /No Claude transcript from this session has synced yet/i;
const NO_TRANSCRIPT_NOTICE = /No transcript is available/i;
const GENERIC_LOAD_ERROR_TITLE = "Couldn't load transcript";
const TITLE_CASED_CLAUDE_NOTICE = /No Claude transcript from this session/i;

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

function transcriptFilesRoute(
  files: readonly TranscriptFileDescriptor[]
): FixtureRoute {
  return {
    method: "GET",
    path: `/agent-sessions/${SESSION_ID}/transcript`,
    respond: () => ({ sessionId: SESSION_ID, files }),
  };
}

function dbPrompt(text: string): TurnItem {
  return {
    type: "prompt",
    _row: 0,
    t: "2026-07-09T11:00:00.000Z",
    tMs: Date.parse("2026-07-09T11:00:00.000Z"),
    cum: 0,
    actor: { name: null, sessionId: SESSION_ID, human: "Ada", color: "#000" },
    text,
  };
}

function session(harness = "claude"): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness,
    // A cloud-backed detail carries the FR8 availability summary — its presence
    // is what enables the cloud transcript read at all.
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionTranscriptPanel — missing transcript (FEA-3634)", () => {
  it("names the not-yet-synced harness lane instead of the generic empty state", async () => {
    stubBytes();
    render(
      <AppCoreStoryProviders
        apiRoutes={[transcriptFilesRoute([missingDescriptor()])]}
      >
        <SessionTranscriptPanel
          // FEA-2718: on the web (cloud context) the DB fallback is ignored —
          // turn text no longer lives in the cloud DB, so this must stay
          // suppressed behind the explicit state.
          fallbackItems={[dbPrompt("db fallback prompt")]}
          session={session()}
        />
      </AppCoreStoryProviders>
    );

    // The panel must say WHY it is empty — nothing has reached us from the
    // source machine — and which harness lane that was.
    expect(await screen.findByText(NOT_SYNCED_TITLE)).toBeInTheDocument();
    expect(screen.getByText(NOT_SYNCED_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(NO_TRANSCRIPT_NOTICE)).not.toBeInTheDocument();
    // The browser has nothing to re-fetch — the next move belongs to the source
    // machine — so unlike `uploadFailed` this state offers no Retry.
    expect(
      screen.queryByRole("button", { name: RETRY_BUTTON_NAME })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("db fallback prompt")).not.toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("shows the unsupported-harness state for the 'unknown' sentinel rather than the syncing state", async () => {
    // `apps/api` writes the literal string "unknown" when a sync payload omits
    // the harness. "unknown" is not a cloud-parseable harness, so the
    // isUnsupportedHarness guard correctly prevents the "still syncing" state
    // and falls through to the rendering-unavailable path.
    stubBytes();
    render(
      <AppCoreStoryProviders
        apiRoutes={[transcriptFilesRoute([missingDescriptor()])]}
      >
        <SessionTranscriptPanel session={session("unknown")} />
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText("Transcript rendering unavailable")
    ).toBeInTheDocument();
    expect(screen.queryByText(NOT_SYNCED_TITLE)).toBeNull();
  });

  it("wins over the generic error when a desktop local fallback fails on a missing file", async () => {
    // Desktop parity with the uploadPending/uploadFailed guards: the static
    // `supportsLocalFallback` capability makes even a not-yet-synced file
    // `isReadable`, so the parse still runs and errors when no local copy
    // exists. That error must not mask the reason the pane is empty, nor offer a
    // Retry that can only fail again.
    const resolveFetchUrl = vi.fn(() =>
      Promise.reject(new Error("no local copy available"))
    );
    const failingLocalTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl,
    };
    render(
      <AppCoreStoryProviders
        apiRoutes={[transcriptFilesRoute([missingDescriptor()])]}
      >
        <TranscriptBytesTransportProvider transport={failingLocalTransport}>
          <SessionTranscriptPanel session={session()} />
        </TranscriptBytesTransportProvider>
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText(NOT_SYNCED_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(GENERIC_LOAD_ERROR_TITLE)).toBeNull();
    expect(
      screen.queryByRole("button", { name: RETRY_BUTTON_NAME })
    ).not.toBeInTheDocument();
    // Pin the PRECONDITION, not just the outcome (Codex review): this test is
    // only meaningful while the desktop actually attempts the local read and
    // fails. If a future hook change stopped attempting it, the assertions above
    // would still pass for the wrong reason — the error they guard against would
    // never have been raised.
    expect(resolveFetchUrl).toHaveBeenCalled();
  });

  it("still renders the desktop-local projected trace ahead of the missing state", async () => {
    // The explicit state must not blank a desktop session that has a real local
    // projection to show: the `fallbackItems` tier is checked first and still
    // wins, so this narrows only the truly-empty case.
    const failingLocalTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: () =>
        Promise.reject(new Error("no local copy available")),
    };
    render(
      <AppCoreStoryProviders apiRoutes={[transcriptFilesRoute([])]}>
        <TranscriptBytesTransportProvider transport={failingLocalTransport}>
          <SessionTranscriptPanel
            fallbackItems={[dbPrompt("local projected prompt")]}
            session={session()}
          />
        </TranscriptBytesTransportProvider>
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText("local projected prompt")
    ).toBeInTheDocument();
    expect(screen.queryByText(NOT_SYNCED_TITLE)).toBeNull();
  });

  it("keeps the projected main trace when the summary describes only sidechains", async () => {
    // ISS-4677: desktop discovery can surface a leftover `subagent:` file with no
    // `main` on disk. That flips transcript context ON while the active `main`
    // key resolves to no descriptor at all — which used to suppress the
    // projection and turn a perfectly good local trace into "No transcript".
    // "There is transcript context" is not "there is a transcript for the file
    // you are reading".
    stubBytes();
    const sidechainOnly = createAgentSessionDetailFixture({
      id: SESSION_ID,
      harness: "claude",
      transcripts: [
        {
          fileKey: "subagent:agent-1",
          availability: TranscriptAvailability.Available,
          uploadedAt: null,
          permanentFailureReason: null,
        },
      ],
    });
    render(
      <AppCoreStoryProviders apiRoutes={[transcriptFilesRoute([])]}>
        <SessionTranscriptPanel
          fallbackItems={[dbPrompt("local projected prompt")]}
          session={sidechainOnly}
        />
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText("local projected prompt")
    ).toBeInTheDocument();
    expect(screen.queryByText(NO_TRANSCRIPT_NOTICE)).toBeNull();
  });

  it("still shows the generic empty state when the session has no transcript descriptor at all", async () => {
    stubBytes();
    render(
      <AppCoreStoryProviders apiRoutes={[transcriptFilesRoute([])]}>
        <SessionTranscriptPanel session={session()} />
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText(NO_TRANSCRIPT_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(NOT_SYNCED_TITLE)).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("shows the unsupported-harness state instead of 'still syncing' for an unsupported harness with missing availability", async () => {
    stubBytes();
    render(
      <AppCoreStoryProviders
        apiRoutes={[transcriptFilesRoute([missingDescriptor()])]}
      >
        <SessionTranscriptPanel session={session("cursor")} />
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText("Transcript rendering unavailable")
    ).toBeInTheDocument();
    expect(screen.queryByText(NOT_SYNCED_TITLE)).toBeNull();
  });

  it("title-cases the harness name in the description", async () => {
    stubBytes();
    render(
      <AppCoreStoryProviders
        apiRoutes={[transcriptFilesRoute([missingDescriptor()])]}
      >
        <SessionTranscriptPanel session={session("claude")} />
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText(NOT_SYNCED_TITLE)).toBeInTheDocument();
    expect(screen.getByText(TITLE_CASED_CLAUDE_NOTICE)).toBeInTheDocument();
  });
});
