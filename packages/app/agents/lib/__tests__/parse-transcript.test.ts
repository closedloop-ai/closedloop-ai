import { parseClaudeTranscript } from "@repo/lib/harness/claude/parse-claude-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAndParseTranscript,
  isCloudParseableHarness,
  parseTranscriptText,
  type TranscriptDownloadProgress,
  TranscriptParseError,
} from "../parse-transcript";

// The Claude/Codex parser cores now degrade gracefully on a bad token snapshot
// (they drop that event's usage and keep parsing — FEA-2717), so no realistic
// transcript makes them throw. To exercise `parseTranscriptText`'s re-tag
// contract (a parser throw must surface as a distinct `TranscriptParseError`,
// not the generic combined error) we drive a throw from the core directly. The
// default export is the real implementation; individual tests override it with
// `mockImplementationOnce` to throw.
vi.mock("@repo/lib/harness/claude/parse-claude-core", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@repo/lib/harness/claude/parse-claude-core")
    >();
  return {
    ...actual,
    parseClaudeTranscript: vi.fn(actual.parseClaudeTranscript),
  };
});

const parseClaudeTranscriptMock = vi.mocked(parseClaudeTranscript);

const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/home/me/myproject",
  message: { role: "user", content: "hello" },
});
const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-09T12:00:01.000Z",
  message: {
    role: "assistant",
    model: "claude-opus-4",
    content: [{ type: "text", text: "hi there" }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0,
    },
  },
});
const SECRET_PLACEHOLDER = `sk-${"a".repeat(32)}`;
const REDACTED_SECRET_MARKER = "[REDACTED:sk]";

describe("isCloudParseableHarness", () => {
  it("accepts the extracted harnesses and rejects the rest", () => {
    expect(isCloudParseableHarness("claude")).toBe(true);
    expect(isCloudParseableHarness("Codex")).toBe(true);
    // FEA-3932: OpenCode's materialized projection is cloud-parseable.
    expect(isCloudParseableHarness("opencode")).toBe(true);
    expect(isCloudParseableHarness("OpenCode")).toBe(true);
    expect(isCloudParseableHarness("cursor")).toBe(false);
    expect(isCloudParseableHarness("copilot")).toBe(false);
  });
});

describe("parseTranscriptText", () => {
  it("splits the string into lines and dispatches to the claude core", async () => {
    // Our wrapper's job: iterate lines — including a blank line and a final line
    // with no trailing newline — and hand them to the right harness core. Parser
    // internals (token/parse-quality accounting) are covered in @repo/lib.
    const text = `\n${USER_LINE}\n${ASSISTANT_LINE}`;
    const session = await parseTranscriptText({
      harness: "claude",
      sessionId: "s1",
      text,
    });

    expect(session?.messages.map((message) => message.role)).toEqual([
      "human",
      "assistant",
    ]);
  });

  it("redacts secret-shaped placeholders at the parsed viewer boundary", async () => {
    const session = await parseTranscriptText({
      harness: "claude",
      sessionId: "s1",
      text: claudeUser(
        `please inspect ${SECRET_PLACEHOLDER}`,
        "2026-07-09T12:00:00.000Z"
      ),
    });

    expect(session?.messages[0]?.text).toBe(
      `please inspect ${REDACTED_SECRET_MARKER}`
    );
  });

  it("returns null for a harness with no cloud parser", async () => {
    const session = await parseTranscriptText({
      harness: "cursor",
      sessionId: "s1",
      text: USER_LINE,
    });
    expect(session).toBeNull();
  });

  it("dispatches an opencode materialized projection to the opencode core (FEA-3932)", async () => {
    const header = JSON.stringify({
      t: "session",
      v: 1,
      sessionId: "opencode-abc",
      name: "Demo",
      cwd: "/workspace",
      model: "test-model",
      version: null,
      slug: null,
      startedAt: "2026-07-09T12:00:00.000Z",
      endedAt: "2026-07-09T12:05:00.000Z",
      userMessages: 1,
      assistantMessages: 0,
      thinkingBlockCount: 0,
      permissionMode: null,
      entrypoint: "opencode",
      fileModifiedAt: null,
      tokensByModel: {},
      messageTimestamps: [],
      diffStats: null,
    });
    const message = JSON.stringify({
      t: "message",
      role: "human",
      timestamp: "2026-07-09T12:00:00.000Z",
      text: "hi",
    });
    const session = await parseTranscriptText({
      harness: "opencode",
      sessionId: "opencode-abc",
      text: `${header}\n${message}\n`,
    });
    expect(session?.sessionId).toBe("opencode-abc");
    expect(session?.entrypoint).toBe("opencode");
    expect(session?.messages.map((m) => m.role)).toEqual(["human"]);
  });

  it("redacts secrets in an opencode materialized projection at the viewer boundary (FEA-3932)", async () => {
    const header = JSON.stringify({
      t: "session",
      v: 1,
      sessionId: "opencode-abc",
      name: "Demo",
      cwd: null,
      model: null,
      version: null,
      slug: null,
      startedAt: "2026-07-09T12:00:00.000Z",
      endedAt: "2026-07-09T12:05:00.000Z",
      userMessages: 1,
      assistantMessages: 0,
      thinkingBlockCount: 0,
      permissionMode: null,
      entrypoint: "opencode",
      fileModifiedAt: null,
      tokensByModel: {},
      messageTimestamps: [],
      diffStats: null,
    });
    const message = JSON.stringify({
      t: "message",
      role: "human",
      timestamp: "2026-07-09T12:00:00.000Z",
      text: `inspect ${SECRET_PLACEHOLDER}`,
    });
    const session = await parseTranscriptText({
      harness: "opencode",
      sessionId: "opencode-abc",
      text: `${header}\n${message}`,
    });
    expect(session?.messages[0]?.text).toBe(
      `inspect ${REDACTED_SECRET_MARKER}`
    );
  });

  it("re-tags a parser throw as TranscriptParseError (distinct from a fetch failure)", async () => {
    // A parser throw must surface as a PARSE error, not the generic combined
    // error — so the UI can tell "bytes present but unparseable" from "archive
    // missing". Drive the throw from the core (see the module mock above).
    parseClaudeTranscriptMock.mockImplementationOnce(() => {
      throw new Error("core parser blew up");
    });

    await expect(
      parseTranscriptText({
        harness: "claude",
        sessionId: "s1",
        text: USER_LINE,
      })
    ).rejects.toBeInstanceOf(TranscriptParseError);
  });

  it("preserves the original parser error as `cause`", async () => {
    const original = new Error("core parser blew up");
    parseClaudeTranscriptMock.mockImplementationOnce(() => {
      throw original;
    });

    const error = await parseTranscriptText({
      harness: "claude",
      sessionId: "s1",
      text: USER_LINE,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TranscriptParseError);
    expect((error as TranscriptParseError).cause).toBe(original);
  });
});

/**
 * A streaming `Response` that emits `body` in chunks with a Content-Length.
 * Defaults to a two-chunk (halves) split; pass `chunkSize` to emit fixed-size
 * byte chunks instead, exercising arbitrary chunk boundaries.
 */
function streamingResponse(
  body: string,
  options: {
    withContentLength?: boolean;
    contentLength?: number;
    contentEncoding?: string;
    chunkSize?: number;
  } = {}
): Response {
  const bytes = new TextEncoder().encode(body);
  // Default: exactly two chunks split at the midpoint. With an explicit
  // `chunkSize`: fixed-size byte chunks, so a single builder covers both the
  // two-way-split progress tests and the arbitrary-boundary streaming tests.
  const chunkSize = options.chunkSize ?? Math.ceil(bytes.length / 2);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      // A whole-body emit (chunkSize >= length, including an empty body) still
      // yields one chunk so the stream is never silently empty.
      if (bytes.length === 0) {
        controller.enqueue(bytes);
      }
      controller.close();
    },
  });
  const headers = new Headers();
  if (options.withContentLength !== false) {
    headers.set(
      "Content-Length",
      String(options.contentLength ?? bytes.length)
    );
  }
  if (options.contentEncoding) {
    headers.set("Content-Encoding", options.contentEncoding);
  }
  return new Response(stream, { status: 200, headers });
}

describe("fetchAndParseTranscript download progress", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams the body and reports byte progress against Content-Length", async () => {
    const body = `${USER_LINE}\n${ASSISTANT_LINE}\n`;
    const total = new TextEncoder().encode(body).length;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(streamingResponse(body)))
    );
    const events: TranscriptDownloadProgress[] = [];

    const session = await fetchAndParseTranscript({
      url: "https://s3.invalid/main.jsonl",
      sessionId: "s1",
      harness: "claude",
      onProgress: (progress) => events.push(progress),
    });

    // Parsing is unaffected by streaming — same normalized session.
    expect(session?.messages.map((m) => m.role)).toEqual([
      "human",
      "assistant",
    ]);
    // Progress carries the total and lands exactly on it (monotonic, non-empty).
    expect(events.length).toBeGreaterThan(1);
    expect(events.every((event) => event.total === total)).toBe(true);
    expect(events.at(-1)).toEqual({ loaded: total, total });
    const loaded = events.map((event) => event.loaded);
    expect(loaded).toEqual([...loaded].sort((a, b) => a - b));
  });

  it("reports a null total while streaming, then a terminal event with the discovered size, when Content-Length is absent", async () => {
    const body = `${USER_LINE}\n`;
    const size = new TextEncoder().encode(body).length;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(streamingResponse(body, { withContentLength: false }))
      )
    );
    const events: TranscriptDownloadProgress[] = [];

    await fetchAndParseTranscript({
      url: "https://s3.invalid/main.jsonl",
      sessionId: "s1",
      harness: "claude",
      onProgress: (progress) => events.push(progress),
    });

    expect(events.length).toBeGreaterThan(1);
    // Intermediate events cannot know the total (indeterminate download)...
    expect(events.slice(0, -1).every((event) => event.total === null)).toBe(
      true
    );
    // ...but the terminal event carries the now-known size for a determinate 100%.
    expect(events.at(-1)).toEqual({ loaded: size, total: size });
  });

  it("treats a compressed response as indeterminate (Content-Length is the compressed size, not the decoded bytes)", async () => {
    // A gzip'd archive: the browser inflates it, so the reader yields MORE bytes
    // than Content-Length. Measuring against that header would overshoot 100% and
    // defeat the throttle, so total must be null (bytes-only) until the terminal
    // event reports the true decoded size.
    const body = `${USER_LINE}\n${ASSISTANT_LINE}\n`;
    const decodedSize = new TextEncoder().encode(body).length;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          streamingResponse(body, {
            // Pretend the compressed size is far smaller than the decoded stream.
            contentLength: Math.floor(decodedSize / 3),
            contentEncoding: "gzip",
          })
        )
      )
    );
    const events: TranscriptDownloadProgress[] = [];

    const session = await fetchAndParseTranscript({
      url: "https://s3.invalid/main.jsonl",
      sessionId: "s1",
      harness: "claude",
      onProgress: (progress) => events.push(progress),
    });

    expect(session?.messages.map((m) => m.role)).toEqual([
      "human",
      "assistant",
    ]);
    // Never measured against the (wrong) compressed Content-Length.
    expect(events.slice(0, -1).every((event) => event.total === null)).toBe(
      true
    );
    // Terminal event carries the true decoded size, so the bar can reach 100%.
    expect(events.at(-1)).toEqual({ loaded: decodedSize, total: decodedSize });
  });

  it("lands on a determinate 100% even when the streamed size is under Content-Length (short read)", async () => {
    const body = `${USER_LINE}\n`;
    const actualSize = new TextEncoder().encode(body).length;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        // Claim more bytes than the stream will actually deliver.
        Promise.resolve(
          streamingResponse(body, { contentLength: actualSize + 500 })
        )
      )
    );
    const events: TranscriptDownloadProgress[] = [];

    await fetchAndParseTranscript({
      url: "https://s3.invalid/main.jsonl",
      sessionId: "s1",
      harness: "claude",
      onProgress: (progress) => events.push(progress),
    });

    // The terminal event normalizes total to the real byte count → determinate
    // 100%, rather than stalling the bar at the inflated Content-Length.
    expect(events.at(-1)).toEqual({ loaded: actualSize, total: actualSize });
  });

  it("throws TranscriptFetchError on a non-2xx response (before streaming)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("nope", { status: 403 })))
    );
    const onProgress = vi.fn();

    await expect(
      fetchAndParseTranscript({
        url: "https://s3.invalid/main.jsonl",
        sessionId: "s1",
        harness: "claude",
        onProgress,
      })
    ).rejects.toMatchObject({ name: "TranscriptFetchError", status: 403 });
    expect(onProgress).not.toHaveBeenCalled();
  });
});

/**
 * A `Response` that emits `body` as fixed-size byte chunks with a Content-Length
 * — a thin alias for `streamingResponse` with an explicit `chunkSize`, so the
 * chunk-boundary streaming tests and the progress tests share one builder.
 */
function chunkedResponse(body: string, chunkSize: number): Response {
  return streamingResponse(body, { chunkSize });
}

const claudeUser = (text: string, timestamp: string): string =>
  JSON.stringify({
    type: "user",
    timestamp,
    cwd: "/home/me/myproject",
    message: { role: "user", content: text },
  });

const claudeAssistant = (text: string, timestamp: string): string =>
  JSON.stringify({
    type: "assistant",
    timestamp,
    message: {
      role: "assistant",
      model: "claude-opus-4",
      content: [{ type: "text", text }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
      },
    },
  });

/**
 * FEA-3714: the streaming download path feeds decoded lines straight into the
 * parser core instead of buffering the whole file. These guard the two contracts
 * that keep that safe: byte-identical output to batch parsing across ANY chunk
 * boundary (the canonical-digest equality), and that stream/abort failures stay
 * distinct from parse failures.
 */
describe("fetchAndParseTranscript incremental streaming (FEA-3714)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A transcript with a leading blank line, a multi-byte-heavy line, and a final
  // line WITHOUT a trailing newline (partial tail) — the awkward shapes a naive
  // chunk splitter gets wrong.
  const richTranscript = [
    "",
    claudeUser("hello", "2026-07-09T12:00:00.000Z"),
    claudeAssistant("hi 🚀 there — café ☕", "2026-07-09T12:00:01.000Z"),
    claudeUser("second question", "2026-07-09T12:00:02.000Z"),
    claudeAssistant("final answer", "2026-07-09T12:00:03.000Z"),
  ].join("\n");

  function batchDigest(text: string) {
    return parseTranscriptText({ harness: "claude", sessionId: "s1", text });
  }

  function streamDigest(text: string, chunkSize: number) {
    const response = chunkedResponse(text, chunkSize);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response))
    );
    return fetchAndParseTranscript({
      url: "https://s3.invalid/main.jsonl",
      sessionId: "s1",
      harness: "claude",
      onProgress: () => undefined,
    });
  }

  it("produces output identical to batch parsing across arbitrary chunk boundaries", async () => {
    const batch = await batchDigest(richTranscript);
    expect(batch?.messages.length).toBeGreaterThan(0); // guard: a real session

    const byteLength = new TextEncoder().encode(richTranscript).length;
    // Sizes that split inside records, inside the multi-byte codepoints, on
    // newlines, and exactly at / past the end.
    for (const chunkSize of [
      1,
      2,
      3,
      5,
      7,
      13,
      64,
      byteLength,
      byteLength + 10,
    ]) {
      const streamed = await streamDigest(richTranscript, chunkSize);
      expect(streamed).toEqual(batch);
    }
  });

  it("re-joins a JSONL record split across a chunk boundary (single-byte chunks)", async () => {
    const batch = await batchDigest(richTranscript);
    const streamed = await streamDigest(richTranscript, 1);
    expect(streamed).toEqual(batch);
  });

  it("redacts after re-joining a JSONL record split across streaming chunks", async () => {
    const streamed = await streamDigest(
      claudeUser(
        `streamed token ${SECRET_PLACEHOLDER}`,
        "2026-07-09T12:00:00.000Z"
      ),
      2
    );

    expect(streamed?.messages[0]?.text).toBe(
      `streamed token ${REDACTED_SECRET_MARKER}`
    );
  });

  it("redacts Codex credentials reconstructed from multiple content blocks", async () => {
    const session = await parseTranscriptText({
      harness: "codex",
      sessionId: "codex-split-secret",
      text: [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-07-09T12:00:00.000Z",
          payload: { cwd: "/workspace/proj", cli_version: "1.2.3" },
        }),
        JSON.stringify({
          type: "turn_context",
          timestamp: "2026-07-09T12:00:00.500Z",
          payload: { model: `${SECRET_PLACEHOLDER}-model` },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-07-09T12:00:00.750Z",
          payload: {
            type: "function_call",
            call_id: "call_1",
            name: `${SECRET_PLACEHOLDER}-tool`,
            arguments: JSON.stringify({
              token: SECRET_PLACEHOLDER,
            }),
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-07-09T12:00:01.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "split token sk-" },
              { type: "input_text", text: "a".repeat(32) },
            ],
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-07-09T12:00:02.000Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "split reply sk-" },
              { type: "output_text", text: "b".repeat(32) },
            ],
          },
        }),
      ].join("\n"),
    });

    expect(session?.messages[0]?.text).toBe(
      `split token ${REDACTED_SECRET_MARKER}`
    );
    expect(session?.messages[1]?.text).toBe(
      `split reply ${REDACTED_SECRET_MARKER}`
    );
    expect(session?.messages[1]?.model).toBe(`${REDACTED_SECRET_MARKER}-model`);
    expect(session?.toolUses[0]?.name).toBe(`${REDACTED_SECRET_MARKER}-tool`);
    expect(session?.toolUses[0]?.input).toEqual({
      token: REDACTED_SECRET_MARKER,
    });
  });

  it("matches batch parsing when a middle line is malformed JSON", async () => {
    const withMalformedMiddle = [
      claudeUser("hello", "2026-07-09T12:00:00.000Z"),
      "{ this is not valid json",
      claudeAssistant("still parsed", "2026-07-09T12:00:01.000Z"),
    ].join("\n");
    const batch = await batchDigest(withMalformedMiddle);
    for (const chunkSize of [1, 4, 17]) {
      expect(await streamDigest(withMalformedMiddle, chunkSize)).toEqual(batch);
    }
  });

  it("matches batch parsing when the final line is a truncated partial tail", async () => {
    // A live/interrupted transcript: the last line stops mid-record with no
    // trailing newline. Both paths drop it and yield the same session.
    const withPartialTail = `${claudeUser(
      "hello",
      "2026-07-09T12:00:00.000Z"
    )}\n${claudeAssistant(
      "answer",
      "2026-07-09T12:00:01.000Z"
    )}\n{"type":"assistant","timestamp":"2026-07-09T12:00`;
    const batch = await batchDigest(withPartialTail);
    for (const chunkSize of [1, 3, 29]) {
      expect(await streamDigest(withPartialTail, chunkSize)).toEqual(batch);
    }
  });

  it("streams a large many-line transcript without buffering the whole file", async () => {
    const turns: string[] = [];
    for (let index = 0; index < 400; index++) {
      const second = String(index % 60).padStart(2, "0");
      const minute = String(Math.floor(index / 60)).padStart(2, "0");
      turns.push(
        claudeUser(`q${index}`, `2026-07-09T12:${minute}:${second}.000Z`),
        claudeAssistant(
          `a${index} ✅`,
          `2026-07-09T12:${minute}:${second}.500Z`
        )
      );
    }
    const largeTranscript = turns.join("\n");
    const batch = await batchDigest(largeTranscript);

    const response = chunkedResponse(largeTranscript, 64);
    // The whole-file `response.text()` buffer must never be taken on this path —
    // proof the lines are consumed incrementally (bounded memory).
    const textSpy = vi.spyOn(response, "text");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response))
    );

    const streamed = await fetchAndParseTranscript({
      url: "https://s3.invalid/main.jsonl",
      sessionId: "s1",
      harness: "claude",
      onProgress: () => undefined,
    });

    expect(streamed).toEqual(batch);
    expect(streamed?.messages.length).toBe(800);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("propagates an aborted download as its raw error, not a TranscriptParseError", async () => {
    const abortError = new DOMException(
      "The operation was aborted.",
      "AbortError"
    );
    const firstChunk = new TextEncoder().encode(
      `${claudeUser("hello", "2026-07-09T12:00:00.000Z")}\n`
    );
    let emitted = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted) {
          // Second read models the fetch abort erroring the body mid-stream.
          controller.error(abortError);
          return;
        }
        emitted = true;
        controller.enqueue(firstChunk);
      },
    });
    const response = new Response(stream, { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response))
    );

    const caught = await fetchAndParseTranscript({
      url: "https://s3.invalid/main.jsonl",
      sessionId: "s1",
      harness: "claude",
      onProgress: () => undefined,
    }).catch((error: unknown) => error);

    // The original abort error propagates untouched (a clean cancel), NOT wrapped
    // as a parse failure.
    expect(caught).toBe(abortError);
    expect(caught).not.toBeInstanceOf(TranscriptParseError);
  });
});
