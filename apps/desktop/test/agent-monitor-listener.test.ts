import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { HookData } from "../src/main/agent-dashboard-db-types.js";
import {
  type AgentHookLifecycle,
  AgentHookListener,
} from "../src/main/agent-monitor-listener.js";

type PostResult = {
  status: number;
  body: unknown;
};

function request(
  url: string,
  method: string,
  payload?: unknown
): Promise<PostResult> {
  return requestRaw(
    url,
    method,
    payload === undefined ? undefined : JSON.stringify(payload)
  );
}

function requestRaw(
  url: string,
  method: string,
  data?: string
): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method,
        headers: data
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data),
            }
          : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : null,
          });
        });
      }
    );
    req.on("error", reject);
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

type ListenerDiagnostics = {
  emits: string[];
  logs: string[];
};

type CapturedSession = {
  id: string;
  harness: string;
  cwd: string | null;
};

class InMemoryHookLifecycle implements AgentHookLifecycle {
  readonly sessions = {
    getAll: async (): Promise<CapturedSession[]> => [
      ...this.sessionRows.values(),
    ],
    getById: async (id: string): Promise<CapturedSession | null> =>
      this.sessionRows.get(id) ?? null,
  };

  private readonly sessionRows = new Map<string, CapturedSession>();

  constructor(private readonly diagnostics: ListenerDiagnostics) {}

  processEvent(hookType: string, data: HookData, harness: string): boolean {
    if (hookType !== "SessionStart") {
      return false;
    }
    const sessionId = data.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return false;
    }
    this.sessionRows.set(sessionId, {
      id: sessionId,
      harness,
      cwd: typeof data.cwd === "string" ? data.cwd : null,
    });
    this.diagnostics.emits.push(sessionId);
    return true;
  }
}

async function withListener(
  run: (
    url: string,
    lifecycle: InMemoryHookLifecycle,
    diagnostics: ListenerDiagnostics
  ) => Promise<void>
): Promise<void> {
  const diagnostics: ListenerDiagnostics = { emits: [], logs: [] };
  const lifecycle = new InMemoryHookLifecycle(diagnostics);
  const listener = new AgentHookListener({
    lifecycle,
    log: (message) => diagnostics.logs.push(message),
    port: 0,
  });
  await listener.start();
  const url = listener.getUrl();
  assert.ok(url, "listener bound to an ephemeral port");
  try {
    await run(url!, lifecycle, diagnostics);
  } finally {
    await listener.stop();
  }
}

async function assertNoWritesOrEmits(
  lifecycle: InMemoryHookLifecycle,
  diagnostics: ListenerDiagnostics
): Promise<void> {
  assert.equal(
    (await lifecycle.sessions.getAll()).length,
    0,
    "no session rows written"
  );
  assert.deepEqual(diagnostics.emits, [], "no live DB-change emits");
}

test("listener: GET /api/health returns 200 ok", async () => {
  await withListener(async (url) => {
    const res = await request(`${url}/api/health`, "GET");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });
});

test("listener: SessionStart writes a session with harness=claude", async () => {
  await withListener(async (url, db, diagnostics) => {
    const res = await request(`${url}/api/hooks/event`, "POST", {
      hook_type: "SessionStart",
      data: { session_id: "s1", cwd: "/work/project" },
    });
    assert.equal(res.status, 200);
    const session = await db.sessions.getById("s1");
    assert.ok(session, "session written");
    assert.equal(session?.harness, "claude");
    assert.deepEqual(diagnostics.emits, ["s1"]);
  });
});

test("listener: payload provider hints are rejected before writes", async () => {
  await withListener(async (url, db, diagnostics) => {
    const res = await request(`${url}/api/hooks/event`, "POST", {
      hook_type: "SessionStart",
      data: { session_id: "ph1", cwd: "/work/project", __provider: "codex" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      ok: true,
      skipped: "invalid-provider-hint",
    });
    await assertNoWritesOrEmits(db, diagnostics);
  });
});

test("listener: malformed, invalid, and oversized payloads fail soft without writes", async () => {
  await withListener(async (url, db, diagnostics) => {
    const malformed = await requestRaw(
      `${url}/api/hooks/event`,
      "POST",
      "{not-json-secret:super-secret-value"
    );
    assert.equal(malformed.status, 200);
    assert.deepEqual(malformed.body, { ok: false });
    await assertNoWritesOrEmits(db, diagnostics);
    assert.equal(
      diagnostics.logs.some((message) =>
        message.includes("super-secret-value")
      ),
      false,
      "malformed-body diagnostics stay key-free"
    );

    const invalidEnvelope = await request(`${url}/api/hooks/event`, "POST", {
      hook_type: 123,
      data: { session_id: "invalid", cwd: "/work/project" },
    });
    assert.equal(invalidEnvelope.status, 200);
    assert.deepEqual(invalidEnvelope.body, { ok: true, skipped: "invalid" });
    await assertNoWritesOrEmits(db, diagnostics);

    const oversized = await requestRaw(
      `${url}/api/hooks/event`,
      "POST",
      JSON.stringify({
        hook_type: "SessionStart",
        data: {
          session_id: "large",
          cwd: "/work/project",
          blob: "x".repeat(8 * 1024 * 1024),
        },
      })
    );
    assert.equal(oversized.status, 200);
    assert.deepEqual(oversized.body, { ok: false });
    await assertNoWritesOrEmits(db, diagnostics);
  });
});

test("listener: sessions from any directory are captured (no sandbox gating)", async () => {
  await withListener(async (url, db, diagnostics) => {
    const res = await request(`${url}/api/hooks/event`, "POST", {
      hook_type: "SessionStart",
      data: { session_id: "anywhere", cwd: "/somewhere/else" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    const session = await db.sessions.getById("anywhere");
    assert.ok(session, "session from any directory is imported");
    assert.deepEqual(diagnostics.emits, ["anywhere"]);
  });
});
