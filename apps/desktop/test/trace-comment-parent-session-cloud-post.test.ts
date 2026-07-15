import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
} from "@repo/api/src/types/agent-session";
import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "../src/main/agent-session-sync-contract.js";
import { postTraceCommentParentSessionCloudSync } from "../src/main/trace-comment-parent-session-cloud-post.js";

const originalFetch = globalThis.fetch;
const FINAL_FRAGMENT_PENDING_PATTERN = /final fragment pending/;
const SYNC_REQUEST_FAILED_PATTERN =
  /Agent session sync request failed with status 200/;

describe("trace-comment parent-session direct cloud sync post", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("posts to the direct sync route and returns the materialized result", async () => {
    const requests: Array<{ body: string | null; headers: Headers; url: URL }> =
      [];
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      requests.push({
        body: init?.body?.toString() ?? null,
        headers: new Headers(init?.headers),
        url,
      });
      return Promise.resolve(
        Response.json({ success: true, data: { synced: true } })
      );
    };

    const logs: Array<{ message: string; scope: string }> = [];
    const result = await postTraceCommentParentSessionCloudSync(
      "session-1",
      makePayload(),
      {
        getApiKey: () => "api-key-1",
        getApiOrigin: () => "https://api.example.test",
        getApiKeyProvenance: () => "DESKTOP_MANAGED",
        signDesktopRequest: () => ({
          "X-Desktop-Gateway-Id": "gateway-1",
          "X-Desktop-Signature": "signature-1",
          "X-Desktop-Timestamp": "1234567890",
        }),
        log: (scope, message) => logs.push({ message, scope }),
      },
      "target-1"
    );

    assert.deepEqual(result, { synced: true });
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url.href,
      "https://api.example.test/desktop/agent-sessions/sync?computeTargetId=target-1"
    );
    assert.equal(requests[0].headers.get("Authorization"), "Bearer api-key-1");
    assert.equal(requests[0].headers.get("Content-Type"), "application/json");
    assert.equal(requests[0].headers.get("X-Desktop-Gateway-Id"), "gateway-1");
    assert.deepEqual(JSON.parse(requests[0].body ?? ""), makePayload());
    assert.deepEqual(logs, [
      {
        message: "Synced parent session for session-1",
        scope: "trace-comments",
      },
    ]);
  });

  test("surfaces direct sync errors without treating pending as synced", async () => {
    globalThis.fetch = async () =>
      Response.json(
        { success: false, error: "final fragment pending" },
        { status: 409 }
      );

    await assert.rejects(
      () =>
        postTraceCommentParentSessionCloudSync(
          "session-1",
          makePayload(),
          {
            getApiKey: () => "api-key-1",
            getApiOrigin: () => "https://api.example.test",
          },
          "target-1"
        ),
      FINAL_FRAGMENT_PENDING_PATTERN
    );
  });

  test("rejects malformed successful direct sync responses", async () => {
    globalThis.fetch = async () =>
      Response.json({ success: true, data: { synced: false } });

    await assert.rejects(
      () =>
        postTraceCommentParentSessionCloudSync(
          "session-1",
          makePayload(),
          {
            getApiKey: () => "api-key-1",
            getApiOrigin: () => "https://api.example.test",
          },
          "target-1"
        ),
      SYNC_REQUEST_FAILED_PATTERN
    );
  });
});

function makePayload(): DesktopAgentSessionsPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000000001",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [
      {
        externalSessionId: "session-1",
        status: "completed",
        harness: "codex",
        cwd: "/workspace/session-1",
        startedAt: "2026-06-08T12:00:00.000Z",
        updatedAt: "2026-06-08T12:01:00.000Z",
        agents: [],
        events: [],
        tokenUsageByModel: [],
      },
    ],
  };
}
