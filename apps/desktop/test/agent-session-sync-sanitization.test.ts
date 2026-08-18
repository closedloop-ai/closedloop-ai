import assert from "node:assert/strict";
import { test } from "node:test";
import { compactMetadataForPreview } from "@repo/lib/agent-sessions/metadata-preview.js";
import { projectAgentSessionTimelineEvents } from "@repo/lib/sessions/agent-session-detail-projection.js";
import type {
  AgentSessionSyncBatch,
  SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import { sanitizeSessionForSync } from "../src/main/agent-sync/agent-session-sync-payload.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";

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
    isHttpReady: () => true,
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

// FEAT 019f881c: recognizable secrets in the `metadata.messages[]` text preview
// (the DISPLAY source for the cloud timeline) must be redacted at the producer
// sanitizer boundary so a raw secret never crosses the wire.
test("sanitizeSessionForSync redacts secrets in the metadata.messages mirror", () => {
  const A32 = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
  const session: SyncedAgentSession = {
    ...makeSyncedSession(),
    metadata: {
      messages: [
        {
          role: "user",
          text: `here is my key sk_live_${A32} and token ghp_${A32}0000`,
        },
      ],
    },
  };

  const sanitized = sanitizeSessionForSync(session);
  const mirror = JSON.stringify(sanitized.metadata);

  assert.equal(mirror.includes(A32), false);
  assert.equal(mirror.includes("sk_live_"), false);
  assert.equal(mirror.includes("[REDACTED:sk_live]"), true);
  assert.equal(mirror.includes("[REDACTED:ghp]"), true);
});

// FEA-3693: the desktop producer and the cloud persist boundary
// (`sanitizeMetadataForPersist`) must emit byte-identical `metadata` for the same
// normalized transcript. Both now delegate to the ONE shared preview contract
// (`compactMetadataForPreview`), so the desktop `sanitizeSessionForSync` output
// must equal the shared helper's output — including the per-message preview floor
// (a long conversation whose aggregate budget is spent keeps a floor-length
// preview on every later turn rather than dropping `text`, which is what the API
// lane used to do) and the `textTruncation` markers. The API-side half of this
// contract is asserted in
// `apps/api/app/agent-sessions/service/metadata-sanitizer.test.ts`.
test("sanitizeSessionForSync metadata equals the shared FEA-3693 preview contract (floor + truncation markers)", () => {
  const messages = [
    { role: "user", timestamp: "t0", text: "z".repeat(4096) },
    { role: "assistant", timestamp: "t1" },
    ...Array.from({ length: 100 }, () => ({
      role: "user",
      timestamp: "t2",
      text: "q".repeat(2500),
    })),
  ];
  const session: SyncedAgentSession = {
    ...makeSyncedSession(),
    metadata: { gitBranch: "main", messages } as SyncedAgentSession["metadata"],
  };

  const sanitized = sanitizeSessionForSync(session);
  assert.deepEqual(
    sanitized.metadata,
    compactMetadataForPreview(session.metadata)
  );

  // Concretely: every later, budget-exhausted turn keeps the 160-char floor and
  // is truthfully marked `previewed` — never dropped to `undefined`.
  const out = (sanitized.metadata as { messages: Record<string, unknown>[] })
    .messages;
  const last = out.at(-1) as Record<string, unknown>;
  assert.equal(typeof last.text, "string");
  assert.equal((last.text as string).length, 160);
  assert.equal(last.textTruncation, "previewed");
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
