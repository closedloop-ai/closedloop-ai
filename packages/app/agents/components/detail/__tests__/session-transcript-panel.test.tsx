import type {
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import type { TranscriptFileDescriptor } from "@repo/api/src/types/desktop-transcripts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../../shared/storybook/fixture-fetch";
import {
  type TranscriptBytesTransport,
  TranscriptBytesTransportProvider,
} from "../../../data-source/transcript-bytes-transport";
import { TRANSCRIPT_DOWNLOAD_PROGRESS_FLAG } from "../../../hooks/use-session-transcript";
import { withTranscriptFileParam } from "../../../lib/session-transcript-href";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionTranscriptPanel } from "../session-transcript-panel";

const SESSION_ID = "session-transcript-1";
const SIGNED_URL = "https://s3.invalid/session/main.jsonl";
const RETRY_BUTTON_NAME = /retry/i;
const LOAD_FULL_BUTTON_NAME = /load full transcript/i;
const CANCEL_BUTTON_NAME = /cancel/i;
const UNSUPPORTED_CURSOR_NOTICE = /not yet available for cursor/i;
const NO_TRANSCRIPT_NOTICE = /No transcript is available/i;
const LOCAL_COPY_NOTICE = /showing your local copy/i;
const SIZE_LIMIT_NOTICE = /over the automatic archive size limit/i;
const FORCE_ARCHIVE_BUTTON_NAME = /sync this transcript anyway/i;
const SOURCE_GONE_NOTICE =
  /local transcript was removed before it could be archived/i;
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
const SECRET_PLACEHOLDER = `sk-${"a".repeat(32)}`;
const REDACTED_SECRET_MARKER = "[REDACTED:sk]";
const REDACTED_TRANSCRIPT_BODY = transcriptBodyWithText(
  `cloud ${SECRET_PLACEHOLDER} hello`
);

// A Claude transcript whose FIRST assistant turn carries a fractional token
// counter (trips `InvalidTokenCountError`) followed by a good turn. The Claude
// parser now DROPS the bad snapshot and keeps parsing (mirrors the Codex fix),
// so the whole transcript still renders instead of blanking on one bad token.
const BAD_TOKEN_GRACEFUL_BODY = `${JSON.stringify({
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
    id: "msg-bad",
    content: [{ type: "text", text: "bad token reply" }],
    usage: { input_tokens: 10.5, output_tokens: 5 },
  },
})}\n${JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-09T12:00:02.000Z",
  message: {
    role: "assistant",
    model: "claude-opus-4",
    id: "msg-good",
    content: [{ type: "text", text: "good token reply" }],
    usage: { input_tokens: 20, output_tokens: 7 },
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

function transcriptRoute(file: TranscriptFileDescriptor): FixtureRoute {
  return {
    method: "GET",
    path: `/agent-sessions/${SESSION_ID}/transcript`,
    respond: () => ({ sessionId: SESSION_ID, files: [file] }),
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

function session(
  overrides: Partial<AgentSessionDetail> = {}
): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    // A cloud-backed detail carries the FR8 availability summary — its presence
    // is what enables the cloud transcript read (desktop-local detail omits it).
    transcripts: [
      {
        fileKey: "main",
        availability: "available",
        uploadedAt: "2026-07-09T12:05:00.000Z",
        permanentFailureReason: null,
      },
    ],
    ...overrides,
  });
}

function renderPanel(input: {
  routes?: FixtureRoute[];
  session: AgentSessionDetail;
  fallbackItems?: TurnItem[];
  enabledFlags?: readonly string[];
}) {
  return render(
    <AppCoreStoryProviders
      apiRoutes={input.routes}
      enabledFlags={input.enabledFlags}
    >
      <SessionTranscriptPanel
        fallbackItems={input.fallbackItems}
        session={input.session}
      />
    </AppCoreStoryProviders>
  );
}

function stubBytes(status = 200, body = TRANSCRIPT_BODY): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request) =>
      String(url) === SIGNED_URL
        ? Promise.resolve(new Response(body, { status }))
        : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
    )
  );
}

function transcriptBodyWithText(text: string): string {
  return `${JSON.stringify({
    type: "user",
    timestamp: "2026-07-09T12:00:00.000Z",
    cwd: "/home/me/project",
    message: { role: "user", content: text },
  })}\n`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionTranscriptPanel", () => {
  it("renders the parsed cloud transcript when the main file is available", async () => {
    stubBytes();
    renderPanel({
      routes: [transcriptRoute(descriptor())],
      session: session(),
      fallbackItems: [dbPrompt("db prompt")],
    });

    expect(await screen.findByText("cloud hello")).toBeInTheDocument();
    expect(screen.getByText("cloud reply")).toBeInTheDocument();
    // Cloud is preferred: the DB fallback never renders.
    expect(screen.queryByText("db prompt")).not.toBeInTheDocument();
  });

  it("redacts secret-shaped placeholders from web signed-URL transcript reads", async () => {
    stubBytes(200, REDACTED_TRANSCRIPT_BODY);
    renderPanel({
      routes: [transcriptRoute(descriptor())],
      session: session(),
    });

    expect(
      await screen.findByText(`cloud ${REDACTED_SECRET_MARKER} hello`)
    ).toBeInTheDocument();
    expect(
      screen.queryByText((content) => content.includes(SECRET_PLACEHOLDER))
    ).not.toBeInTheDocument();
  });

  it("shows a distinct 'still syncing' state for a pending upload", async () => {
    stubBytes();
    renderPanel({
      routes: [
        transcriptRoute(
          descriptor({
            availability: "uploadPending",
            url: null,
            byteSize: null,
            rawSha256: null,
            uploadedAt: null,
          })
        ),
      ],
      session: session(),
    });

    expect(
      await screen.findByText("Transcript still syncing")
    ).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("shows an error + retry for a failed upload", async () => {
    stubBytes();
    renderPanel({
      routes: [
        transcriptRoute(
          descriptor({
            availability: "uploadFailed",
            url: null,
            byteSize: null,
            rawSha256: null,
          })
        ),
      ],
      session: session(),
    });

    expect(
      await screen.findByText("Transcript upload failed")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RETRY_BUTTON_NAME })
    ).toBeInTheDocument();
  });

  it("shows a terminal 'not archived' state with no retry for a permanently-skipped transcript (FEA-3476)", async () => {
    stubBytes();
    renderPanel({
      routes: [
        transcriptRoute(
          descriptor({
            availability: "permanentlyUnavailable",
            url: null,
            byteSize: null,
            rawSha256: null,
            uploadedAt: null,
            permanentFailureReason: "too_large",
          })
        ),
      ],
      session: session(),
    });

    expect(
      await screen.findByText("Transcript not archived")
    ).toBeInTheDocument();
    // Explains WHY (over the size limit) and the way out (sync from the machine),
    // and never offers a Retry (terminal for the automatic lane).
    expect(screen.getByText(SIZE_LIMIT_NOTICE)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RETRY_BUTTON_NAME })
    ).not.toBeInTheDocument();
    // FEA-3489 web gating: the default web transport has no
    // `forceArchiveOversized`, so the override renders NOTHING here (no dead
    // chrome) — the description alone tells the user to sync from the machine
    // where the session ran (PRD-536: the web surface does not offer the action).
    expect(
      screen.queryByRole("button", { name: FORCE_ARCHIVE_BUTTON_NAME })
    ).not.toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("shows a terminal 'not archived' state with no retry for a source_gone transcript (FEA-3555)", async () => {
    stubBytes();
    renderPanel({
      routes: [
        transcriptRoute(
          descriptor({
            availability: "permanentlyUnavailable",
            url: null,
            byteSize: null,
            rawSha256: null,
            uploadedAt: null,
            permanentFailureReason: "source_gone",
          })
        ),
      ],
      session: session(),
    });

    expect(
      await screen.findByText("Transcript not archived")
    ).toBeInTheDocument();
    // Terminal dead end mirroring the too_large sibling: it explains WHY (the
    // local source was removed before archival) and never offers a Retry.
    expect(screen.getByText(SOURCE_GONE_NOTICE)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RETRY_BUTTON_NAME })
    ).not.toBeInTheDocument();
    // FEA-3489: a source_gone file has nothing left to upload, so the force-archive
    // override is NOT offered (only the size-cap reason gets it).
    expect(
      screen.queryByRole("button", { name: FORCE_ARCHIVE_BUTTON_NAME })
    ).not.toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("gates an oversized transcript behind an explicit load action", async () => {
    stubBytes();
    renderPanel({
      routes: [transcriptRoute(descriptor({ byteSize: 40 * 1024 * 1024 }))],
      session: session(),
    });

    expect(await screen.findByText("Large transcript")).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: LOAD_FULL_BUTTON_NAME })
    );
    expect(await screen.findByText("cloud hello")).toBeInTheDocument();
  });

  it("shows the oversized gate over a DB fallback (cloud state wins)", async () => {
    stubBytes();
    renderPanel({
      routes: [transcriptRoute(descriptor({ byteSize: 40 * 1024 * 1024 }))],
      session: session(),
      fallbackItems: [dbPrompt("db prompt")],
    });

    // The actionable oversized gate preempts the stale DB trace, so QA can still
    // reach "Load full transcript" instead of it being buried.
    expect(await screen.findByText("Large transcript")).toBeInTheDocument();
    expect(screen.queryByText("db prompt")).not.toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("shows the retryable error over a DB fallback (cloud state wins)", async () => {
    stubBytes(500);
    renderPanel({
      routes: [transcriptRoute(descriptor())],
      session: session(),
      fallbackItems: [dbPrompt("db prompt")],
    });

    // A readable fetch/parse failure preempts the DB trace so Retry stays
    // reachable rather than hidden behind stale content.
    expect(
      await screen.findByText("Couldn't load transcript")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RETRY_BUTTON_NAME })
    ).toBeInTheDocument();
    expect(screen.queryByText("db prompt")).not.toBeInTheDocument();
  });

  it("renders the whole transcript when one Claude turn has a bad token value (graceful degradation)", async () => {
    // A single fractional token counter used to trip `InvalidTokenCountError`
    // and blank the entire transcript. The Claude parser now drops that turn's
    // usage and keeps parsing, so both turns render and the NEXT good turn's
    // usage is still counted — no "Couldn't parse transcript" error.
    stubBytes(200, BAD_TOKEN_GRACEFUL_BODY);
    renderPanel({
      routes: [
        transcriptRoute(
          descriptor({ byteSize: BAD_TOKEN_GRACEFUL_BODY.length })
        ),
      ],
      session: session(),
    });

    expect(await screen.findByText("good token reply")).toBeInTheDocument();
    expect(screen.getByText("bad token reply")).toBeInTheDocument();
    // The parse succeeded — neither the parse-specific nor the generic error.
    expect(screen.queryByText("Couldn't parse transcript")).toBeNull();
    expect(screen.queryByText("Couldn't load transcript")).toBeNull();
  });

  // The `missing` availability state (FEA-3634 — "Transcript hasn't synced
  // yet", including the web DB-fallback suppression this test used to cover)
  // lives in `session-transcript-panel-missing.test.tsx`.

  it("shows a distinct unavailable state for an unsupported harness (no web DB fallback)", async () => {
    stubBytes();
    renderPanel({
      routes: [transcriptRoute(descriptor())],
      session: session({ harness: "cursor" }),
      fallbackItems: [dbPrompt("cursor db prompt")],
    });

    // FEA-2718: no web DB fallback. An unsupported harness gets a distinct
    // "rendering unavailable" state rather than the DB/local trace.
    expect(
      await screen.findByText("Transcript rendering unavailable")
    ).toBeInTheDocument();
    expect(screen.getByText(UNSUPPORTED_CURSOR_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText("cursor db prompt")).not.toBeInTheDocument();
  });

  it("renders the local trace without any cloud read when the detail omits the transcript summary (desktop-local)", async () => {
    stubBytes();
    const descriptorHits: string[] = [];
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: `/agent-sessions/${SESSION_ID}/transcript`,
            respond: ({ pathname }) => {
              descriptorHits.push(pathname);
              return { sessionId: SESSION_ID, files: [descriptor()] };
            },
          },
        ]}
      >
        <SessionTranscriptPanel
          fallbackItems={[dbPrompt("desktop local prompt")]}
          // Desktop-local detail: no `transcripts` summary → cloud read is gated
          // off, so the inert desktop transport is never invoked.
          session={createAgentSessionDetailFixture({
            id: SESSION_ID,
            harness: "claude",
          })}
        />
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText("desktop local prompt")).toBeInTheDocument();
    expect(descriptorHits).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reads the on-disk transcript from the detail summary when the cloud route is inert (desktop-local gating fix)", async () => {
    // #2977 local-gating fix: on the desktop-local surface the cloud descriptor
    // route is inert (empty files), but the detail now carries a `transcripts`
    // availability summary for the on-disk `.jsonl`. That summary enables the
    // hook and seeds a LOCAL read descriptor, so the desktop transport serves the
    // on-disk copy (source "local") — the trace renders instead of the projected
    // `fallbackItems`, and the "showing your local copy" notice is shown.
    const localAppUrl = `app://renderer/transcripts/${"d".repeat(64)}.jsonl`;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) =>
        String(url) === localAppUrl
          ? Promise.resolve(new Response(TRANSCRIPT_BODY, { status: 200 }))
          : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
      )
    );
    const localTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: () =>
        Promise.resolve({ kind: "ready", url: localAppUrl, source: "local" }),
    };
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: `/agent-sessions/${SESSION_ID}/transcript`,
            // Inert desktop-local cloud route: no files.
            respond: () => ({ sessionId: SESSION_ID, files: [] }),
          },
        ]}
      >
        <TranscriptBytesTransportProvider transport={localTransport}>
          <SessionTranscriptPanel
            fallbackItems={[dbPrompt("desktop local prompt")]}
            session={session()}
          />
        </TranscriptBytesTransportProvider>
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText("cloud hello")).toBeInTheDocument();
    expect(screen.getByText("cloud reply")).toBeInTheDocument();
    expect(screen.getByText(LOCAL_COPY_NOTICE)).toBeInTheDocument();
    // The parsed local trace wins over the projected fallback.
    expect(screen.queryByText("desktop local prompt")).not.toBeInTheDocument();
  });

  it("redacts secret-shaped placeholders from desktop cloud-cache app-url reads", async () => {
    const cloudCacheAppUrl = `app://renderer/transcripts/${"f".repeat(
      64
    )}.jsonl`;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) =>
        String(url) === cloudCacheAppUrl
          ? Promise.resolve(
              new Response(REDACTED_TRANSCRIPT_BODY, { status: 200 })
            )
          : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
      )
    );
    const cloudCacheTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: () =>
        Promise.resolve({
          kind: "ready",
          url: cloudCacheAppUrl,
          source: "cloud",
        }),
    };
    render(
      <AppCoreStoryProviders apiRoutes={[transcriptRoute(descriptor())]}>
        <TranscriptBytesTransportProvider transport={cloudCacheTransport}>
          <SessionTranscriptPanel session={session()} />
        </TranscriptBytesTransportProvider>
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText(`cloud ${REDACTED_SECRET_MARKER} hello`)
    ).toBeInTheDocument();
    expect(
      screen.queryByText((content) => content.includes(SECRET_PLACEHOLDER))
    ).not.toBeInTheDocument();
  });

  it("degrades to the projected local trace when a present on-disk file parses to no content (desktop-local)", async () => {
    // Thread P2 (session-transcript-panel:165): the detail carries a `transcripts`
    // summary (so `hasTranscriptContext` is true) but the on-disk `.jsonl` parses
    // to an EMPTY session (no turns). Suppression must key on *produced content*,
    // not mere context — otherwise the pane blanks to "No transcript" even though
    // a projected `fallbackItems` trace is available. Here the empty parse yields
    // no `cloudItems`, so the projected fallback renders instead of blanking.
    const localAppUrl = `app://renderer/transcripts/${"e".repeat(64)}.jsonl`;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) =>
        String(url) === localAppUrl
          ? Promise.resolve(new Response("", { status: 200 }))
          : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
      )
    );
    const localTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: () =>
        Promise.resolve({ kind: "ready", url: localAppUrl, source: "local" }),
    };
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: `/agent-sessions/${SESSION_ID}/transcript`,
            // Inert desktop-local cloud route: no files.
            respond: () => ({ sessionId: SESSION_ID, files: [] }),
          },
        ]}
      >
        <TranscriptBytesTransportProvider transport={localTransport}>
          <SessionTranscriptPanel
            fallbackItems={[dbPrompt("desktop local prompt")]}
            session={session()}
          />
        </TranscriptBytesTransportProvider>
      </AppCoreStoryProviders>
    );

    // The projected local trace renders; the pane does NOT blank to "No transcript".
    expect(await screen.findByText("desktop local prompt")).toBeInTheDocument();
    expect(screen.queryByText(NO_TRANSCRIPT_NOTICE)).not.toBeInTheDocument();
  });

  it("redacts secret-shaped placeholders from desktop local fallback reads", async () => {
    const localAppUrl = `app://renderer/transcripts/${"1".repeat(64)}.jsonl`;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) =>
        String(url) === localAppUrl
          ? Promise.resolve(
              new Response(REDACTED_TRANSCRIPT_BODY, { status: 200 })
            )
          : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
      )
    );
    const localTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: () =>
        Promise.resolve({ kind: "ready", url: localAppUrl, source: "local" }),
    };
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          transcriptRoute(
            descriptor({
              availability: "uploadPending",
              url: null,
              byteSize: null,
              rawSha256: null,
              uploadedAt: null,
            })
          ),
        ]}
      >
        <TranscriptBytesTransportProvider transport={localTransport}>
          <SessionTranscriptPanel session={session()} />
        </TranscriptBytesTransportProvider>
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText(`cloud ${REDACTED_SECRET_MARKER} hello`)
    ).toBeInTheDocument();
    expect(screen.getByText(LOCAL_COPY_NOTICE)).toBeInTheDocument();
    expect(
      screen.queryByText((content) => content.includes(SECRET_PLACEHOLDER))
    ).not.toBeInTheDocument();
  });

  it("shows the 'local copy' indicator and the trace when main falls back to the local file (desktop)", async () => {
    // Desktop transport: cloud descriptor is not readable (null url/sha), but a
    // local copy is served over `app://` with source "local". The panel renders
    // the conversation AND a subtle "showing your local copy" notice instead of
    // the dead/empty state.
    const localAppUrl = `app://renderer/transcripts/${"c".repeat(64)}.jsonl`;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) =>
        String(url) === localAppUrl
          ? Promise.resolve(new Response(TRANSCRIPT_BODY, { status: 200 }))
          : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
      )
    );
    const localTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: () =>
        Promise.resolve({ kind: "ready", url: localAppUrl, source: "local" }),
    };
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          transcriptRoute(
            descriptor({
              availability: "uploadPending",
              url: null,
              byteSize: null,
              rawSha256: null,
              uploadedAt: null,
            })
          ),
        ]}
      >
        <TranscriptBytesTransportProvider transport={localTransport}>
          <SessionTranscriptPanel session={session()} />
        </TranscriptBytesTransportProvider>
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText("cloud hello")).toBeInTheDocument();
    expect(screen.getByText(LOCAL_COPY_NOTICE)).toBeInTheDocument();
  });

  it("shows the FR8 'still syncing' state (not a hard error) when a desktop local fallback fails on an uploadPending file", async () => {
    // On desktop, `isReadable` is set by the static supportsLocalFallback
    // capability, so an uploadPending file still runs the parse — and when the
    // local fallback comes up empty the parse errors. That error must NOT mask
    // the informative FR8 "still syncing" state (the pre-fallback behavior).
    const failingLocalTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: () =>
        Promise.reject(new Error("no local copy available")),
    };
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          transcriptRoute(
            descriptor({
              availability: "uploadPending",
              url: null,
              byteSize: null,
              rawSha256: null,
              uploadedAt: null,
            })
          ),
        ]}
      >
        <TranscriptBytesTransportProvider transport={failingLocalTransport}>
          <SessionTranscriptPanel session={session()} />
        </TranscriptBytesTransportProvider>
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText("Transcript still syncing")
    ).toBeInTheDocument();
    // The generic hard error must NOT be shown for a not-yet-uploaded file.
    expect(screen.queryByText("Couldn't load transcript")).toBeNull();
  });

  it("shows the FR8 'upload failed' state (not the generic error) when a desktop local fallback fails on an uploadFailed file", async () => {
    const failingLocalTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: () =>
        Promise.reject(new Error("no local copy available")),
    };
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          transcriptRoute(
            descriptor({
              availability: "uploadFailed",
              url: null,
              byteSize: null,
              rawSha256: null,
              uploadedAt: null,
            })
          ),
        ]}
      >
        <TranscriptBytesTransportProvider transport={failingLocalTransport}>
          <SessionTranscriptPanel session={session()} />
        </TranscriptBytesTransportProvider>
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText("Transcript upload failed")
    ).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load transcript")).toBeNull();
  });

  it("still shows the generic retryable error for an actually-readable file whose fetch fails", async () => {
    // Regression guard for the reorder: the FR8 precedence must NOT swallow a
    // genuine fetch/parse failure on an `available`/`stale` file — that is a real
    // error worth the Retry affordance.
    const failingTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: () => Promise.reject(new Error("network down")),
    };
    render(
      <AppCoreStoryProviders apiRoutes={[transcriptRoute(descriptor())]}>
        <TranscriptBytesTransportProvider transport={failingTransport}>
          <SessionTranscriptPanel session={session()} />
        </TranscriptBytesTransportProvider>
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText("Couldn't load transcript")
    ).toBeInTheDocument();
  });

  it("shows the 'Load full transcript' gate for an oversized LOCAL fallback file", async () => {
    // The cloud descriptor is not readable AND carries no byteSize (not yet
    // uploaded); the desktop transport reports the on-disk file is over the cap.
    // The panel must show the explicit-load gate (not auto-parse the big file).
    const localTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: () =>
        Promise.resolve({
          kind: "oversized",
          byteSize: 40 * 1024 * 1024,
          source: "local",
        }),
    };
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          transcriptRoute(
            descriptor({
              availability: "uploadPending",
              url: null,
              byteSize: null,
              rawSha256: null,
              uploadedAt: null,
            })
          ),
        ]}
      >
        <TranscriptBytesTransportProvider transport={localTransport}>
          <SessionTranscriptPanel session={session()} />
        </TranscriptBytesTransportProvider>
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText("Large transcript")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: LOAD_FULL_BUTTON_NAME })
    ).toBeInTheDocument();
  });

  it("renders a deep-linkable file switcher when subagent transcripts exist", async () => {
    stubBytes();
    render(
      <AppCoreStoryProviders apiRoutes={[transcriptRoute(descriptor())]}>
        <SessionTranscriptPanel
          buildTranscriptFileHref={(fileKey) =>
            withTranscriptFileParam(`/sessions/${SESSION_ID}`, fileKey)
          }
          fileKey="main"
          session={session({
            transcripts: [
              {
                fileKey: "main",
                availability: "available",
                uploadedAt: "2026-07-09T12:05:00.000Z",
                permanentFailureReason: null,
              },
              {
                fileKey: "subagent:agent-7",
                availability: "available",
                uploadedAt: "2026-07-09T12:06:00.000Z",
                permanentFailureReason: null,
              },
            ],
          })}
        />
      </AppCoreStoryProviders>
    );

    const mainTab = await screen.findByRole("link", { name: "Main" });
    const subagentTab = screen.getByRole("link", { name: "Subagent agent-7" });
    expect(mainTab).toHaveAttribute("href", `/sessions/${SESSION_ID}`);
    expect(subagentTab).toHaveAttribute(
      "href",
      `/sessions/${SESSION_ID}?file=subagent%3Aagent-7`
    );
  });

  it("redacts secret-shaped placeholders when rendering a deep-linked subagent file", async () => {
    stubBytes(200, REDACTED_TRANSCRIPT_BODY);
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          transcriptFilesRoute([
            descriptor(),
            descriptor({
              fileKey: "subagent:agent-7",
              byteSize: REDACTED_TRANSCRIPT_BODY.length,
            }),
          ]),
        ]}
      >
        <SessionTranscriptPanel
          buildTranscriptFileHref={(fileKey) =>
            withTranscriptFileParam(`/sessions/${SESSION_ID}`, fileKey)
          }
          fileKey="subagent:agent-7"
          session={session({
            transcripts: [
              {
                fileKey: "main",
                availability: "available",
                uploadedAt: "2026-07-09T12:05:00.000Z",
                permanentFailureReason: null,
              },
              {
                fileKey: "subagent:agent-7",
                availability: "available",
                uploadedAt: "2026-07-09T12:06:00.000Z",
                permanentFailureReason: null,
              },
            ],
          })}
        />
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText(`cloud ${REDACTED_SECRET_MARKER} hello`)
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Main" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Subagent agent-7" })
    ).toBeInTheDocument();
    expect(
      screen.queryByText((content) => content.includes(SECRET_PLACEHOLDER))
    ).not.toBeInTheDocument();
  });

  describe("download progress (FEA-3447)", () => {
    // A stream that emits one chunk then stays open, so a deferred download is
    // observably in flight; the returned `finish` closes it to let the parse run.
    function stubStreamingBytes(body = TRANSCRIPT_BODY) {
      const bytes = new TextEncoder().encode(body);
      const mid = Math.floor(bytes.length / 2);
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          c.enqueue(bytes.slice(0, mid));
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL | Request) =>
          String(url) === SIGNED_URL
            ? Promise.resolve(
                new Response(stream, {
                  status: 200,
                  headers: { "Content-Length": String(bytes.length) },
                })
              )
            : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
        )
      );
      return {
        finish() {
          controller?.enqueue(bytes.slice(mid));
          controller?.close();
        },
      };
    }

    it("shows streaming progress + a cancel while an oversized load downloads, then renders the transcript", async () => {
      const stream = stubStreamingBytes();
      renderPanel({
        enabledFlags: [TRANSCRIPT_DOWNLOAD_PROGRESS_FLAG],
        routes: [transcriptRoute(descriptor({ byteSize: 40 * 1024 * 1024 }))],
        session: session(),
      });

      fireEvent.click(
        await screen.findByRole("button", { name: LOAD_FULL_BUTTON_NAME })
      );

      // The download is in flight: progress indicator + a Cancel affordance.
      expect(
        await screen.findByText("Downloading transcript…")
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: CANCEL_BUTTON_NAME })
      ).toBeInTheDocument();

      // Let the stream complete — the parsed transcript replaces the indicator.
      stream.finish();
      expect(await screen.findByText("cloud hello")).toBeInTheDocument();
      expect(
        screen.queryByText("Downloading transcript…")
      ).not.toBeInTheDocument();
    });

    it("cancels an in-flight oversized download and returns to the load gate", async () => {
      stubStreamingBytes();
      renderPanel({
        enabledFlags: [TRANSCRIPT_DOWNLOAD_PROGRESS_FLAG],
        routes: [transcriptRoute(descriptor({ byteSize: 40 * 1024 * 1024 }))],
        session: session(),
      });

      fireEvent.click(
        await screen.findByRole("button", { name: LOAD_FULL_BUTTON_NAME })
      );
      fireEvent.click(
        await screen.findByRole("button", { name: CANCEL_BUTTON_NAME })
      );

      // Back to the oversized gate — the user can retry the load.
      expect(await screen.findByText("Large transcript")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: LOAD_FULL_BUTTON_NAME })
      ).toBeInTheDocument();
    });

    it("keeps the bare skeleton (no progress UI) when the flag is off", async () => {
      const stream = stubStreamingBytes();
      const { container } = renderPanel({
        routes: [transcriptRoute(descriptor({ byteSize: 40 * 1024 * 1024 }))],
        session: session(),
      });

      fireEvent.click(
        await screen.findByRole("button", { name: LOAD_FULL_BUTTON_NAME })
      );

      // The skeleton renders (aria-busy) but no progress text / cancel button.
      await waitFor(() =>
        expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
      );
      expect(
        screen.queryByText("Downloading transcript…")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: CANCEL_BUTTON_NAME })
      ).not.toBeInTheDocument();
      stream.finish();
    });
  });
});
