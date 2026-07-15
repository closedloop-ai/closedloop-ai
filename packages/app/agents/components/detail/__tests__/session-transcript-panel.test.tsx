import type {
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import type { TranscriptFileDescriptor } from "@repo/api/src/types/desktop-transcripts";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../../shared/storybook/fixture-fetch";
import { withTranscriptFileParam } from "../../../lib/session-transcript-href";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionTranscriptPanel } from "../session-transcript-panel";

const SESSION_ID = "session-transcript-1";
const SIGNED_URL = "https://s3.invalid/session/main.jsonl";
const RETRY_BUTTON_NAME = /retry/i;
const LOAD_FULL_BUTTON_NAME = /load full transcript/i;
const UNSUPPORTED_CURSOR_NOTICE = /not yet available for cursor/i;
const NO_TRANSCRIPT_NOTICE = /No transcript is available/i;
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
      },
    ],
    ...overrides,
  });
}

function renderPanel(input: {
  routes?: FixtureRoute[];
  session: AgentSessionDetail;
  fallbackItems?: TurnItem[];
}) {
  return render(
    <AppCoreStoryProviders apiRoutes={input.routes}>
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

  it("shows the empty state (no web DB fallback) when the transcript is missing", async () => {
    stubBytes();
    renderPanel({
      routes: [
        transcriptRoute(
          descriptor({
            availability: "missing",
            url: null,
            byteSize: null,
            rawSha256: null,
            uploadedAt: null,
          })
        ),
      ],
      session: session(),
      // FEA-2718: on the web (cloud context), the DB fallback is ignored — turn
      // text no longer lives in the cloud DB, so a missing transcript is empty.
      fallbackItems: [dbPrompt("db fallback prompt")],
    });

    expect(await screen.findByText(NO_TRANSCRIPT_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText("db fallback prompt")).not.toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

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
              },
              {
                fileKey: "subagent:agent-7",
                availability: "available",
                uploadedAt: "2026-07-09T12:06:00.000Z",
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
});
