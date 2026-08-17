import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import type { TranscriptFileDescriptor } from "@repo/api/src/types/desktop-transcripts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../../shared/storybook/fixture-fetch";
import {
  type TranscriptBytesTransport,
  TranscriptBytesTransportProvider,
} from "../../../data-source/transcript-bytes-transport";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionTranscriptPanel } from "../session-transcript-panel";
import { TranscriptForceArchiveAction } from "../transcript-force-archive-action";

/**
 * FEA-3489 (PRD-536) desktop-only force-archive override UI, split into its own
 * file so the (already large) main `session-transcript-panel.test.tsx` stays
 * under the file-size ceiling. Covers the ENABLED action running the forced
 * upload and refetching to render the now-available transcript, and the
 * retryable-failure path. Web gating (action disabled, no local file) lives in
 * the main panel test alongside the terminal-state coverage.
 */

const SESSION_ID = "session-transcript-1";
const SIGNED_URL = "https://s3.invalid/session/main.jsonl";
const FORCE_ARCHIVE_BUTTON_NAME = /sync this transcript anyway/i;
const FORCE_ARCHIVE_FAILED_NOTICE = /syncing this transcript failed/i;
const FORCE_ARCHIVE_PERMANENT_NOTICE = /transcript can’t be synced/i;
const FORCE_ARCHIVE_IN_PROGRESS_NOTICE = /sync started/i;
const NOT_ARCHIVED_TITLE = "Transcript not archived";
const RETRIES_EXHAUSTED_NOTICE =
  /couldn’t be uploaded after repeated attempts.*may still be on the machine/i;
const LOAD_FULL_TRANSCRIPT_NAME = /load full transcript/i;
const TRANSCRIPT_BODY = `${JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/home/me/project",
  message: { role: "user", content: "cloud hello" },
})}\n${JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-09T12:00:01.000Z",
  message: {
    role: "assistant",
    model: "claude-opus-4",
    content: [{ type: "text", text: "cloud reply" }],
    usage: { input_tokens: 10, output_tokens: 5 },
  },
})}\n`;

function descriptor(
  overrides: Partial<TranscriptFileDescriptor> = {}
): TranscriptFileDescriptor {
  return {
    fileKey: "main",
    availability: "available",
    url: SIGNED_URL,
    byteSize: TRANSCRIPT_BODY.length,
    rawSha256: "b".repeat(64),
    uploadedAt: "2026-07-09T12:05:00.000Z",
    lastObservedAt: "2026-07-09T12:05:00.000Z",
    permanentFailureReason: null,
    ...overrides,
  };
}

function tooLargeDescriptor(): TranscriptFileDescriptor {
  return descriptor({
    availability: "permanentlyUnavailable",
    url: null,
    byteSize: null,
    rawSha256: null,
    uploadedAt: null,
    permanentFailureReason: "too_large",
  });
}

function session(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    transcripts: [
      {
        fileKey: "main",
        availability: "available",
        uploadedAt: "2026-07-09T12:05:00.000Z",
        permanentFailureReason: null,
      },
    ],
  });
}

function stubBytes(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request) =>
      String(url) === SIGNED_URL
        ? Promise.resolve(new Response(TRANSCRIPT_BODY, { status: 200 }))
        : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
    )
  );
}

/**
 * A desktop-shaped transport: it exposes `forceArchiveOversized` (present only on
 * the desktop) and mirrors the cloud read gate — a null-url (terminal) descriptor
 * is not readable, so the panel reaches the permanent state; once the forced
 * upload flips the descriptor to available, the read resolves.
 */
function desktopTransport(
  force: NonNullable<TranscriptBytesTransport["forceArchiveOversized"]>
): TranscriptBytesTransport {
  return {
    supportsLocalFallback: false,
    resolveFetchUrl: ({ file }) =>
      file.url
        ? Promise.resolve({ kind: "ready", url: file.url, source: "cloud" })
        : Promise.reject(new Error("not readable")),
    forceArchiveOversized: force,
  };
}

/**
 * The PRODUCTION-shaped desktop transport: `supportsLocalFallback: true` (the
 * real desktop always enables the local read fallback). A permanentlyUnavailable
 * descriptor carries `byteSize: null`, so the read hook's cloud-oversized render
 * gate does NOT fire (it keys off a non-null byteSize), and the panel still
 * reaches the terminal state where the force action is offered — this guards the
 * FEA-3489 review concern that the >2GiB local-fallback render gate could
 * pre-empt the action. The local read rejects (no readable copy) exactly like
 * production.
 */
function productionDesktopTransport(
  force: NonNullable<TranscriptBytesTransport["forceArchiveOversized"]>
): TranscriptBytesTransport {
  return {
    supportsLocalFallback: true,
    resolveFetchUrl: ({ file }) =>
      file.url
        ? Promise.resolve({ kind: "ready", url: file.url, source: "cloud" })
        : Promise.reject(new Error("not readable")),
    forceArchiveOversized: force,
  };
}

function renderWithTransport(
  transport: TranscriptBytesTransport,
  route: FixtureRoute
) {
  return render(
    <AppCoreStoryProviders apiRoutes={[route]}>
      <TranscriptBytesTransportProvider transport={transport}>
        <SessionTranscriptPanel session={session()} />
      </TranscriptBytesTransportProvider>
    </AppCoreStoryProviders>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionTranscriptPanel force-archive (FEA-3489)", () => {
  it("desktop offers an ENABLED force-archive action that uploads and refetches on success", async () => {
    stubBytes();
    // The cloud descriptor starts terminally too-large; after the forced upload
    // settles, the next descriptor read reports it available with a signed URL, so
    // the panel flips from the terminal state to the rendered transcript.
    let available = false;
    const descriptorRoute: FixtureRoute = {
      method: "GET",
      path: `/agent-sessions/${SESSION_ID}/transcript`,
      respond: () =>
        available
          ? { sessionId: SESSION_ID, files: [descriptor()] }
          : { sessionId: SESSION_ID, files: [tooLargeDescriptor()] },
    };
    const forceCalls: Array<{ externalSessionId: string; fileKey: string }> =
      [];
    const transport = desktopTransport((input) => {
      forceCalls.push(input);
      available = true; // the forced upload archived the file
      return Promise.resolve({ kind: "uploaded", caughtUp: true });
    });
    renderWithTransport(transport, descriptorRoute);

    // Terminal too-large state with the ENABLED override (desktop has the local file).
    expect(await screen.findByText(NOT_ARCHIVED_TITLE)).toBeInTheDocument();
    const forceButton = screen.getByRole("button", {
      name: FORCE_ARCHIVE_BUTTON_NAME,
    });
    expect(forceButton).toBeEnabled();

    fireEvent.click(forceButton);

    // The forced upload ran with the local dead-row identity, then the panel
    // refetched and rendered the now-available transcript.
    await waitFor(() =>
      expect(forceCalls).toEqual([
        { externalSessionId: "ext-session-1", fileKey: "main" },
      ])
    );
    expect(await screen.findByText("cloud hello")).toBeInTheDocument();
  });

  it("a failed force-archive surfaces a retryable error and keeps the terminal state", async () => {
    stubBytes();
    const transport = desktopTransport(() =>
      Promise.resolve({ kind: "failed", reason: "network reset" })
    );
    renderWithTransport(transport, {
      method: "GET",
      path: `/agent-sessions/${SESSION_ID}/transcript`,
      respond: () => ({ sessionId: SESSION_ID, files: [tooLargeDescriptor()] }),
    });

    const forceButton = await screen.findByRole("button", {
      name: FORCE_ARCHIVE_BUTTON_NAME,
    });
    fireEvent.click(forceButton);

    // Retryable failure (distinct from the size-cap permanent state) shown inline;
    // the terminal state persists so the user can try again.
    expect(
      await screen.findByText(FORCE_ARCHIVE_FAILED_NOTICE)
    ).toBeInTheDocument();
    expect(screen.getByText(NOT_ARCHIVED_TITLE)).toBeInTheDocument();
  });

  it("the PRODUCTION desktop transport (supportsLocalFallback: true) still reaches the ENABLED force action", async () => {
    stubBytes();
    const forceCalls: Array<{ externalSessionId: string; fileKey: string }> =
      [];
    // Production shape: local fallback enabled. A permanentlyUnavailable
    // descriptor has byteSize: null, so the render gate does not pre-empt the
    // terminal state — the force action is reachable.
    const transport = productionDesktopTransport((input) => {
      forceCalls.push(input);
      return Promise.resolve({ kind: "uploaded", caughtUp: true });
    });
    renderWithTransport(transport, {
      method: "GET",
      path: `/agent-sessions/${SESSION_ID}/transcript`,
      respond: () => ({ sessionId: SESSION_ID, files: [tooLargeDescriptor()] }),
    });

    expect(await screen.findByText(NOT_ARCHIVED_TITLE)).toBeInTheDocument();
    const forceButton = await screen.findByRole("button", {
      name: FORCE_ARCHIVE_BUTTON_NAME,
    });
    expect(forceButton).toBeEnabled();
    fireEvent.click(forceButton);
    await waitFor(() =>
      expect(forceCalls).toEqual([
        { externalSessionId: "ext-session-1", fileKey: "main" },
      ])
    );
  });

  it("the terminal force action wins over the local oversized 'Load full transcript' gate", async () => {
    stubBytes();
    // wongk review: on the production transport the local `.jsonl` for a
    // too-large-for-cloud transcript is still on disk and over the 25 MiB
    // auto-load cap, so `resolveFetchUrl` resolves `oversized`. That would show
    // "Load full transcript" (a LOCAL-only render) and pre-empt the force action
    // — so the panel must let the `permanentlyUnavailable` terminal state win.
    const forceCalls: Array<{ externalSessionId: string; fileKey: string }> =
      [];
    const transport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      // The local file exceeds the render cap: resolve `oversized`, exactly as the
      // real desktop transport does for a >25 MiB on-disk file.
      resolveFetchUrl: () =>
        Promise.resolve({
          kind: "oversized",
          byteSize: 3 * 1024 * 1024 * 1024,
          source: "local",
        }),
      forceArchiveOversized: (input) => {
        forceCalls.push(input);
        return Promise.resolve({ kind: "uploaded", caughtUp: true });
      },
    };
    renderWithTransport(transport, {
      method: "GET",
      path: `/agent-sessions/${SESSION_ID}/transcript`,
      respond: () => ({ sessionId: SESSION_ID, files: [tooLargeDescriptor()] }),
    });

    // Terminal "not archived" state + the force action, NOT the "Load full
    // transcript" local-render gate.
    expect(await screen.findByText(NOT_ARCHIVED_TITLE)).toBeInTheDocument();
    const forceButton = await screen.findByRole("button", {
      name: FORCE_ARCHIVE_BUTTON_NAME,
    });
    expect(
      screen.queryByRole("button", { name: LOAD_FULL_TRANSCRIPT_NAME })
    ).not.toBeInTheDocument();

    fireEvent.click(forceButton);
    await waitFor(() =>
      expect(forceCalls).toEqual([
        { externalSessionId: "ext-session-1", fileKey: "main" },
      ])
    );
  });

  it("a permanent result renders terminal copy with no retry invitation", async () => {
    stubBytes();
    const transport = desktopTransport(() =>
      Promise.resolve({ kind: "permanent", reason: "source gone" })
    );
    renderWithTransport(transport, {
      method: "GET",
      path: `/agent-sessions/${SESSION_ID}/transcript`,
      respond: () => ({ sessionId: SESSION_ID, files: [tooLargeDescriptor()] }),
    });

    const forceButton = await screen.findByRole("button", {
      name: FORCE_ARCHIVE_BUTTON_NAME,
    });
    fireEvent.click(forceButton);

    // Terminal, non-retryable copy — distinct from the retryable `failed` line.
    expect(
      await screen.findByText(FORCE_ARCHIVE_PERMANENT_NOTICE)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(FORCE_ARCHIVE_FAILED_NOTICE)
    ).not.toBeInTheDocument();
  });

  it("an in-progress (not-caught-up) upload reports that the sync started", async () => {
    stubBytes();
    // A large forced upload that is not yet caught up leaves the terminal state
    // in place (the descriptor is still too-large) and reassures the user it will
    // appear once the upload finishes — it does NOT falsely claim it is ready.
    const transport = desktopTransport(() =>
      Promise.resolve({ kind: "uploaded", caughtUp: false })
    );
    renderWithTransport(transport, {
      method: "GET",
      path: `/agent-sessions/${SESSION_ID}/transcript`,
      respond: () => ({ sessionId: SESSION_ID, files: [tooLargeDescriptor()] }),
    });

    const forceButton = await screen.findByRole("button", {
      name: FORCE_ARCHIVE_BUTTON_NAME,
    });
    fireEvent.click(forceButton);

    expect(
      await screen.findByText(FORCE_ARCHIVE_IN_PROGRESS_NOTICE)
    ).toBeInTheDocument();
    expect(screen.getByText(NOT_ARCHIVED_TITLE)).toBeInTheDocument();
  });

  it("shows the retries_exhausted terminal copy and never offers force-archive for it (ISS-4621)", async () => {
    stubBytes();
    // ISS-4621: the desktop stopped retrying after repeated upload failures and
    // told the cloud so (`retries_exhausted`). Even on a desktop-shaped
    // transport — where the force action WOULD render for the size-cap reason —
    // the terminal state names the situation specifically (not the generic
    // unknown-reason fallback) and offers no force-archive: the revive
    // predicate only covers the size-cap terminal, so the button would be a
    // dead end here.
    const forceCalls: unknown[] = [];
    const route: FixtureRoute = {
      method: "GET",
      path: `/agent-sessions/${SESSION_ID}/transcript`,
      respond: () => ({
        sessionId: SESSION_ID,
        files: [
          descriptor({
            availability: "permanentlyUnavailable",
            url: null,
            byteSize: null,
            rawSha256: null,
            uploadedAt: null,
            permanentFailureReason: "retries_exhausted",
          }),
        ],
      }),
    };
    renderWithTransport(
      desktopTransport((input) => {
        forceCalls.push(input);
        return Promise.resolve({ kind: "uploaded", caughtUp: true });
      }),
      route
    );

    expect(await screen.findByText(NOT_ARCHIVED_TITLE)).toBeInTheDocument();
    expect(screen.getByText(RETRIES_EXHAUSTED_NOTICE)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: FORCE_ARCHIVE_BUTTON_NAME })
    ).not.toBeInTheDocument();
    expect(forceCalls.length, "force-archive must never fire").toBe(0);
  });

  it("resets a settled result when the transcript identity changes (no stale carry-over)", async () => {
    stubBytes();
    const transport = desktopTransport(() =>
      Promise.resolve({ kind: "failed", reason: "network reset" })
    );
    // The panel keys the action by identity, so a re-render with a NEW identity
    // remounts it and clears the prior transcript's failed notice (FEA-3489
    // review — pending/error state must not survive `?file=` navigation).
    const renderAction = (externalSessionId: string) => (
      <AppCoreStoryProviders>
        <TranscriptBytesTransportProvider transport={transport}>
          <TranscriptForceArchiveAction
            externalSessionId={externalSessionId}
            fileKey="main"
            key={`${externalSessionId}:main`}
            onArchived={() => undefined}
          />
        </TranscriptBytesTransportProvider>
      </AppCoreStoryProviders>
    );
    const view = render(renderAction("ext-session-1"));

    fireEvent.click(
      await screen.findByRole("button", { name: FORCE_ARCHIVE_BUTTON_NAME })
    );
    expect(
      await screen.findByText(FORCE_ARCHIVE_FAILED_NOTICE)
    ).toBeInTheDocument();

    // Navigate to a different transcript in place: the failed notice must clear.
    view.rerender(renderAction("ext-session-2"));
    await waitFor(() =>
      expect(
        screen.queryByText(FORCE_ARCHIVE_FAILED_NOTICE)
      ).not.toBeInTheDocument()
    );
  });
});

const STILL_SYNCING_TITLE = "Transcript still syncing";
const RETRY_BUTTON_NAME = /retry/i;
const MATERIALIZED_UNAVAILABLE_NOTICE =
  /source wasn.t ready when it was last archived/i;

function materializedUnavailableDescriptor(): TranscriptFileDescriptor {
  return descriptor({
    availability: "permanentlyUnavailable",
    url: null,
    byteSize: null,
    rawSha256: null,
    uploadedAt: null,
    permanentFailureReason: "materialized_source_unavailable",
  });
}

/** A web-shaped transport: no `forceArchiveOversized`, no readable null-url. */
function webTransport(): TranscriptBytesTransport {
  return {
    supportsLocalFallback: false,
    resolveFetchUrl: ({ file }) =>
      file.url
        ? Promise.resolve({ kind: "ready", url: file.url, source: "cloud" })
        : Promise.reject(new Error("not readable")),
  };
}

describe("SessionTranscriptPanel materialized-source-unavailable (ISS-4695 item 3)", () => {
  it("renders the RECOVERABLE 'still syncing' headline, not the dead-end 'not archived'", async () => {
    stubBytes();
    renderWithTransport(webTransport(), {
      method: "GET",
      path: `/agent-sessions/${SESSION_ID}/transcript`,
      respond: () => ({
        sessionId: SESSION_ID,
        files: [materializedUnavailableDescriptor()],
      }),
    });

    // The panel title must NOT contradict the recoverable `syncing` disposition
    // the same reason maps to server-side: the headline reads "still syncing",
    // never the hard "Transcript not archived" reserved for reasons that are
    // genuinely never coming (too_large / source_gone / retries_exhausted).
    expect(await screen.findByText(STILL_SYNCING_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(NOT_ARCHIVED_TITLE)).not.toBeInTheDocument();
    // Still explains WHY, and offers no Retry (recovery is the desktop redrive on
    // the source machine, not a user click here).
    expect(
      screen.getByText(MATERIALIZED_UNAVAILABLE_NOTICE)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RETRY_BUTTON_NAME })
    ).not.toBeInTheDocument();
  });
});
