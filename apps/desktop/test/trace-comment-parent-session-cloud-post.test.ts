import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
} from "@repo/api/src/types/agent-session";
import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { postTraceCommentParentSessionCloudSync } from "../src/main/trace-comments/trace-comment-parent-session-cloud-post.js";

const originalFetch = globalThis.fetch;
const FINAL_FRAGMENT_PENDING_PATTERN = /final fragment pending/;
const SYNC_REQUEST_FAILED_PATTERN =
  /Agent session sync request failed with status 200/;
const CREDENTIALS_UNAVAILABLE_PATTERN =
  /Desktop cloud session sync credentials unavailable/;

// FEA-3425 (Phase 4a): the parent-session sync post is session-only — the
// static `sk_live_*` key (+PoP) fallback was removed once session coverage
// cleared the D7 no-strand gate.
describe("trace-comment parent-session direct cloud sync post (session-only)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("posts to the direct sync route under the session Bearer and returns the materialized result", async () => {
    const requests: Array<{
      body: string | null;
      headers: Headers;
      signal: AbortSignal | null | undefined;
      url: URL;
    }> = [];
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      requests.push({
        body: init?.body?.toString() ?? null,
        headers: new Headers(init?.headers),
        signal: init?.signal,
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
        getAccessToken: () => Promise.resolve("session-token-1"),
        getApiOrigin: () => "https://api.example.test",
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
    assert.equal(
      requests[0].headers.get("Authorization"),
      "Bearer session-token-1"
    );
    assert.equal(requests[0].headers.get("Content-Type"), "application/json");
    // PoP is an API-key-binding concern — never sent with the session Bearer.
    assert.equal(requests[0].headers.get("X-Desktop-Gateway-Id"), null);
    // The POST must carry a timeout AbortSignal so a hung dependency cannot
    // stall the pending-comment sync retry loop indefinitely (FEA-3599).
    assert.ok(requests[0].signal instanceof AbortSignal);
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
            getAccessToken: () => Promise.resolve("session-token-1"),
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
            getAccessToken: () => Promise.resolve("session-token-1"),
            getApiOrigin: () => "https://api.example.test",
          },
          "target-1"
        ),
      SYNC_REQUEST_FAILED_PATTERN
    );
  });

  test("rejects with credentials-unavailable and never POSTs when no session token exists", async () => {
    const requests: URL[] = [];
    globalThis.fetch = (input) => {
      requests.push(new URL(String(input)));
      return Promise.resolve(
        Response.json({ success: true, data: { synced: true } })
      );
    };

    await assert.rejects(
      () =>
        postTraceCommentParentSessionCloudSync(
          "session-1",
          makePayload(),
          {
            getAccessToken: () => Promise.resolve(null),
            getApiOrigin: () => "https://api.example.test",
          },
          "target-1"
        ),
      CREDENTIALS_UNAVAILABLE_PATTERN
    );
    assert.equal(requests.length, 0, "no session token → no POST");
  });

  test("rejects with credentials-unavailable when the session token read throws", async () => {
    const requests: URL[] = [];
    globalThis.fetch = (input) => {
      requests.push(new URL(String(input)));
      return Promise.resolve(
        Response.json({ success: true, data: { synced: true } })
      );
    };

    await assert.rejects(
      () =>
        postTraceCommentParentSessionCloudSync(
          "session-1",
          makePayload(),
          {
            getAccessToken: () => Promise.reject(new Error("keychain locked")),
            getApiOrigin: () => "https://api.example.test",
          },
          "target-1"
        ),
      CREDENTIALS_UNAVAILABLE_PATTERN
    );
    assert.equal(requests.length, 0, "thrown token read → no POST");
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
