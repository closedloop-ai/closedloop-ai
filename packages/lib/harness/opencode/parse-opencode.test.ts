import { describe, expect, it } from "vitest";
import { createNormalizedSession, Harness } from "../types";
import {
  buildOpencodeApiErrorRecord,
  buildOpencodeMessageRecord,
  buildOpencodeSessionRecord,
  buildOpencodeTokenRecord,
  buildOpencodeToolErrorRecord,
  buildOpencodeToolUseRecord,
  buildOpencodeTurnDurationRecord,
  serializeOpencodeMaterializedRecord,
} from "./opencode-materialized-record";
import { parseOpenCodeTranscript } from "./parse-opencode";

/** Assemble a materialized JSONL body from records (mirrors the materializer). */
function jsonl(records: unknown[]): string[] {
  return records.map((record) =>
    serializeOpencodeMaterializedRecord(record as never)
  );
}

const SESSION_HEADER = buildOpencodeSessionRecord({
  sessionId: "opencode-abc",
  name: "Demo Session",
  cwd: "/workspace",
  model: "test-model",
  version: "1.0.0",
  slug: "demo",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:05:00.000Z",
  userMessages: 1,
  assistantMessages: 1,
  thinkingBlockCount: 0,
  permissionMode: null,
  entrypoint: Harness.OpenCode,
  fileModifiedAt: 1_700_000_000_000,
  tokensByModel: {
    "test-model": { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 },
  },
  messageTimestamps: ["2026-01-01T00:00:01.000Z"],
  diffStats: { filesChanged: 1, linesAdded: 3, linesRemoved: 1 },
});

describe("parseOpenCodeTranscript", () => {
  it("rebuilds a NormalizedSession from materialized records", async () => {
    const lines = jsonl([
      SESSION_HEADER,
      buildOpencodeMessageRecord({
        role: "human",
        timestamp: "2026-01-01T00:00:00.000Z",
        text: "hi",
      }),
      buildOpencodeMessageRecord({
        role: "assistant",
        timestamp: "2026-01-01T00:00:01.000Z",
        text: "hello",
        model: "test-model",
        tokens: { input: 10, output: 5 },
      }),
      buildOpencodeToolUseRecord({
        name: "Bash",
        timestamp: "2026-01-01T00:00:02.000Z",
        input: { cmd: "ls" },
        isError: false,
      }),
      buildOpencodeTokenRecord({
        timestamp: "2026-01-01T00:00:01.000Z",
        model: "test-model",
        input: 10,
        output: 5,
        cacheRead: 1,
        cacheWrite: 2,
      }),
      buildOpencodeApiErrorRecord({
        type: "error",
        message: "boom",
        timestamp: "2026-01-01T00:00:03.000Z",
      }),
      buildOpencodeTurnDurationRecord({
        durationMs: 1000,
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
    ]);

    const session = await parseOpenCodeTranscript(lines, {
      sessionId: "opencode-abc",
    });

    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe("opencode-abc");
    expect(session?.name).toBe("Demo Session");
    expect(session?.entrypoint).toBe(Harness.OpenCode);
    expect(session?.cwd).toBe("/workspace");
    expect(session?.messages.map((m) => m.role)).toEqual([
      "human",
      "assistant",
    ]);
    expect(session?.messages[1]?.text).toBe("hello");
    expect(session?.toolUses[0]?.name).toBe("Bash");
    expect(session?.tokenSeries).toHaveLength(1);
    expect(session?.tokensByModel).toEqual({
      "test-model": { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 },
    });
    expect(session?.apiErrors[0]?.message).toBe("boom");
    expect(session?.turnDurations[0]?.durationMs).toBe(1000);
    expect(session?.diffStats).toEqual({
      filesChanged: 1,
      linesAdded: 3,
      linesRemoved: 1,
    });
  });

  it("returns null when there is no session header with a timestamp", async () => {
    const lines = jsonl([
      buildOpencodeMessageRecord({
        role: "human",
        timestamp: "2026-01-01T00:00:00.000Z",
        text: "orphan",
      }),
    ]);
    const session = await parseOpenCodeTranscript(lines);
    expect(session).toBeNull();
  });

  it("skips malformed and forward-incompatible lines (cross-repo skew tolerance)", async () => {
    const lines = [
      "", // blank
      "not json at all",
      // Unknown record kind a newer writer might emit — must be skipped, not throw.
      JSON.stringify({ t: "futureKind", data: 1 }),
      ...jsonl([SESSION_HEADER]),
      // Valid-JSON but member-schema-invalid message (missing role) — skipped.
      JSON.stringify({ t: "message", timestamp: "2026-01-01T00:00:00.000Z" }),
      ...jsonl([
        buildOpencodeMessageRecord({
          role: "human",
          timestamp: "2026-01-01T00:00:00.000Z",
          text: "kept",
        }),
      ]),
    ];
    const session = await parseOpenCodeTranscript(lines, {
      sessionId: "opencode-abc",
    });
    expect(session).not.toBeNull();
    // The malformed message is dropped; the well-formed one survives.
    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0]?.text).toBe("kept");
  });

  it("defaults sessionId to the header when no override is given", async () => {
    const session = await parseOpenCodeTranscript(jsonl([SESSION_HEADER]));
    expect(session?.sessionId).toBe("opencode-abc");
  });

  it("uses startedAt as endedAt when the session header carries endedAt: null", async () => {
    const headerWithNullEndedAt = buildOpencodeSessionRecord({
      sessionId: "opencode-null-end",
      name: "Null End",
      cwd: null,
      model: null,
      version: null,
      slug: null,
      startedAt: "2026-06-01T10:00:00.000Z",
      endedAt: null,
      userMessages: 0,
      assistantMessages: 0,
      thinkingBlockCount: 0,
      permissionMode: null,
      entrypoint: Harness.OpenCode,
      fileModifiedAt: null,
      tokensByModel: {},
      messageTimestamps: [],
      diffStats: null,
    });
    const session = await parseOpenCodeTranscript(
      jsonl([headerWithNullEndedAt])
    );
    expect(session?.endedAt).toBe("2026-06-01T10:00:00.000Z");
    expect(session?.startedAt).toBe("2026-06-01T10:00:00.000Z");
  });

  it("defaults entrypoint to Harness.OpenCode when the header carries an empty string", async () => {
    const headerNoEntrypoint = buildOpencodeSessionRecord({
      sessionId: "opencode-no-ep",
      name: "No Entrypoint",
      cwd: null,
      model: null,
      version: null,
      slug: null,
      startedAt: "2026-06-01T10:00:00.000Z",
      endedAt: "2026-06-01T10:05:00.000Z",
      userMessages: 0,
      assistantMessages: 0,
      thinkingBlockCount: 0,
      permissionMode: null,
      entrypoint: "",
      fileModifiedAt: null,
      tokensByModel: {},
      messageTimestamps: [],
      diffStats: null,
    });
    const session = await parseOpenCodeTranscript(jsonl([headerNoEntrypoint]));
    expect(session?.entrypoint).toBe(Harness.OpenCode);
  });

  it("includes output, isError, and diffDelta on a ToolUse and omits undefined input", async () => {
    const lines = jsonl([
      SESSION_HEADER,
      buildOpencodeToolUseRecord({
        name: "Write",
        timestamp: "2026-01-01T00:00:02.000Z",
        // input omitted (undefined) → should not appear in push
        output: "ok",
        isError: true,
        diffDelta: { add: 3, del: 1 },
      }),
    ]);
    const session = await parseOpenCodeTranscript(lines, {
      sessionId: "opencode-abc",
    });
    const [tu] = session?.toolUses ?? [];
    expect(tu).toBeDefined();
    expect("input" in (tu ?? {})).toBe(false);
    expect(tu?.output).toBe("ok");
    expect(tu?.isError).toBe(true);
    expect(tu?.diffDelta).toEqual({ add: 3, del: 1 });
  });

  it("includes isThinking and isSynthetic flags on a Message when both are true", async () => {
    const lines = jsonl([
      SESSION_HEADER,
      buildOpencodeMessageRecord({
        role: "assistant",
        timestamp: "2026-01-01T00:00:01.000Z",
        text: "thinking...",
        isThinking: true,
        isSynthetic: true,
      }),
    ]);
    const session = await parseOpenCodeTranscript(lines, {
      sessionId: "opencode-abc",
    });
    const [msg] = session?.messages ?? [];
    expect(msg?.isThinking).toBe(true);
    expect(msg?.isSynthetic).toBe(true);
  });

  it("appends a ToolError to toolResultErrors", async () => {
    const lines = jsonl([
      SESSION_HEADER,
      buildOpencodeToolErrorRecord({
        content: "tool failed with exit 1",
        timestamp: "2026-01-01T00:00:02.000Z",
      }),
    ]);
    const session = await parseOpenCodeTranscript(lines, {
      sessionId: "opencode-abc",
    });
    expect(session?.toolResultErrors).toHaveLength(1);
    expect(session?.toolResultErrors[0]?.content).toBe(
      "tool failed with exit 1"
    );
  });

  it("matches a directly-constructed NormalizedSession for the header-only case", async () => {
    const parsed = await parseOpenCodeTranscript(jsonl([SESSION_HEADER]), {
      sessionId: "opencode-abc",
    });
    const expected = createNormalizedSession({
      sessionId: "opencode-abc",
      name: "Demo Session",
      cwd: "/workspace",
      model: "test-model",
      version: "1.0.0",
      slug: "demo",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
      userMessages: 1,
      assistantMessages: 1,
      thinkingBlockCount: 0,
      permissionMode: null,
      entrypoint: Harness.OpenCode,
      fileModifiedAt: 1_700_000_000_000,
      tokensByModel: {
        "test-model": { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 },
      },
      messageTimestamps: ["2026-01-01T00:00:01.000Z"],
      diffStats: { filesChanged: 1, linesAdded: 3, linesRemoved: 1 },
    });
    expect(parsed).toEqual(expected);
  });
});
