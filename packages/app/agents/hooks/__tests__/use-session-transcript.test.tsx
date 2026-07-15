import type {
  TranscriptAccessResponse,
  TranscriptFileDescriptor,
} from "@repo/api/src/types/desktop-transcripts";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../shared/storybook/fixture-fetch";
import { agentSessionKeys } from "../use-agent-sessions";
import {
  TRANSCRIPT_AUTO_LOAD_MAX_BYTES,
  useSessionTranscript,
} from "../use-session-transcript";

const SESSION_ID = "session-1";
const SIGNED_URL = "https://s3.invalid/session-1/main.jsonl";
const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/home/me/project",
  message: { role: "user", content: "hello" },
});
const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-09T12:00:01.000Z",
  message: {
    role: "assistant",
    model: "claude-opus-4",
    content: [{ type: "text", text: "hi there" }],
    usage: { input_tokens: 10, output_tokens: 5 },
  },
});
const TRANSCRIPT_BODY = `${USER_LINE}\n${ASSISTANT_LINE}\n`;

function mainDescriptor(
  overrides: Partial<TranscriptFileDescriptor> = {}
): TranscriptFileDescriptor {
  return {
    fileKey: "main",
    availability: "available",
    url: SIGNED_URL,
    byteSize: TRANSCRIPT_BODY.length,
    rawSha256: "a".repeat(64),
    uploadedAt: "2026-07-09T12:05:00.000Z",
    lastObservedAt: "2026-07-09T12:05:00.000Z",
    ...overrides,
  };
}

function accessResponse(
  file: TranscriptFileDescriptor
): TranscriptAccessResponse {
  return { sessionId: SESSION_ID, files: [file] };
}

function renderTranscriptHook(input: {
  routes: FixtureRoute[];
  harness?: string;
  enabled?: boolean;
}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppCoreStoryProviders apiRoutes={input.routes}>
      {children}
    </AppCoreStoryProviders>
  );
  return renderHook(
    () =>
      useSessionTranscript(SESSION_ID, {
        harness: input.harness ?? "claude",
        enabled: input.enabled,
      }),
    { wrapper }
  );
}

function stubTranscriptBytes(body = TRANSCRIPT_BODY): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request) => {
      if (String(url) === SIGNED_URL) {
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${String(url)}`));
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSessionTranscript", () => {
  it("keys the parsed transcript by session/file/sha", () => {
    expect(
      agentSessionKeys.transcriptFile(SESSION_ID, "main", "sha-1")
    ).toEqual([
      "agent-sessions",
      "transcript",
      "file",
      SESSION_ID,
      "main",
      "sha-1",
    ]);
  });

  it("fetches descriptors, fetches the signed URL, and parses the session", async () => {
    stubTranscriptBytes();
    const descriptorRequests: string[] = [];
    const { result } = renderTranscriptHook({
      routes: [
        {
          method: "GET",
          path: `/agent-sessions/${SESSION_ID}/transcript`,
          respond: ({ pathname }) => {
            descriptorRequests.push(pathname);
            return accessResponse(mainDescriptor());
          },
        },
      ],
    });

    await waitFor(() => expect(result.current.session).toBeTruthy());
    expect(result.current.session?.messages.map((m) => m.role)).toEqual([
      "human",
      "assistant",
    ]);
    expect(result.current.availability).toBe("available");
    expect(result.current.isReadable).toBe(true);
    expect(result.current.isParsing).toBe(false);
    // The signed URL was fetched exactly once (from the parse queryFn).
    expect(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    ).toHaveLength(1);
  });

  it("does not auto-fetch an oversized transcript until explicitly loaded", async () => {
    stubTranscriptBytes();
    const { result } = renderTranscriptHook({
      routes: [
        {
          method: "GET",
          path: `/agent-sessions/${SESSION_ID}/transcript`,
          respond: () =>
            accessResponse(
              mainDescriptor({ byteSize: TRANSCRIPT_AUTO_LOAD_MAX_BYTES + 1 })
            ),
        },
      ],
    });

    await waitFor(() => expect(result.current.isOversized).toBe(true));
    expect(result.current.session).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();

    act(() => {
      result.current.loadFullTranscript();
    });

    await waitFor(() => expect(result.current.session).toBeTruthy());
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("resets the oversized load gate when the file key changes", async () => {
    stubTranscriptBytes();
    const oversized = { byteSize: TRANSCRIPT_AUTO_LOAD_MAX_BYTES + 1 };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: `/agent-sessions/${SESSION_ID}/transcript`,
            respond: () => ({
              sessionId: SESSION_ID,
              files: [
                mainDescriptor(oversized),
                mainDescriptor({ ...oversized, fileKey: "subagent:a1" }),
              ],
            }),
          },
        ]}
      >
        {children}
      </AppCoreStoryProviders>
    );
    const { result, rerender } = renderHook(
      ({ fileKey }: { fileKey: string }) =>
        useSessionTranscript(SESSION_ID, { harness: "claude", fileKey }),
      { wrapper, initialProps: { fileKey: "main" } }
    );

    await waitFor(() => expect(result.current.isOversized).toBe(true));
    act(() => {
      result.current.loadFullTranscript();
    });
    await waitFor(() => expect(result.current.session).toBeTruthy());
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Switch to another oversized file via the `?file=` switcher (no remount):
    // the deferred-load opt-in must NOT carry over, or the 25 MB auto-load cap is
    // silently defeated for the second file.
    rerender({ fileKey: "subagent:a1" });
    await waitFor(() =>
      expect(result.current.isDeferredLoadRequested).toBe(false)
    );
    expect(result.current.isOversized).toBe(true);
    expect(result.current.session).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("skips parsing and flags an unsupported harness", async () => {
    stubTranscriptBytes();
    const { result } = renderTranscriptHook({
      harness: "cursor",
      routes: [
        {
          method: "GET",
          path: `/agent-sessions/${SESSION_ID}/transcript`,
          respond: () => accessResponse(mainDescriptor()),
        },
      ],
    });

    await waitFor(() => expect(result.current.availability).toBe("available"));
    expect(result.current.isUnsupportedHarness).toBe(true);
    expect(result.current.session).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not fetch the URL when the main file is not readable (upload pending)", async () => {
    stubTranscriptBytes();
    const { result } = renderTranscriptHook({
      routes: [
        {
          method: "GET",
          path: `/agent-sessions/${SESSION_ID}/transcript`,
          respond: () =>
            accessResponse(
              mainDescriptor({
                availability: "uploadPending",
                url: null,
                byteSize: null,
                rawSha256: null,
                uploadedAt: null,
              })
            ),
        },
      ],
    });

    await waitFor(() =>
      expect(result.current.availability).toBe("uploadPending")
    );
    expect(result.current.isReadable).toBe(false);
    expect(result.current.session).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
