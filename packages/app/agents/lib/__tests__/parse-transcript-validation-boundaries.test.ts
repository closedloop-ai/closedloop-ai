import { parseClaudeTranscript } from "@repo/lib/harness/claude/parse-claude-core";
import {
  createNormalizedSession,
  Harness,
  type NormalizedSession,
} from "@repo/lib/harness/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAndParseTranscript,
  parseTranscriptText,
  TranscriptFetchError,
  TranscriptParseError,
} from "../parse-transcript";

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
const SECRET = `sk-${"v".repeat(32)}`;
const REDACTED_SECRET = "[REDACTED:sk]";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAndParseTranscript validation boundaries", () => {
  it("short-circuits an unsupported harness before fetch or progress work", async () => {
    const fetchMock = vi.fn();
    const onProgress = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchAndParseTranscript({
        harness: Harness.Cursor,
        onProgress,
        sessionId: "unsupported-session",
        url: "https://s3.invalid/transcript.jsonl",
      })
    ).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    expect(parseClaudeTranscriptMock).not.toHaveBeenCalled();
  });

  it("preserves a rejected fetch as its original network error", async () => {
    const networkError = new TypeError("network connection failed");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(networkError))
    );

    const caught = await fetchAndParseTranscript({
      harness: Harness.Claude,
      sessionId: "fetch-failure",
      url: "https://s3.invalid/transcript.jsonl",
    }).catch((error: unknown) => error);

    expect(caught).toBe(networkError);
    expect(caught).not.toBeInstanceOf(TranscriptFetchError);
    expect(caught).not.toBeInstanceOf(TranscriptParseError);
  });

  it("preserves a body-stream failure instead of classifying it as a parse or HTTP error", async () => {
    const streamError = new Error("socket closed mid-download");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(streamError);
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(stream, { status: 200 })))
    );

    const caught = await fetchAndParseTranscript({
      harness: Harness.Claude,
      onProgress: () => undefined,
      sessionId: "stream-failure",
      url: "https://s3.invalid/transcript.jsonl",
    }).catch((error: unknown) => error);

    expect(caught).toBe(streamError);
    expect(caught).not.toBeInstanceOf(TranscriptFetchError);
    expect(caught).not.toBeInstanceOf(TranscriptParseError);
  });
});

describe("parseTranscriptText viewer-boundary validation", () => {
  it("redacts nested strings while preserving nullable and optional values", async () => {
    parseClaudeTranscriptMock.mockResolvedValueOnce(secretBearingSession());

    const session = await parseTranscriptText({
      harness: Harness.Claude,
      sessionId: "redaction-boundary",
      text: "ignored by the parser stub",
    });

    expect(session?.messages).toEqual([
      {
        model: undefined,
        role: "assistant",
        text: null,
        timestamp: null,
      },
    ]);
    expect(session?.toolUses[0]).toMatchObject({
      gitBranch: null,
      input: {
        count: 7,
        nested: [REDACTED_SECRET, null, { token: REDACTED_SECRET }],
      },
      mcpServer: REDACTED_SECRET,
      name: REDACTED_SECRET,
      output: { ok: true, token: REDACTED_SECRET },
    });
    expect(session?.toolUses[0]).not.toHaveProperty("mcpMethod");
    expect(session?.subagents?.[0]).toMatchObject({
      metadata: {
        nullable: null,
        nested: { token: REDACTED_SECRET },
      },
      name: REDACTED_SECRET,
      status: REDACTED_SECRET,
      task: undefined,
      type: null,
    });
    expect(session?.plans).toEqual([
      { content: REDACTED_SECRET, source: null, timestamp: null },
    ]);
    expect(session?.apiErrors).toEqual([
      { message: REDACTED_SECRET, timestamp: null, type: undefined },
    ]);
    expect(session?.toolResultErrors).toEqual([
      { content: null, timestamp: null },
    ]);
    expect(session?.skills[0]?.name).toBe(REDACTED_SECRET);
  });

  it.each([
    ["keeps an unterminated final line", "first\nfinal", ["first", "final"]],
    [
      "does not invent a line after a trailing newline",
      "first\nfinal\n",
      ["first", "final"],
    ],
  ])("%s", async (_label, text, expectedLines) => {
    const seenLines: string[] = [];
    parseClaudeTranscriptMock.mockImplementationOnce(async (lines) => {
      for await (const line of lines) {
        seenLines.push(line);
      }
      return createNormalizedSession({ sessionId: "line-boundary" });
    });

    await parseTranscriptText({
      harness: Harness.Claude,
      sessionId: "line-boundary",
      text,
    });

    expect(seenLines).toEqual(expectedLines);
  });
});

function secretBearingSession(): NormalizedSession {
  return createNormalizedSession({
    apiErrors: [{ message: SECRET, timestamp: null }],
    messages: [
      {
        role: "assistant",
        text: null,
        timestamp: null,
      },
    ],
    plans: [{ content: SECRET, source: null, timestamp: null }],
    sessionId: "redaction-boundary",
    skills: [{ name: SECRET, timestamp: null }],
    subagents: [
      {
        id: "subagent-1",
        metadata: {
          nullable: null,
          nested: { token: SECRET },
        },
        name: SECRET,
        status: SECRET,
        task: undefined,
        type: null,
      },
    ],
    toolResultErrors: [{ content: null, timestamp: null }],
    toolUses: [
      {
        gitBranch: null,
        input: {
          count: 7,
          nested: [SECRET, null, { token: SECRET }],
        },
        mcpServer: SECRET,
        name: SECRET,
        output: { ok: true, token: SECRET },
        timestamp: null,
      },
    ],
  });
}
