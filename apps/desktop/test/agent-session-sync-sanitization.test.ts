import assert from "node:assert/strict";
import { test } from "node:test";
import { projectAgentSessionTimelineEvents } from "@repo/api/src/agent-session-detail-projection.js";
import type {
  AgentSessionSyncBatch,
  SyncedAgentSession,
} from "../src/main/agent-session-sync-contract.js";
import { sanitizeSessionForSync } from "../src/main/agent-session-sync-payload.js";
import {
  AgentSessionSyncService,
  type AgentSessionSyncSource,
} from "../src/main/agent-session-sync-service.js";

// FEA-2718: every synced event is reconstructed from retained columnar metadata
// only — turn text (`summary`/`data`) never crosses the wire, so the sanitized
// event has exactly these keys and nothing else.
const SLIM_EVENT_KEYS = JSON.stringify(
  [
    "externalEventId",
    "agentExternalId",
    "eventType",
    "toolName",
    "createdAt",
  ].sort()
);

// Boolean-only (no assertions) so callers assert inside their own test() body,
// per Biome's noMisplacedAssertion rule.
function isSlimSyncedEvent(event: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(event, "summary") === false &&
    Object.hasOwn(event, "data") === false &&
    JSON.stringify(Object.keys(event).sort()) === SLIM_EVENT_KEYS
  );
}

test("agent-session sync sends all source sessions with turn-text-free events", async () => {
  const sourceSession = makeSyncedSession();
  const source: AgentSessionSyncSource = {
    listAllSessionCursorRows: () => [
      {
        id: sourceSession.externalSessionId,
        updated_at: sourceSession.updatedAt,
      },
    ],
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: () => [sourceSession],
  };
  const sent: AgentSessionSyncBatch[] = [];
  const service = new AgentSessionSyncService({
    isAgentMonitorEnabled: () => true,
    isRelayReady: () => true,
    getSource: () => source,
    sendBatch: async (batch) => {
      sent.push(batch);
      return { accepted: true };
    },
  });

  service.start();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(sent.length, 1);
  const syncedSession = sent[0].sessions[0];
  assert.equal(syncedSession.externalSessionId, "outside-sandbox");
  assert.equal(syncedSession.cwd, "/outside/sandbox/project");
  assert.equal(syncedSession.events.length, 2);
  assert.equal(
    syncedSession.events.every((event) =>
      isSlimSyncedEvent(event as unknown as Record<string, unknown>)
    ),
    true
  );
});

test("sanitizeSessionForSync drops turn text but the desktop-local projection keeps detail", () => {
  const local = makeSyncedSession();
  const sanitized = sanitizeSessionForSync(local);

  assert.equal(
    sanitized.events.every((event) =>
      isSlimSyncedEvent(event as unknown as Record<string, unknown>)
    ),
    true
  );

  // The UNSANITIZED local events still hydrate detail for the local trace...
  const localTimeline = projectAgentSessionTimelineEvents(local.events);
  assert.ok(localTimeline.length > 0);
  assert.equal(
    localTimeline.every((event) => event.detail),
    true
  );
  // ...while the sanitized (cloud) events yield no detail at all.
  assert.equal(
    projectAgentSessionTimelineEvents(sanitized.events).every(
      (event) => event.detail === undefined
    ),
    true
  );
});

function makeSyncedSession(): SyncedAgentSession {
  return {
    externalSessionId: "outside-sandbox",
    status: "completed",
    harness: "codex",
    cwd: "/outside/sandbox/project",
    startedAt: "2026-06-08T12:00:00.000Z",
    updatedAt: "2026-06-08T12:05:00.000Z",
    agents: [],
    events: [
      {
        externalEventId: "event-1",
        eventType: "PostToolUse",
        toolName: "exec_command",
        summary: "raw tool error text",
        createdAt: "2026-06-08T12:01:00.000Z",
        data: {
          arguments: ["-C", "packages/api", "test"],
          command: "pnpm",
          prompt: "run private command",
          content: "file contents",
          new_string: "replacement text",
          old_string: "original text",
          stdout: "command output",
          stderr: "command errors",
          text: "assistant text",
          output: "tool output",
          patch: "diff content",
          reasoning: "hidden reasoning",
          exitCode: 0,
          nested: {
            arguments: ["status", "--short"],
            command: "git",
            prompt: "nested prompt",
            content: "nested content",
            new_string: "nested replacement",
            old_string: "nested original",
            stdout: "nested stdout",
            stderr: "nested stderr",
            text: "nested text",
            output: "nested output",
            patch: "nested diff",
            reasoning: "nested reasoning",
            safe: "preserved",
          },
        },
      },
      {
        externalEventId: "event-2",
        eventType: "PostToolUse",
        toolName: "exec_command",
        summary: "raw command output",
        createdAt: "2026-06-08T12:02:00.000Z",
        data: {
          tool_input: {
            arguments: ["diff", "--stat"],
            executable: "git",
            prompt: "private tool input",
          },
          tool_response: {
            exitCode: 0,
            stdout: "diff output",
          },
        },
      },
    ],
    tokenUsageByModel: [],
  };
}

async function flushAgentSessionSync(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
