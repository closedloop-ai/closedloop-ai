/**
 * Tests for the `classify()` function exported from parse-codex.ts.
 *
 * classify() is the envelope parser that turns a raw JSONL-decoded value into a
 * coarse { kind, p, ts } triple. These tests target the branches that the main
 * parse-codex.test.ts suite never exercises:
 *   - Non-object inputs → null (Branch 4[0])
 *   - Alternative type-string aliases: session.created, turn.context, event,
 *     response.item (Branches 8[1], 11[1], 14[1], 17[1])
 *   - Bare session-meta records (no type field, but session fields present)
 *     (Branch 21[0])
 *   - Unknown-wrapper records with a typed payload → "auto" kind
 *   - Bare Responses-API items (type in RESPONSE_ITEM_TYPES, no wrapper)
 *   - No-type, no-session-fields records → "other" kind
 *   - Timestamp extraction fallback cascade (record.timestamp → record.ts →
 *     payload.timestamp → null)
 */

import { describe, expect, it } from "vitest";
import { classify } from "./parse-codex";

describe("classify() — non-object inputs return null (Branch 4[0])", () => {
  it("returns null for null", () => {
    expect(classify(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(classify(undefined)).toBeNull();
  });

  it("returns null for a string", () => {
    expect(classify("not an object")).toBeNull();
  });

  it("returns null for a number", () => {
    expect(classify(42)).toBeNull();
  });

  it("returns null for an array", () => {
    // Arrays are not plain records; asRecord rejects them.
    expect(classify(["session_meta", "payload"])).toBeNull();
  });

  it("returns null for boolean true", () => {
    expect(classify(true)).toBeNull();
  });
});

describe("classify() — alternative type-string aliases", () => {
  // Branch 8[1]: t === "session.created" (older format)
  it("classifies session.created as session_meta kind (Branch 8[1])", () => {
    const c = classify({
      type: "session.created",
      payload: { cwd: "/workspace/alpha" },
    });
    expect(c?.kind).toBe("session_meta");
    // payload is extracted as the inner record
    expect(c?.p).toEqual({ cwd: "/workspace/alpha" });
  });

  // Control: session_meta still works (covered in main suite; reconfirm here)
  it("classifies session_meta as session_meta kind (control)", () => {
    const c = classify({
      type: "session_meta",
      payload: { cwd: "/workspace/beta" },
    });
    expect(c?.kind).toBe("session_meta");
  });

  // Branch 11[1]: t === "turn.context" (older format)
  it("classifies turn.context as turn_context kind (Branch 11[1])", () => {
    const c = classify({
      type: "turn.context",
      payload: { model: "gpt-5-codex" },
    });
    expect(c?.kind).toBe("turn_context");
    expect(c?.p).toEqual({ model: "gpt-5-codex" });
  });

  // Branch 14[1]: t === "event" (older format)
  it("classifies event type as event kind (Branch 14[1])", () => {
    const c = classify({
      type: "event",
      payload: { type: "token_count", info: {} },
    });
    expect(c?.kind).toBe("event");
    expect(c?.p.type).toBe("token_count");
  });

  // Branch 17[1]: t === "response.item" (older format)
  it("classifies response.item as response_item kind (Branch 17[1])", () => {
    const c = classify({
      type: "response.item",
      payload: { type: "message", role: "user" },
    });
    expect(c?.kind).toBe("response_item");
    expect(c?.p.role).toBe("user");
  });
});

describe("classify() — bare session-meta records (Branch 21[0])", () => {
  // No type field, but record has session-ish fields
  it("classifies record with cwd as session_meta kind", () => {
    const c = classify({ cwd: "/home/me/project" });
    expect(c?.kind).toBe("session_meta");
    expect(c?.p.cwd).toBe("/home/me/project");
  });

  it("classifies record with instructions as session_meta kind", () => {
    const c = classify({ instructions: "Do the thing", cwd: null });
    expect(c?.kind).toBe("session_meta");
  });

  it("classifies record with session_id as session_meta kind", () => {
    const c = classify({ session_id: "abc-123" });
    expect(c?.kind).toBe("session_meta");
    expect(c?.p.session_id).toBe("abc-123");
  });

  it("classifies record with id as session_meta kind", () => {
    const c = classify({ id: "rollout-001" });
    expect(c?.kind).toBe("session_meta");
    expect(c?.p.id).toBe("rollout-001");
  });

  it("classifies record with git as session_meta kind", () => {
    const c = classify({ git: { branch: "main" } });
    expect(c?.kind).toBe("session_meta");
  });

  // Control: record with NEITHER type NOR session fields → other kind (not session_meta)
  it("does NOT classify a record with no session fields as session_meta", () => {
    const c = classify({ something: "random_field" });
    expect(c?.kind).not.toBe("session_meta");
  });
});

describe("classify() — auto kind (unknown wrapper with typed payload)", () => {
  it("classifies unknown envelope with payload.type as auto kind", () => {
    const c = classify({
      type: "some_future_envelope",
      payload: { type: "message", role: "assistant" },
    });
    expect(c?.kind).toBe("auto");
    // Payload is extracted as the inner record
    expect(c?.p.type).toBe("message");
    expect(c?.p.role).toBe("assistant");
  });

  it("auto payload without matching RESPONSE_ITEM_TYPES routes as event via auto", () => {
    // type in payload is not a known response item type → dispatches as event
    const c = classify({
      type: "unknown_outer",
      payload: { type: "user_message", message: "hi" },
    });
    expect(c?.kind).toBe("auto");
    expect(c?.p.type).toBe("user_message");
  });
});

describe("classify() — bare Responses-API items (RESPONSE_ITEM_TYPES, no wrapper)", () => {
  it("classifies bare message record as response_item kind", () => {
    const c = classify({ type: "message", role: "user", content: "hello" });
    expect(c?.kind).toBe("response_item");
    expect(c?.p.role).toBe("user");
  });

  it("classifies bare function_call record as response_item kind", () => {
    const c = classify({
      type: "function_call",
      name: "bash",
      arguments: "{}",
    });
    expect(c?.kind).toBe("response_item");
    expect(c?.p.name).toBe("bash");
  });

  it("classifies bare local_shell_call record as response_item kind", () => {
    const c = classify({ type: "local_shell_call", action: { command: "ls" } });
    expect(c?.kind).toBe("response_item");
  });
});

describe("classify() — other kind", () => {
  it("classifies empty object as other kind", () => {
    const c = classify({});
    expect(c?.kind).toBe("other");
  });

  it("classifies record with unrecognized type and no session fields as event kind (bare event fallback)", () => {
    // When type is a non-empty string but not a recognised response_item type
    // and there's no typed payload, it falls through to the bare-event branch.
    const c = classify({ type: "random_unknown_event_type" });
    expect(c?.kind).toBe("event");
    expect(c?.p.type).toBe("random_unknown_event_type");
  });

  it("classifies record with no type and no session fields as other kind", () => {
    // Genuinely alien record — no type, no cwd/session_id/id/git/instructions
    const c = classify({ color: "blue", size: 42 });
    expect(c?.kind).toBe("other");
  });
});

describe("classify() — timestamp extraction cascade", () => {
  it("extracts timestamp from record-level timestamp field", () => {
    const ts = "2026-07-09T12:00:00.000Z";
    const c = classify({ type: "session_meta", timestamp: ts, payload: {} });
    expect(c?.ts).toBe(ts);
  });

  it("extracts timestamp from record-level ts field when timestamp is absent", () => {
    const ts = "2026-07-09T12:00:01.000Z";
    const c = classify({ type: "session_meta", ts, payload: {} });
    expect(c?.ts).toBe(ts);
  });

  it("falls back to payload.timestamp when record has neither timestamp nor ts", () => {
    const ts = "2026-07-09T12:00:02.000Z";
    const c = classify({
      type: "session_meta",
      payload: { cwd: "/ws", timestamp: ts },
    });
    expect(c?.ts).toBe(ts);
  });

  it("returns null ts when no timestamp is found anywhere", () => {
    const c = classify({ type: "session_meta", payload: { cwd: "/ws" } });
    expect(c?.ts).toBeNull();
  });

  it("prefers record.timestamp over payload.timestamp", () => {
    const outer = "2026-07-09T12:00:00.000Z";
    const inner = "2026-07-09T12:00:05.000Z";
    const c = classify({
      type: "session_meta",
      timestamp: outer,
      payload: { timestamp: inner },
    });
    expect(c?.ts).toBe(outer);
  });
});

describe("classify() — payload extraction: payload record takes precedence over bare record", () => {
  it("uses the payload object as p when payload is a record", () => {
    const c = classify({
      type: "session_meta",
      payload: { cwd: "/from-payload" },
      cwd: "/from-root",
    });
    // p should be the payload record, not the outer record
    expect(c?.p.cwd).toBe("/from-payload");
  });

  it("uses the bare record as p when payload is not a record", () => {
    const c = classify({
      type: "session.created",
      cwd: "/bare-record-cwd",
    });
    // No payload → uses the full record
    expect(c?.p.cwd).toBe("/bare-record-cwd");
  });
});
