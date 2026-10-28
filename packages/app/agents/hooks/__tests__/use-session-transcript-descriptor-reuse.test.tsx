import {
  TRANSCRIPT_ACCESS_FILE_KEY_PARAM,
  type TranscriptAccessResponse,
  TranscriptAvailability,
  type TranscriptFileDescriptor,
} from "@repo/api/src/types/desktop-transcripts";
import { focusManager, useQueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { MAIN_TRANSCRIPT_FILE_KEY } from "../../lib/session-transcript-href";
import {
  TRANSCRIPT_MISSING_REFETCH_CAP_MS,
  TRANSCRIPT_PENDING_REFETCH_INTERVAL_MS,
} from "../../lib/transcript-access-freshness";
import { agentSessionKeys } from "../agent-session-keys";
import { useSessionTranscript } from "../use-session-transcript";

/**
 * ISS-12276 (PRD-792): the Session detail transcript descriptor was fetched
 * about four times per view (mount, the parse's own re-read, focus), and a
 * never-uploaded transcript re-polled every 4 s for as long as the page stayed
 * open. These drive the production hook end to end through the fixture API.
 */

const SESSION_ID = "session-descriptor-reuse";
const BYTES_URL_BASE = "https://s3.invalid/session-descriptor-reuse/main.jsonl";
const TRANSCRIPT_BODY = `${JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/repo",
  message: { role: "user", content: "hello" },
})}\n`;

const ISO_DATE_SEPARATORS = /[-:]/g;
const ISO_MILLISECONDS = /\.\d{3}/;

/** A SigV4-style presigned URL minted now, valid for five minutes. */
function presignedUrl(): string {
  const amzDate = new Date()
    .toISOString()
    .replace(ISO_DATE_SEPARATORS, "")
    .replace(ISO_MILLISECONDS, "");
  return `${BYTES_URL_BASE}?X-Amz-Date=${amzDate}&X-Amz-Expires=300`;
}

function descriptor(
  overrides: Partial<TranscriptFileDescriptor>
): TranscriptFileDescriptor {
  return {
    fileKey: MAIN_TRANSCRIPT_FILE_KEY,
    availability: TranscriptAvailability.Available,
    url: null,
    byteSize: TRANSCRIPT_BODY.length,
    rawSha256: "d".repeat(64),
    uploadedAt: "2026-07-09T12:05:00.000Z",
    lastObservedAt: "2026-07-09T12:05:00.000Z",
    permanentFailureReason: null,
    ...overrides,
  };
}

function renderTranscript(
  respond: () => TranscriptAccessResponse,
  status?: number
) {
  const requests: URLSearchParams[] = [];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppCoreStoryProviders
      apiRoutes={[
        {
          method: "GET",
          path: `/agent-sessions/${SESSION_ID}/transcript`,
          respond: ({ searchParams }) => {
            requests.push(searchParams);
            return respond();
          },
          status,
        },
      ]}
    >
      {children}
    </AppCoreStoryProviders>
  );
  const view = renderHook(
    () => ({
      client: useQueryClient(),
      transcript: useSessionTranscript(SESSION_ID, { harness: "claude" }),
    }),
    { wrapper }
  );
  return { ...view, requests };
}

describe("transcript descriptor reuse (ISS-12276)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => focusManager.setFocused(undefined));
  });

  it("reads the descriptor once across mount, parse and a window focus", async () => {
    const url = presignedUrl();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) =>
        String(input) === url
          ? Promise.resolve(new Response(TRANSCRIPT_BODY, { status: 200 }))
          : Promise.reject(new Error(`Unexpected fetch: ${String(input)}`))
      )
    );
    const { result, requests } = renderTranscript(() => ({
      sessionId: SESSION_ID,
      files: [descriptor({ url })],
    }));

    await waitFor(() => expect(result.current.transcript.session).toBeTruthy());
    await refocus();

    // The focus has been handled, so a refetch would be in flight now.
    expect(
      result.current.client.isFetching({
        queryKey: agentSessionKeys.transcriptAccess(
          SESSION_ID,
          MAIN_TRANSCRIPT_FILE_KEY
        ),
      })
    ).toBe(0);
    expect(requests).toHaveLength(1);
    // The production read names the file it is about to read, so the route
    // presigns only that one.
    expect(requests[0]?.get(TRANSCRIPT_ACCESS_FILE_KEY_PARAM)).toBe(
      MAIN_TRANSCRIPT_FILE_KEY
    );
  });
});

describe("transcript descriptor freshness window (ISS-12276 review)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    act(() => focusManager.setFocused(undefined));
  });

  it("measures the window from the fetch, not from each staleness check", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const url = presignedUrl();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(TRANSCRIPT_BODY, { status: 200 }))
      )
    );
    const { result, requests } = renderTranscript(() => ({
      sessionId: SESSION_ID,
      files: [descriptor({ url })],
    }));
    await waitFor(() => expect(result.current.transcript.session).toBeTruthy());
    const fetchedAtMs = Date.now();

    // 150 s into a 300 s URL with a 60 s margin: 90 s of reuse left. Measuring
    // from "now" made it look stale after ~120 s.
    vi.setSystemTime(fetchedAtMs + 150_000);
    await refocus();
    expect(requests).toHaveLength(1);

    // Past expiry minus the margin, the next focus re-reads.
    vi.setSystemTime(fetchedAtMs + 250_000);
    await refocus();
    await waitFor(() => expect(requests).toHaveLength(2));
  });

  it("re-reads the descriptor once when S3 refuses a reused URL", async () => {
    let minted = 0;
    const firstUrl = `${presignedUrl()}&mint=1`;
    const secondUrl = `${presignedUrl()}&mint=2`;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) =>
        Promise.resolve(
          String(input) === secondUrl
            ? new Response(TRANSCRIPT_BODY, { status: 200 })
            : new Response("", { status: 403 })
        )
      )
    );
    const { result, requests } = renderTranscript(() => {
      minted += 1;
      return {
        sessionId: SESSION_ID,
        files: [descriptor({ url: minted === 1 ? firstUrl : secondUrl })],
      };
    });

    await waitFor(() => expect(result.current.transcript.session).toBeTruthy());
    expect(result.current.transcript.error).toBeNull();
    expect(requests).toHaveLength(2);
  });
});

describe("transcript retry after a descriptor failure (ISS-12276 review)", () => {
  it("does not parse, and so does not re-request the descriptor, when the retried read fails", async () => {
    const { result, requests } = renderTranscript(
      () => ({ sessionId: SESSION_ID, files: [] }),
      500
    );
    await waitFor(() => expect(result.current.transcript.error).not.toBeNull());
    const beforeRetry = requests.length;

    act(() => result.current.transcript.retry());

    await waitFor(() => expect(requests).toHaveLength(beforeRetry + 1));
    await waitFor(() =>
      expect(
        result.current.client.isFetching({
          queryKey: agentSessionKeys.transcriptAccess(
            SESSION_ID,
            MAIN_TRANSCRIPT_FILE_KEY
          ),
        })
      ).toBe(0)
    );
    // Let a chained parse, if one were started, issue its descriptor read.
    await act(async () => {
      await Promise.resolve();
    });
    expect(requests).toHaveLength(beforeRetry + 1);
  });
});

describe("transcript descriptor polling (ISS-12276)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("stops polling a missing transcript once the cap is reached", async () => {
    const { requests } = renderTranscript(() => ({
      sessionId: SESSION_ID,
      files: [
        descriptor({
          availability: TranscriptAvailability.Missing,
          byteSize: null,
          rawSha256: null,
          uploadedAt: null,
        }),
      ],
    }));

    await advance(10);
    expect(requests.length).toBe(1);
    // Past the cap plus the longest backoff gap, polling has stopped.
    await advance(TRANSCRIPT_MISSING_REFETCH_CAP_MS * 2);
    const afterCap = requests.length;
    expect(afterCap).toBeGreaterThan(1);
    // Backoff: fewer polls than a flat 4 s cadence over the capped window.
    expect(afterCap).toBeLessThan(
      TRANSCRIPT_MISSING_REFETCH_CAP_MS / TRANSCRIPT_PENDING_REFETCH_INTERVAL_MS
    );
    await advance(TRANSCRIPT_MISSING_REFETCH_CAP_MS);
    expect(requests.length).toBe(afterCap);
  });

  it("keeps polling an uploadPending transcript every 4 s past that cap", async () => {
    const { requests } = renderTranscript(() => ({
      sessionId: SESSION_ID,
      files: [
        descriptor({
          availability: TranscriptAvailability.UploadPending,
          byteSize: null,
          rawSha256: null,
          uploadedAt: null,
        }),
      ],
    }));

    await advance(10);
    await advance(TRANSCRIPT_MISSING_REFETCH_CAP_MS);
    const atCap = requests.length;
    await advance(TRANSCRIPT_PENDING_REFETCH_INTERVAL_MS * 3);
    expect(requests.length).toBe(atCap + 3);
  });
});

async function refocus() {
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    // The client handles focus after awaiting paused mutations; let it run.
    await Promise.resolve();
  });
}
