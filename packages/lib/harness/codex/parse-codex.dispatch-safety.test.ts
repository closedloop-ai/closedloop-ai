import { describe, expect, it } from "vitest";
import { parseCodexRollout } from "./parse-codex";

// ── Shared builders ─────────────────────────────────────────────────────────

const SESSION_META = (ts = "2026-08-22T12:00:00.000Z") =>
  JSON.stringify({
    type: "session_meta",
    timestamp: ts,
    payload: { cwd: "/workspace/proj" },
  });

const TURN_CTX = (model: string, ts = "2026-08-22T12:00:01.000Z") =>
  JSON.stringify({ type: "turn_context", timestamp: ts, payload: { model } });

function tokenCountLine(ts: string, input: number, output: number): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: 0,
          output_tokens: output,
        },
      },
    },
  });
}

// ── ISS-7959: tokensByModel __proto__ prototype pollution guard ──────────────

describe("buildTokensByModel prototype-pollution guard (ISS-7959)", () => {
  it("folds a __proto__ model as a visible own property with correct totals", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("__proto__"),
      tokenCountLine("2026-08-22T12:00:02.000Z", 50, 20),
      tokenCountLine("2026-08-22T12:00:03.000Z", 120, 55),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "proto-key-guard",
    });

    const tbm = session!.tokensByModel;

    expect(Object.keys(tbm)).toContain("__proto__");

    // biome-ignore lint/suspicious/noProto lint/complexity/useLiteralKeys: testing that __proto__ is a normal own key on a null-prototype object
    const protoEntry = tbm["__proto__"]!;
    expect(protoEntry.input).toBe(120);
    expect(protoEntry.output).toBe(55);

    // The prototype must be the ordinary one -- NOT the injected token object.
    // The fold builds on a null-prototype object and spreads at the return, so
    // `__proto__` lands as a real own key while consumers still get a plain
    // object (apps/desktop/test/codex-collector-fold.test.ts deep-equals it).
    expect(Object.getPrototypeOf(tbm)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(tbm)).toContain("__proto__");
  });
});

// ── ISS-7621: dispatch registry safety ──────────────────────────────────────

describe("parseCodexRollout dispatch safety", () => {
  it.each([
    ["response_item", "__proto__"],
    ["response_item", "constructor"],
    ["event_msg", "__proto__"],
    ["event_msg", "constructor"],
  ] as const)(
    "treats %s payload type %s as an unknown no-op",
    async (recordType, payloadType) => {
      const session = await parseCodexRollout(
        [
          sessionMetaLine(),
          messageLine("2026-08-22T12:00:01.000Z", "user", "before"),
          JSON.stringify({
            type: recordType,
            timestamp: "2026-08-22T12:00:02.000Z",
            payload: { type: payloadType },
          }),
          messageLine("2026-08-22T12:00:03.000Z", "assistant", "after"),
        ],
        { sessionId: "prototype-key" }
      );

      expect(session?.messages.map((message) => message.text)).toEqual([
        "before",
        "after",
      ]);
    }
  );
});

function sessionMetaLine(): string {
  return JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-22T12:00:00.000Z",
    payload: { cwd: "/workspace/proj" },
  });
}

function messageLine(
  timestamp: string,
  role: "user" | "assistant",
  text: string
): string {
  return JSON.stringify({
    type: "response_item",
    timestamp,
    payload: {
      type: "message",
      role,
      content: [{ type: "output_text", text }],
    },
  });
}
