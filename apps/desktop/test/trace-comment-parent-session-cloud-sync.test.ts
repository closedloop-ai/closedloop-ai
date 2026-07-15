import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import type {
  AgentSessionSyncTransportPayload,
  SyncedAgentSession,
} from "../src/main/agent-session-sync-contract.js";
import {
  syncTraceCommentParentSessionPayloads,
  type TraceCommentParentSessionSyncResult,
} from "../src/main/trace-comment-parent-session-cloud-sync.js";

const TOO_LARGE_FOR_CLOUD_SYNC_PATTERN = /too large for cloud sync/;
const EVENT_HEAVY_COUNT = 4000;
const UNCHUNKABLE_AGENT_COUNT = 5000;

test("trace-comment parent-session sync posts one whole-session payload", async () => {
  const payloads: AgentSessionSyncTransportPayload[] = [];

  await syncTraceCommentParentSessionPayloads(
    makeSession(),
    (payload): Promise<TraceCommentParentSessionSyncResult> => {
      payloads.push(payload);
      return Promise.resolve({ synced: true });
    }
  );

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].sessionCount, 1);
  assert.equal(payloads[0].syncMode, AgentSessionSyncMode.Incremental);
  // FEA-2718: turn text is stripped, so the synced event carries no `data`.
  assert.equal(Object.hasOwn(payloads[0].sessions[0].events[0], "data"), false);
});

test("trace-comment parent-session sync chunks an event-heavy session", async () => {
  const payloads: AgentSessionSyncTransportPayload[] = [];

  await syncTraceCommentParentSessionPayloads(
    makeEventHeavySession(),
    (payload): Promise<TraceCommentParentSessionSyncResult> => {
      payloads.push(payload);
      return Promise.resolve({ synced: true });
    }
  );

  assert.ok(
    payloads.length > 1,
    "expected the oversized event array to split into whole-session chunks"
  );
  const totalEvents = payloads.reduce(
    (sum, payload) => sum + payload.sessions[0].events.length,
    0
  );
  assert.equal(totalEvents, EVENT_HEAVY_COUNT);
});

test("trace-comment parent-session sync rejects a session too large to chunk", async () => {
  const payloads: AgentSessionSyncTransportPayload[] = [];

  await assert.rejects(
    () =>
      syncTraceCommentParentSessionPayloads(
        makeUnchunkableSession(),
        (payload): Promise<TraceCommentParentSessionSyncResult> => {
          payloads.push(payload);
          return Promise.resolve({ synced: true });
        }
      ),
    TOO_LARGE_FOR_CLOUD_SYNC_PATTERN
  );

  assert.deepEqual(payloads, []);
});

function baseSession(): SyncedAgentSession {
  return {
    externalSessionId: "trace-parent-session",
    status: "completed",
    harness: "codex",
    cwd: "/workspace/trace-parent-session",
    startedAt: "2026-06-08T12:00:00.000Z",
    updatedAt: "2026-06-08T12:01:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
  };
}

function makeSession(): SyncedAgentSession {
  return {
    ...baseSession(),
    events: [
      {
        externalEventId: "trace-parent-event",
        eventType: "ToolUse",
        toolName: "Read",
        createdAt: "2026-06-08T12:00:30.000Z",
        // Retained on the local session but dropped by sanitize before sync.
        data: { payload: "x".repeat(4096) },
      },
    ],
  };
}

function makeEventHeavySession(): SyncedAgentSession {
  return {
    ...baseSession(),
    events: Array.from({ length: EVENT_HEAVY_COUNT }, (_, index) => ({
      externalEventId: `trace-heavy-event-${String(index).padStart(6, "0")}`,
      eventType: "ToolUse",
      toolName: "Read",
      createdAt: "2026-06-08T12:00:30.000Z",
    })),
  };
}

function makeUnchunkableSession(): SyncedAgentSession {
  // Chunking paginates the event array but replicates every agent into each
  // chunk, so a session whose agents alone exceed the cap can never produce a
  // valid chunk and must dead-letter (surfaced here as the too-large error).
  return {
    ...baseSession(),
    agents: Array.from({ length: UNCHUNKABLE_AGENT_COUNT }, (_, index) => ({
      externalAgentId: `trace-unchunkable-agent-${String(index).padStart(6, "0")}`,
      name: `agent-${index}`,
      type: "subagent",
      status: "completed",
    })),
  };
}
