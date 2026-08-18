import type {
  TranscriptAccessResponse,
  TranscriptFileDescriptor,
} from "@repo/api/src/types/desktop-transcripts";
import { useQueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../shared/storybook/fixture-fetch";
import {
  type TranscriptBytesTransport,
  TranscriptBytesTransportProvider,
} from "../../data-source/transcript-bytes-transport";
import { agentSessionKeys } from "../use-agent-sessions";
import {
  TRANSCRIPT_AUTO_LOAD_MAX_BYTES,
  TRANSCRIPT_DOWNLOAD_PROGRESS_FLAG,
  TRANSCRIPT_PENDING_REFETCH_INTERVAL_MS,
  useSessionTranscript,
  useTranscriptAccess,
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
    permanentFailureReason: null,
    ...overrides,
  };
}

function accessResponse(
  file: TranscriptFileDescriptor
): TranscriptAccessResponse {
  return { sessionId: SESSION_ID, files: [file] };
}

const LOCAL_APP_URL = `app://renderer/transcripts/${"c".repeat(64)}.jsonl`;

/**
 * A desktop-like transport: advertises local-fallback support and always
 * resolves the local-backed `app://` URL with `source: "local"` — emulating main
 * serving the on-disk copy when the cloud descriptor is not readable.
 */
function localFallbackTransport(
  body = TRANSCRIPT_BODY
): TranscriptBytesTransport {
  return {
    supportsLocalFallback: true,
    resolveFetchUrl: () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL | Request) =>
          String(url) === LOCAL_APP_URL
            ? Promise.resolve(new Response(body, { status: 200 }))
            : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
        )
      );
      return Promise.resolve({
        kind: "ready" as const,
        url: LOCAL_APP_URL,
        source: "local" as const,
      });
    },
  };
}

function renderTranscriptHook(input: {
  routes: FixtureRoute[];
  harness?: string;
  enabled?: boolean;
  externalSessionId?: string;
  transport?: TranscriptBytesTransport;
  enabledFlags?: readonly string[];
}) {
  const wrapper = ({ children }: { children: ReactNode }) => {
    const inner = input.transport ? (
      <TranscriptBytesTransportProvider transport={input.transport}>
        {children}
      </TranscriptBytesTransportProvider>
    ) : (
      children
    );
    return (
      <AppCoreStoryProviders
        apiRoutes={input.routes}
        enabledFlags={input.enabledFlags}
      >
        {inner}
      </AppCoreStoryProviders>
    );
  };
  return renderHook(
    () =>
      useSessionTranscript(SESSION_ID, {
        harness: input.harness ?? "claude",
        enabled: input.enabled,
        externalSessionId: input.externalSessionId,
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

  it("transparently re-prepares and re-fetches on a cache-miss 404 (FEA-3624)", async () => {
    // The desktop transport returns an opaque `app://` URL for a file main serves
    // from a bounded, swept userData cache. If that cache file was evicted between
    // prepare and fetch, the `app://` fetch is a bare 404 — the transcript would
    // die with no recovery. The read must re-`resolveFetchUrl` (re-prepare, which
    // re-downloads into the cache) once and succeed on the fresh URL.
    const STALE_URL = `app://renderer/transcripts/${"d".repeat(64)}.jsonl`;
    const FRESH_URL = `app://renderer/transcripts/${"e".repeat(64)}.jsonl`;
    let prepareCalls = 0;
    // First fetch (stale URL) 404s (cache-miss); the re-prepared fresh URL 200s.
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) => {
        const target = String(url);
        if (target === STALE_URL) {
          return Promise.resolve(new Response("", { status: 404 }));
        }
        if (target === FRESH_URL) {
          return Promise.resolve(
            new Response(TRANSCRIPT_BODY, { status: 200 })
          );
        }
        return Promise.reject(new Error(`Unexpected fetch: ${target}`));
      })
    );
    const reprepareTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: () => {
        prepareCalls += 1;
        // First prepare hands back the (about-to-be-evicted) URL; the retry's
        // re-prepare re-downloads and returns a live one.
        return Promise.resolve({
          kind: "ready" as const,
          url: prepareCalls === 1 ? STALE_URL : FRESH_URL,
          source: "cloud" as const,
        });
      },
    };
    const { result } = renderTranscriptHook({
      transport: reprepareTransport,
      routes: [
        {
          method: "GET",
          path: `/agent-sessions/${SESSION_ID}/transcript`,
          respond: () => accessResponse(mainDescriptor()),
        },
      ],
    });

    // The cache-miss self-healed: the transcript renders from the re-prepared URL.
    await waitFor(() => expect(result.current.session).toBeTruthy());
    expect(result.current.error).toBeNull();
    expect(result.current.session?.messages.map((m) => m.role)).toEqual([
      "human",
      "assistant",
    ]);
    // Prepare ran twice (initial + one cache-miss re-prepare); no infinite retry.
    expect(prepareCalls).toBe(2);
  });

  it("reports the re-resolved source after a cache-miss retry (FEA-3624)", async () => {
    // The cache-miss retry re-`resolveFetchUrl`s and may serve a DIFFERENT copy
    // than the first resolve (e.g. the cloud copy 404'd, so main fell back to the
    // local `.jsonl`). `transcriptSource` must reflect the bytes actually
    // fetched — the retry threads `onSource(reResolved.source)`, mirroring the
    // call the first resolve already made — else the panel's "showing local copy"
    // indicator goes stale on the source of the FIRST (dead) resolve.
    const STALE_URL = `app://renderer/transcripts/${"1".repeat(64)}.jsonl`;
    const FRESH_URL = `app://renderer/transcripts/${"2".repeat(64)}.jsonl`;
    let prepareCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) => {
        const target = String(url);
        if (target === STALE_URL) {
          return Promise.resolve(new Response("", { status: 404 }));
        }
        if (target === FRESH_URL) {
          return Promise.resolve(
            new Response(TRANSCRIPT_BODY, { status: 200 })
          );
        }
        return Promise.reject(new Error(`Unexpected fetch: ${target}`));
      })
    );
    const flippingSourceTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: () => {
        prepareCalls += 1;
        // First resolve reports `cloud` (about-to-be-evicted); the cache-miss
        // re-prepare falls back to the on-disk copy and reports `local`.
        return Promise.resolve(
          prepareCalls === 1
            ? {
                kind: "ready" as const,
                url: STALE_URL,
                source: "cloud" as const,
              }
            : {
                kind: "ready" as const,
                url: FRESH_URL,
                source: "local" as const,
              }
        );
      },
    };
    const { result } = renderTranscriptHook({
      transport: flippingSourceTransport,
      routes: [
        {
          method: "GET",
          path: `/agent-sessions/${SESSION_ID}/transcript`,
          respond: () => accessResponse(mainDescriptor()),
        },
      ],
    });

    await waitFor(() => expect(result.current.session).toBeTruthy());
    // The reported source is the copy the SECOND (successful) fetch used, not the
    // first (dead) resolve's `cloud`.
    expect(result.current.transcriptSource).toBe("local");
    expect(prepareCalls).toBe(2);
  });

  it("surfaces an oversized re-resolve on the cache-miss retry instead of the stale 404 (FEA-3624)", async () => {
    // A LOCAL file can grow past the auto-load cap between the first resolve and
    // the cache-miss re-resolve. When the re-resolve now reports `oversized`, that
    // is a legitimate "Load full transcript" gate — the retry must surface it, not
    // discard it and throw the stale 404 as a dead error.
    const OVER_BYTES = TRANSCRIPT_AUTO_LOAD_MAX_BYTES + 1;
    const STALE_URL = `app://renderer/transcripts/${"3".repeat(64)}.jsonl`;
    let prepareCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) =>
        String(url) === STALE_URL
          ? Promise.resolve(new Response("", { status: 404 }))
          : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
      )
    );
    const growsOversizedTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: () => {
        prepareCalls += 1;
        // First resolve is ready (its URL then 404s — cache-miss); the re-resolve
        // reports the file has grown past the cap and is now gated.
        return Promise.resolve(
          prepareCalls === 1
            ? {
                kind: "ready" as const,
                url: STALE_URL,
                source: "local" as const,
              }
            : {
                kind: "oversized" as const,
                byteSize: OVER_BYTES,
                source: "local" as const,
              }
        );
      },
    };
    const { result } = renderTranscriptHook({
      transport: growsOversizedTransport,
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

    // The oversized re-resolve surfaces the gate — not an error, no parsed session.
    await waitFor(() => expect(result.current.isOversized).toBe(true));
    expect(result.current.byteSize).toBe(OVER_BYTES);
    expect(result.current.error).toBeNull();
    expect(result.current.session).toBeUndefined();
    // Re-resolved exactly once after the initial resolve (initial + one retry).
    expect(prepareCalls).toBe(2);
  });

  it("surfaces a non-404 fetch failure without re-preparing (FEA-3624)", async () => {
    // A 403 (SSRF/policy) or 5xx is NOT a cache-miss — re-preparing can't recover
    // it, so the read must propagate the error (the panel's retryable state) and
    // must NOT re-prepare on its own.
    const ERR_URL = `app://renderer/transcripts/${"f".repeat(64)}.jsonl`;
    let prepareCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) =>
        String(url) === ERR_URL
          ? Promise.resolve(new Response("", { status: 403 }))
          : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
      )
    );
    const failingTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: () => {
        prepareCalls += 1;
        return Promise.resolve({
          kind: "ready" as const,
          url: ERR_URL,
          source: "cloud" as const,
        });
      },
    };
    const { result } = renderTranscriptHook({
      transport: failingTransport,
      routes: [
        {
          method: "GET",
          path: `/agent-sessions/${SESSION_ID}/transcript`,
          respond: () => accessResponse(mainDescriptor()),
        },
      ],
    });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.errorKind).toBe("fetch");
    expect(result.current.session).toBeUndefined();
    // No cache-miss re-prepare for a 403 — prepared exactly once.
    expect(prepareCalls).toBe(1);
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

  it("desktop treats the file as readable and parses the local copy when the cloud descriptor is not readable", async () => {
    // The reported session shape: main file present in the descriptor but the
    // cloud copy is "not available for reading" (null url/sha). With a
    // local-fallback transport (desktop), the hook still renders — from the
    // local copy — instead of a dead state.
    const { result } = renderTranscriptHook({
      transport: localFallbackTransport(),
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

    // Readable even though the cloud descriptor's url/sha are null (desktop).
    await waitFor(() => expect(result.current.session).toBeTruthy());
    expect(result.current.isReadable).toBe(true);
    expect(result.current.transcriptSource).toBe("local");
    expect(result.current.session?.messages.map((m) => m.role)).toEqual([
      "human",
      "assistant",
    ]);
  });

  it("forwards the harness externalSessionId to the byte transport (local-fallback key)", async () => {
    // The hook is keyed by the CLOUD SESSION_ID, but the desktop LOCAL fallback
    // resolves the on-disk file by the harness externalSessionId. Assert the hook
    // threads it through to resolveFetchUrl so the fallback can actually match.
    const seen: Array<string | undefined> = [];
    const capturingTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: (args) => {
        seen.push(args.externalSessionId);
        vi.stubGlobal(
          "fetch",
          vi.fn((url: string | URL | Request) =>
            String(url) === LOCAL_APP_URL
              ? Promise.resolve(new Response(TRANSCRIPT_BODY, { status: 200 }))
              : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
          )
        );
        return Promise.resolve({
          kind: "ready" as const,
          url: LOCAL_APP_URL,
          source: "local" as const,
        });
      },
    };
    const { result } = renderTranscriptHook({
      transport: capturingTransport,
      externalSessionId: "ext-harness-1",
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

    await waitFor(() => expect(result.current.session).toBeTruthy());
    expect(seen).toContain("ext-harness-1");
    // Never the cloud id — that would never match the on-disk file.
    expect(seen).not.toContain(SESSION_ID);
  });

  it("gates an oversized LOCAL fallback file behind the load action, then parses on opt-in", async () => {
    const OVER_BYTES = TRANSCRIPT_AUTO_LOAD_MAX_BYTES + 1;
    // Desktop transport: returns `oversized` until the user opts in
    // (allowOversized), then serves the local bytes. The cloud descriptor has no
    // size for this not-yet-uploaded file (byteSize null), so the gate must come
    // from the resolve step — proving the local size cap is honored.
    const gatedTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: ({ allowOversized }) => {
        if (!allowOversized) {
          return Promise.resolve({
            kind: "oversized" as const,
            byteSize: OVER_BYTES,
            source: "local" as const,
          });
        }
        vi.stubGlobal(
          "fetch",
          vi.fn((url: string | URL | Request) =>
            String(url) === LOCAL_APP_URL
              ? Promise.resolve(new Response(TRANSCRIPT_BODY, { status: 200 }))
              : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
          )
        );
        return Promise.resolve({
          kind: "ready" as const,
          url: LOCAL_APP_URL,
          source: "local" as const,
        });
      },
    };
    const { result } = renderTranscriptHook({
      transport: gatedTransport,
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

    // The oversized local file surfaces the gate (not a parse, not an error),
    // carrying the on-disk size the cloud descriptor never had.
    await waitFor(() => expect(result.current.isOversized).toBe(true));
    expect(result.current.byteSize).toBe(OVER_BYTES);
    expect(result.current.session).toBeUndefined();
    expect(result.current.error).toBeNull();

    // Opt in — the query re-resolves with allowOversized and parses.
    act(() => result.current.loadFullTranscript());
    await waitFor(() => expect(result.current.session).toBeTruthy());
    expect(result.current.transcriptSource).toBe("local");
    expect(result.current.session?.messages.map((m) => m.role)).toEqual([
      "human",
      "assistant",
    ]);
  });

  it("re-parses the current on-disk copy for a LOCAL read (no archive sha pins it)", async () => {
    // Thread P1 (use-session-transcript:69): a local descriptor has no archive
    // `rawSha256`, so its parsed-query key is stable (`""`) even as the on-disk
    // `.jsonl` keeps changing. Because a local read uses `staleTime: 0` (it can't
    // rely on a sha to invalidate), a re-observe / retry re-parses the CURRENT
    // bytes rather than staying pinned to the first snapshot for the trust window.
    // Here the served body changes between the first parse and the retry; the
    // second parse must reflect the new content.
    let body = TRANSCRIPT_BODY;
    const mutableLocalTransport: TranscriptBytesTransport = {
      supportsLocalFallback: true,
      resolveFetchUrl: () => {
        vi.stubGlobal(
          "fetch",
          vi.fn((url: string | URL | Request) =>
            String(url) === LOCAL_APP_URL
              ? Promise.resolve(new Response(body, { status: 200 }))
              : Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
          )
        );
        return Promise.resolve({
          kind: "ready" as const,
          url: LOCAL_APP_URL,
          source: "local" as const,
        });
      },
    };
    const { result } = renderTranscriptHook({
      transport: mutableLocalTransport,
      routes: [
        {
          method: "GET",
          path: `/agent-sessions/${SESSION_ID}/transcript`,
          // Inert cloud route: local seed comes from the descriptor (null sha).
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

    await waitFor(() => expect(result.current.session).toBeTruthy());
    expect(result.current.session?.messages).toHaveLength(2);

    // The on-disk file grows a third turn; the local read is not pinned, so a
    // retry re-parses the fresh copy.
    body = `${TRANSCRIPT_BODY}${JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:01:00.000Z",
      cwd: "/home/me/project",
      message: { role: "user", content: "second prompt" },
    })}\n`;
    act(() => result.current.retry());

    await waitFor(() =>
      expect(result.current.session?.messages).toHaveLength(3)
    );
  });

  it("reports download progress for a deferred oversized load when the flag is on", async () => {
    stubTranscriptBytes();
    const total = new TextEncoder().encode(TRANSCRIPT_BODY).length;
    const { result } = renderTranscriptHook({
      enabledFlags: [TRANSCRIPT_DOWNLOAD_PROGRESS_FLAG],
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
    expect(result.current.isDownloadProgressEnabled).toBe(true);
    // Nothing downloading before the opt-in.
    expect(result.current.downloadProgress).toBeNull();

    act(() => result.current.loadFullTranscript());

    await waitFor(() => expect(result.current.session).toBeTruthy());
    // The final progress event lands on the true byte total from Content-Length.
    expect(result.current.downloadProgress).toEqual({ loaded: total, total });
  });

  it("keeps download progress null when the flag is off", async () => {
    stubTranscriptBytes();
    const { result } = renderTranscriptHook({
      routes: [
        {
          method: "GET",
          path: `/agent-sessions/${SESSION_ID}/transcript`,
          respond: () => accessResponse(mainDescriptor()),
        },
      ],
    });

    await waitFor(() => expect(result.current.session).toBeTruthy());
    expect(result.current.isDownloadProgressEnabled).toBe(false);
    expect(result.current.downloadProgress).toBeNull();
  });

  it("cancelLoad aborts the in-flight download and returns to the oversized gate", async () => {
    // A stream that emits one chunk then stays open, so the download is observably
    // in flight when we cancel.
    const bytes = new TextEncoder().encode(TRANSCRIPT_BODY);
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)));
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

    const { result } = renderTranscriptHook({
      enabledFlags: [TRANSCRIPT_DOWNLOAD_PROGRESS_FLAG],
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
    act(() => result.current.loadFullTranscript());
    // The first chunk arrived, so a download is visibly in flight.
    await waitFor(() =>
      expect(result.current.downloadProgress?.loaded).toBeGreaterThan(0)
    );
    expect(result.current.session).toBeUndefined();

    act(() => result.current.cancelLoad());

    // Back to the gate: opt-in cleared, progress cleared, no parsed session.
    await waitFor(() =>
      expect(result.current.isDeferredLoadRequested).toBe(false)
    );
    expect(result.current.isOversized).toBe(true);
    expect(result.current.downloadProgress).toBeNull();
    expect(result.current.session).toBeUndefined();
    // Release the dangling stream so the test env has nothing left open.
    controller?.close();
  });
});

/**
 * FEA-3481 (G5): if the user stays on an open detail view while a background
 * upload completes, nothing invalidates the transcript-access query (the live
 * bridge only moves list/usage/detail), so the panel is stuck on its
 * `UploadPending` treatment until navigate-away/back. `useTranscriptAccess`
 * self-heals with a short `refetchInterval` WHILE any file is pending, and clears
 * the poll the moment nothing is pending. Fake timers here so the poll cadence is
 * asserted deterministically without a multi-second real wait.
 */
describe("useTranscriptAccess pending re-poll (FEA-3481 G5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance fake timers inside `act` so query refetches settle cleanly. */
  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /**
   * Settle a freshly-mounted/refetched query under fake timers without
   * testing-library's `waitFor` (which schedules on real timers and would hang).
   * A few zero-tick advances flush the fixture-fetch promise + React commit.
   */
  async function settle() {
    for (let i = 0; i < 8; i += 1) {
      await advance(1);
    }
  }

  function renderAccessHook(
    respond: () => TranscriptAccessResponse,
    options?: { refetchWhileHidden?: boolean }
  ) {
    const requests: string[] = [];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: `/agent-sessions/${SESSION_ID}/transcript`,
            respond: ({ pathname }) => {
              requests.push(pathname);
              return respond();
            },
          },
        ]}
      >
        {children}
      </AppCoreStoryProviders>
    );
    const view = renderHook(() => useTranscriptAccess(SESSION_ID, options), {
      wrapper,
    });
    return { ...view, requestCount: () => requests.length };
  }

  const pendingResponse = () =>
    accessResponse(
      mainDescriptor({
        availability: "uploadPending",
        url: null,
        byteSize: null,
        rawSha256: null,
        uploadedAt: null,
      })
    );

  /**
   * Render `useTranscriptAccess` inside the AppCore providers and read the
   * `refetchIntervalInBackground` option off the resulting query observer.
   * Whether a hidden tab actually pauses the poll is React Query's own
   * (well-tested) focus-manager behavior — not something a jsdom `document.hidden`
   * getter reliably drives — so assert the SURFACE-GATING wiring at the option
   * itself: this is the exact contract the P2 fix changes.
   */
  async function captureBackgroundFlag(refetchWhileHidden?: boolean) {
    let client: ReturnType<typeof useQueryClient> | undefined;
    function ClientProbe() {
      client = useQueryClient();
      return null;
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: `/agent-sessions/${SESSION_ID}/transcript`,
            respond: pendingResponse,
          },
        ]}
      >
        <ClientProbe />
        {children}
      </AppCoreStoryProviders>
    );
    renderHook(() => useTranscriptAccess(SESSION_ID, { refetchWhileHidden }), {
      wrapper,
    });
    await settle();
    const query = client
      ?.getQueryCache()
      .find({ queryKey: agentSessionKeys.transcriptAccess(SESSION_ID) });
    return query?.observers[0]?.options.refetchIntervalInBackground;
  }

  it("re-polls the descriptor while a file is uploadPending", async () => {
    const view = renderAccessHook(() =>
      accessResponse(
        mainDescriptor({
          availability: "uploadPending",
          url: null,
          byteSize: null,
          rawSha256: null,
          uploadedAt: null,
        })
      )
    );

    // Initial descriptor read resolves as pending.
    await settle();
    expect(view.result.current.data?.files[0]?.availability).toBe(
      "uploadPending"
    );
    const afterLoad = view.requestCount();

    // Each poll interval issues another descriptor fetch — the panel would
    // otherwise stay stuck on UploadPending forever on an open detail view.
    await advance(TRANSCRIPT_PENDING_REFETCH_INTERVAL_MS);
    await settle();
    expect(view.requestCount()).toBe(afterLoad + 1);

    await advance(TRANSCRIPT_PENDING_REFETCH_INTERVAL_MS);
    await settle();
    expect(view.requestCount()).toBe(afterLoad + 2);
  });

  it("stops re-polling once the upload resolves to available", async () => {
    let availability = "uploadPending";
    const view = renderAccessHook(() =>
      accessResponse(
        availability === "uploadPending"
          ? mainDescriptor({
              availability: "uploadPending",
              url: null,
              byteSize: null,
              rawSha256: null,
              uploadedAt: null,
            })
          : mainDescriptor()
      )
    );

    await settle();
    expect(view.result.current.data?.files[0]?.availability).toBe(
      "uploadPending"
    );

    // The upload completes; the next poll picks up the readable descriptor.
    availability = "available";
    await advance(TRANSCRIPT_PENDING_REFETCH_INTERVAL_MS);
    await settle();
    expect(view.result.current.data?.files[0]?.availability).toBe("available");
    const afterResolve = view.requestCount();

    // Now that nothing is pending the interval resolver returns false — no
    // further descriptor fetches, so a resolved transcript never keeps polling.
    await advance(TRANSCRIPT_PENDING_REFETCH_INTERVAL_MS * 3);
    await settle();
    expect(view.requestCount()).toBe(afterResolve);
  });

  it("does not re-poll a terminal availability (available never spins)", async () => {
    const view = renderAccessHook(() => accessResponse(mainDescriptor()));

    await settle();
    expect(view.result.current.data?.files[0]?.availability).toBe("available");
    const afterLoad = view.requestCount();

    await advance(TRANSCRIPT_PENDING_REFETCH_INTERVAL_MS * 3);
    await settle();
    expect(view.requestCount()).toBe(afterLoad);
  });

  // FEA-3481 P2 review: the pending self-heal must not force background polling
  // on the web (the shared no-poll-when-hidden convention). `refetchWhileHidden`
  // gates `refetchIntervalInBackground` on the surface — false (web default)
  // lets React Query pause the poll while the tab is hidden; true (desktop) keeps
  // it alive for a permanently-hidden/offscreen renderer.
  it("web default does NOT force background polling (refetchIntervalInBackground false)", async () => {
    expect(await captureBackgroundFlag(undefined)).toBe(false);
  });

  it("desktop (refetchWhileHidden) keeps polling in the background", async () => {
    expect(await captureBackgroundFlag(true)).toBe(true);
  });
});
