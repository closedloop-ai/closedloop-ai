/**
 * @file tool-call-detail-import.test.ts
 * @description Bug 019f881c ("[Bug] Session trace captures no tool-call
 * details") regression coverage.
 *
 * A tool call collected from a transcript (the IMPORT path, `importSession` →
 * `importToolEventData`) must carry its per-call input AND result through to the
 * Session Trace's expandable tool rows. Before the fix, `importToolEventData`
 * spread the tool input to TOP-LEVEL `data` keys and dropped the output
 * entirely, so the projection's `toolCallDetailFields` — which reads
 * `data.tool_input` / `data.tool_response` — found nothing and every imported
 * tool row rendered "No detail captured for this call".
 *
 * These tests drive the SAME production pipeline the desktop detail page uses:
 *   importSession → events.data → loadSyncedSessions → projectAgentSessionTurnItems
 * and assert the resulting ToolItem carries non-empty (redacted-form) input +
 * output, at parity with the live-hook path. Redaction stays intact: the parser
 * size-caps the output and the cloud sync sanitizer still strips `data`
 * entirely from the wire (covered by agent-session-sync-sanitization.test.ts),
 * so this detail lives only in the LOCAL DB / local trace.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  projectAgentSessionTimelineEvents,
  projectAgentSessionTurnItems,
} from "@repo/lib/sessions/agent-session-detail-projection.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { emptyAttributionCache } from "./attribution-test-helpers.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-07-20T12:00:00.000Z";
const COMMAND_PATTERN = /ls -la/;
const OUTPUT_PATTERN = /total 8/;
const STRING_INPUT_PATTERN = /ls -la \/tmp/;
const ARRAY_INPUT_PATTERN = /ls/;

async function importAndProjectTools(
  sessionId: string,
  toolUses: Parameters<typeof makeSession>[0]["toolUses"]
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tool-detail-"));
  const db = await openTestDb(dir);
  try {
    await db.importer.importSession(
      makeSession({
        sessionId,
        startedAt: NOW,
        endedAt: "2026-07-20T12:05:00.000Z",
        toolUses,
      }),
      "claude"
    );

    // Read the persisted event data back (the projection's actual input source).
    const eventRows = await db.events.getBySession(sessionId);
    const toolEvent = eventRows.find((row) => row.toolName);
    if (!toolEvent) {
      throw new Error("expected a persisted tool event");
    }

    // Hydrate the SAME SyncedAgentSession the detail page projects from (this
    // parses the `data` blob, WITHOUT omitEventData).
    const [session] = await db.syncSource.loadSyncedSessions(
      [sessionId],
      emptyAttributionCache()
    );
    if (!session) {
      throw new Error("expected the session to hydrate");
    }

    // Same two-step projection the desktop detail page runs (mapDetail): build
    // the timeline from the hydrated events, then the turn items from it.
    const timeline = projectAgentSessionTimelineEvents(session.events, {
      metadata: session.metadata,
    });
    const items = projectAgentSessionTurnItems({
      sessionId,
      harness: session.harness ?? "claude",
      primaryModel: session.model ?? null,
      humanActor: { name: "Me", color: "#64748B" },
      agents: session.agents,
      events: session.events,
      timeline,
    });
    const tools = items.find((item) => item.type === "tools");
    if (tools?.type !== "tools") {
      throw new Error("expected a tools turn");
    }
    return { db, dir, toolEvent, tools };
  } catch (error) {
    await db.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

test("imported tool call carries non-empty input + result into the trace tool row (bug 019f881c)", async () => {
  const { db, dir, toolEvent, tools } = await importAndProjectTools(
    "tool-detail-e2e",
    [
      {
        name: "Bash",
        kind: "builtin",
        timestamp: NOW,
        input: { command: "ls -la", description: "list files" },
        output: "total 8\ndrwxr-xr-x  4 me  staff  128 ...",
      },
    ]
  );
  try {
    // The persisted `data` carries the keys the projection reads (parity with
    // the live-hook shape), not just the old top-level spread.
    const data = JSON.parse(toolEvent.data ?? "{}") as Record<string, unknown>;
    assert.ok(data.tool_input, "persisted data.tool_input is present");
    assert.ok(data.tool_response, "persisted data.tool_response is present");
    // The raw input is carried ONCE, nested under `tool_input` — it is no longer
    // ALSO flat-spread to top-level `data` keys (thread PRRT_kwDOQ4gDpM6S0qJP),
    // so the size-cap actually bounds the persisted row.
    const toolInput = data.tool_input as Record<string, unknown>;
    assert.equal(toolInput.command, "ls -la");
    assert.equal(
      data.command,
      undefined,
      "raw input is not double-persisted to a flat top-level key"
    );

    const [bash] = tools.items;
    assert.equal(bash?.label, "Bash");
    // The row is NOT the "No detail captured" empty state: it carries both
    // input and output (redacted form — here plain, but size-capped upstream).
    assert.ok(bash?.input, "tool row carries non-empty input");
    assert.match(bash?.input ?? "", COMMAND_PATTERN);
    assert.ok(bash?.output, "tool row carries non-empty output");
    assert.match(bash?.output ?? "", OUTPUT_PATTERN);
    assert.ok(bash?.id, "a detail-bearing row gets a stable id");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("imported STRING-shaped tool input still reaches the trace tool row (bug 019f881c)", async () => {
  // The shape that broke: a non-object `toolUse.input` (e.g. codex `bash` calls
  // whose input is a raw command string, or an array). The prior `asRecord`
  // gate silently dropped it, so the row rendered "No detail captured". The
  // fix persists ANY non-undefined input under `tool_input` (thread
  // PRRT_kwDOQ4gDpM6S0qJ_).
  const { db, dir, toolEvent, tools } = await importAndProjectTools(
    "tool-detail-string-input",
    [
      {
        name: "Bash",
        kind: "builtin",
        timestamp: NOW,
        input: "ls -la /tmp",
        output: "total 8\ndrwxr-xr-x  4 me  staff  128 ...",
      },
    ]
  );
  try {
    const data = JSON.parse(toolEvent.data ?? "{}") as Record<string, unknown>;
    // The string input is carried under `tool_input`, not dropped.
    assert.equal(data.tool_input, "ls -la /tmp");

    const [bash] = tools.items;
    assert.equal(bash?.label, "Bash");
    assert.ok(
      bash?.input,
      "a string-shaped tool input still yields a non-empty trace input"
    );
    assert.match(bash?.input ?? "", STRING_INPUT_PATTERN);
    assert.ok(bash?.output, "the tool row still carries its captured output");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("imported ARRAY-shaped tool input still reaches the trace tool row (bug 019f881c)", async () => {
  const { db, dir, toolEvent, tools } = await importAndProjectTools(
    "tool-detail-array-input",
    [
      {
        name: "Bash",
        kind: "builtin",
        timestamp: NOW,
        input: ["ls", "-la", "/tmp"],
        output: "total 8",
      },
    ]
  );
  try {
    const data = JSON.parse(toolEvent.data ?? "{}") as Record<string, unknown>;
    assert.ok(
      Array.isArray(data.tool_input),
      "array input is carried under tool_input"
    );

    const [bash] = tools.items;
    assert.ok(
      bash?.input,
      "an array-shaped tool input still yields a non-empty trace input"
    );
    assert.match(bash?.input ?? "", ARRAY_INPUT_PATTERN);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("imported tool error is preserved as an errored trace tool row (bug 019f881c)", async () => {
  const { db, dir, toolEvent, tools } = await importAndProjectTools(
    "tool-detail-error",
    [
      {
        name: "Bash",
        kind: "builtin",
        timestamp: NOW,
        input: { command: "false" },
        output: "command failed",
        isError: true,
      },
    ]
  );
  try {
    const data = JSON.parse(toolEvent.data ?? "{}") as Record<string, unknown>;
    assert.equal(data.isError, true, "persisted data.isError is set");

    const [bash] = tools.items;
    assert.equal(bash?.err, true, "the tool row is flagged as an error");
    assert.ok(bash?.output, "an errored row still carries its captured output");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
