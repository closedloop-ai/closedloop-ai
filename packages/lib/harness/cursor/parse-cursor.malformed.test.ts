/**
 * @file parse-cursor.malformed.test.ts
 * Covers the malformed-input guards in processCursorLine and the `message`-type
 * dual-dispatch and untyped-record fallbacks that cannot be keyed by `type` alone.
 *
 * Constraint: types: [] in tsconfig — no Buffer, process, or node:* imports.
 * Every fixture is built in memory with JSON.stringify.
 */
import { describe, expect, it } from "vitest";
import { parseCursorTranscript } from "./parse-cursor";

// Anchor timestamp so parseCursorTranscript returns a session, not null.
const TS0 = "2026-07-10T10:00:00.000Z";
const TS1 = "2026-07-10T10:00:01.000Z";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

// ── processCursorLine: non-object JSON values ────────────────────────────────

describe("processCursorLine: non-object JSON records", () => {
  it("skips JSON null (covers !rec guard)", async () => {
    // JSON.parse("null") === null — triggers the !rec path (Branch 52[0])
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/workspace/p" },
      }),
      "null",
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "s1" });
    // session is non-null (first line gave us a timestamp and cwd)
    expect(session?.name).toBe("p");
    expect(session?.userMessages).toBe(0);
  });

  it("skips JSON number (covers typeof rec !== 'object' guard)", async () => {
    // JSON.parse("42") === 42 — number is not an object
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/workspace/q" },
      }),
      "42",
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "s2" });
    expect(session?.name).toBe("q");
  });

  it("skips JSON array (covers !Array.isArray guard in non-object check)", async () => {
    // JSON.parse("[1,2,3]") is an array — fails the typeof !== "object" guard
    // because arrays ARE typeof "object", but the check is `!rec || typeof rec !== "object"`
    // Arrays pass the typeof check, so they proceed to the record step where
    // array.type is undefined → type becomes "" → untyped path tries payload
    // BUT: asRecord([1,2,3]) returns {} (array excluded by !Array.isArray)
    // so the untyped record condition (!type && (cwd||workdir||workspace)) is false.
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/workspace/r" },
      }),
      "[1, 2, 3]",
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "s3" });
    expect(session?.name).toBe("r");
    // Array line did not add any messages or errors
    expect(session?.userMessages).toBe(0);
  });

  it("skips boolean JSON (JSON.parse('true') is not an object)", async () => {
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/workspace/t" },
      }),
      "true",
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "s4" });
    expect(session?.name).toBe("t");
  });
});

// ── processCursorLine: non-string type field ─────────────────────────────────

describe("processCursorLine: non-string type field", () => {
  it("treats numeric type as '' and falls to untyped path (Branch 55[1])", async () => {
    // type: 42 is not a string → type becomes "" → untyped dispatch
    // No cwd in payload → no-op
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/workspace/p" },
      }),
      line({ type: 42, timestamp: TS1 }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "s5" });
    expect(session?.name).toBe("p");
    expect(session?.userMessages).toBe(0);
  });

  it("non-string type with cwd falls to untyped session-meta handler", async () => {
    // type: null is not a string → type = "" → untyped cwd path fires
    const lines = [line({ timestamp: TS0, cwd: "/workspace/untyped-proj" })];
    const session = await parseCursorTranscript(lines, { sessionId: "s6" });
    expect(session?.name).toBe("untyped-proj");
  });
});

// ── Map-based dispatch: prototype-collision safety ───────────────────────────

describe("processCursorLine: Map dispatch safety", () => {
  it("'constructor' type is a no-op (Map.get returns undefined)", async () => {
    // A plain-object dispatch would resolve "constructor" to Function;
    // Map.get("constructor") returns undefined → no handler runs.
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/workspace/safe" },
      }),
      line({ type: "constructor", timestamp: TS1 }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "s7" });
    // Only the session_meta ran; the constructor line was a no-op
    expect(session?.name).toBe("safe");
    expect(session?.userMessages).toBe(0);
  });
});

// ── 'message' type: dual role dispatch ───────────────────────────────────────

describe("processCursorLine: 'message' type role dispatch", () => {
  it("role='user' dispatches to handleUserMessage (Branch 58[0], 59[0])", async () => {
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/workspace/m" },
      }),
      line({
        type: "message",
        timestamp: TS1,
        payload: { role: "user", content: "hi" },
      }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "s8" });
    expect(session?.userMessages).toBe(1);
    expect(session?.assistantMessages).toBe(0);
    expect(session?.messages[0]?.role).toBe("human");
    expect(session?.messages[0]?.text).toBe("hi");
  });

  it("role='assistant' dispatches to handleAssistantMessage (Branch 60[0])", async () => {
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/workspace/m" },
      }),
      line({
        type: "message",
        timestamp: TS1,
        payload: { role: "assistant", content: "pong" },
      }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "s9" });
    expect(session?.userMessages).toBe(0);
    expect(session?.assistantMessages).toBe(1);
    expect(session?.messages[0]?.role).toBe("assistant");
    expect(session?.messages[0]?.text).toBe("pong");
  });

  it("role='user' AND author='assistant' dispatches to BOTH handlers (Branch 4[0])", async () => {
    // The payload has role="user" → isMessageRole(p,"user") is true via role
    // AND author="assistant" → isMessageRole(p,"assistant") is true via author
    // Both if-branches fire sequentially: first user handler, then assistant.
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/workspace/m" },
      }),
      line({
        type: "message",
        timestamp: TS1,
        payload: { role: "user", author: "assistant", content: "dual" },
      }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "s10" });
    expect(session?.userMessages).toBe(1);
    expect(session?.assistantMessages).toBe(1);
    // Both messages are present in order
    expect(session?.messages).toHaveLength(2);
    expect(session?.messages[0]?.role).toBe("human");
    expect(session?.messages[1]?.role).toBe("assistant");
  });

  it("author='user' (no role) dispatches via author fallback (Branch 4[1])", async () => {
    // payload.role !== "user" (absent) → evaluate payload.author === "user" → true
    // Covers the right-side of isMessageRole's || that was never reached before
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/workspace/m" },
      }),
      line({
        type: "message",
        timestamp: TS1,
        payload: { author: "user", content: "via author" },
      }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "s11" });
    expect(session?.userMessages).toBe(1);
    expect(session?.assistantMessages).toBe(0);
    expect(session?.messages[0]?.text).toBe("via author");
  });

  it("no role or author: neither handler fires (Branch 59[1], 60[1])", async () => {
    // isMessageRole(p,"user") → false; isMessageRole(p,"assistant") → false
    // Both if-bodies are skipped
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/workspace/m" },
      }),
      line({
        type: "message",
        timestamp: TS1,
        payload: { content: "mystery" },
      }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "s12" });
    expect(session?.userMessages).toBe(0);
    expect(session?.assistantMessages).toBe(0);
  });
});

// ── Untyped records: session-metadata fallback ────────────────────────────────

describe("processCursorLine: untyped record with cwd fields", () => {
  it("record with no type and cwd field triggers session-meta handler (Branch 61[0])", async () => {
    // !type is true (no type field → type=""), cwd is truthy → untyped session meta
    // Branch 62[0] = first OR operand (cwd) is the one that's truthy
    const lines = [line({ timestamp: TS0, cwd: "/workspace/untyped" })];
    const session = await parseCursorTranscript(lines, { sessionId: "s13" });
    expect(session?.name).toBe("untyped");
    expect(session?.cwd).toBe("/workspace/untyped");
  });

  it("record with no type and workdir field triggers session-meta handler (Branch 62[2])", async () => {
    // cwd is absent; workdir is the truthy OR operand
    const lines = [
      line({ timestamp: TS0, workdir: "/workspace/workdir-proj" }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "s14" });
    expect(session?.name).toBe("workdir-proj");
  });

  it("record with no type and workspace field triggers session-meta handler (Branch 62[3])", async () => {
    // cwd and workdir absent; workspace is truthy
    const lines = [line({ timestamp: TS0, workspace: "/workspace/ws-proj" })];
    const session = await parseCursorTranscript(lines, { sessionId: "s15" });
    expect(session?.name).toBe("ws-proj");
  });

  it("untyped record with no cwd fields is a no-op", async () => {
    // !type is true BUT no cwd/workdir/workspace → skip
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/workspace/base" },
      }),
      line({ timestamp: TS1, some_field: "irrelevant" }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "s16" });
    // cwd stays as set by session_meta; the untyped line didn't override anything
    expect(session?.cwd).toBe("/workspace/base");
  });
});

// ── asRecord: array-payload fallback ─────────────────────────────────────────

describe("asRecord: array payload coerced to {}", () => {
  it("session_meta with array payload is treated as empty (Branch 0[1])", async () => {
    // payload is [1,2,3] → asRecord returns {} → no cwd/version/model/git read
    const lines = [
      line({ type: "session_meta", timestamp: TS0, payload: [1, 2, 3] }),
      line({
        type: "user_message",
        timestamp: TS1,
        payload: { content: "hi" },
      }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "s17" });
    // session_meta with array payload contributed no cwd
    expect(session?.cwd).toBeNull();
    // user_message was still processed
    expect(session?.userMessages).toBe(1);
  });
});
