/**
 * @file ISS-11283 branch coverage for agent-monitor/agent-monitor-listener.ts
 * paths the existing suites never exercise: the default-port fallback, the
 * getUrl()/start()/stop() idempotency guards, the unmatched-route 404, the
 * Session Mesh origin/CSRF rejection, the `data` field omitted from either
 * hook envelope, the Session Mesh "unavailable" skip and provider-hint guard,
 * and both failure-callback ternaries (Error vs non-Error thrown/rejected
 * values) on the Claude hook route and the Session Mesh route.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentHookLifecycle,
  AgentHookListener,
} from "../src/main/agent-monitor/agent-monitor-listener.js";
import type { HookData } from "../src/main/dashboard/agent-dashboard-db-types.js";
import { AGENT_MONITOR_PORT } from "../src/shared/contracts.js";

const GENERIC_BIND_ERROR_PREFIX = "Agent hook listener error: ";
// The listener's private HOST constant; not exported by the module.
const LISTENER_HOST = "127.0.0.1";

type HttpResult = { status: number; body: unknown };

function request(
  url: string,
  method: string,
  payload?: unknown,
  headers?: Record<string, string>
): Promise<HttpResult> {
  return requestRaw(
    url,
    method,
    payload === undefined ? undefined : JSON.stringify(payload),
    headers
  );
}

function requestRaw(
  url: string,
  method: string,
  data?: string,
  headers?: Record<string, string>
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method,
        headers: {
          ...(data
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data),
              }
            : {}),
          ...headers,
        },
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

const INERT_LIFECYCLE: AgentHookLifecycle = {
  processEvent: () => false,
};

const activeListeners: AgentHookListener[] = [];

function trackedListener(
  options: ConstructorParameters<typeof AgentHookListener>[0]
): AgentHookListener {
  const listener = new AgentHookListener(options);
  activeListeners.push(listener);
  return listener;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (activeListeners.length > 0) {
    const listener = activeListeners.pop();
    await listener?.stop();
  }
});

describe("AgentHookListener: port defaulting and idempotent start/stop", () => {
  it("getUrl() is null before start() (not ready, no bound port)", () => {
    const listener = trackedListener({
      lifecycle: INERT_LIFECYCLE,
      port: 0,
    });
    expect(listener.getUrl()).toBeNull();
    expect(listener.isReady()).toBe(false);
  });

  it("listens on AGENT_MONITOR_PORT when no port override is given", async () => {
    // listen() is stubbed so the real 4820 is never bound (see
    // loopback-port-isolation.test.ts). The stub never binds, so address() is
    // null and getUrl() falls back to the configured port.
    const listenArgs = stubListen((server) => {
      queueMicrotask(() => server.emit("listening"));
    });
    const listener = trackedListener({ lifecycle: INERT_LIFECYCLE });
    await listener.start();
    expect(listenArgs).toEqual([[AGENT_MONITOR_PORT, LISTENER_HOST]]);
    expect(listener.isReady()).toBe(true);
    expect(listener.getUrl()).toBe(
      `http://${LISTENER_HOST}:${AGENT_MONITOR_PORT}`
    );
  });

  it("start() called twice is a no-op the second time (server already bound)", async () => {
    const listener = trackedListener({
      lifecycle: INERT_LIFECYCLE,
      port: 0,
    });
    await listener.start();
    const firstUrl = listener.getUrl();
    await listener.start();
    expect(listener.getUrl()).toBe(firstUrl);
  });

  it("stop() on a listener that never started resolves without throwing", async () => {
    const listener = trackedListener({
      lifecycle: INERT_LIFECYCLE,
      port: 0,
    });
    await assert.doesNotReject(() => listener.stop());
    expect(listener.isReady()).toBe(false);
  });

  it("a bind error other than EADDRINUSE reports the generic error message", async () => {
    stubListen((server) => {
      queueMicrotask(() => server.emit("error", eaccesError()));
    });
    const reasons: string[] = [];
    const logs: string[] = [];
    const listener = trackedListener({
      lifecycle: INERT_LIFECYCLE,
      port: 0,
      log: (message) => logs.push(message),
      onBindError: (reason) => reasons.push(reason),
    });
    await listener.start();
    expect(listener.isReady()).toBe(false);
    expect(listener.getUrl()).toBeNull();
    expect(reasons).toEqual([`${GENERIC_BIND_ERROR_PREFIX}permission denied`]);
    expect(logs).toEqual(reasons);
  });

  it("does not throw on a bind error when onBindError is not supplied", async () => {
    stubListen((server) => {
      queueMicrotask(() => server.emit("error", eaccesError()));
    });
    const listener = trackedListener({ lifecycle: INERT_LIFECYCLE, port: 0 });
    await expect(listener.start()).resolves.toBeUndefined();
    expect(listener.isReady()).toBe(false);
  });
});

describe("AgentHookListener: routing", () => {
  it("returns 404 for a path/method combination that matches no route", async () => {
    const listener = trackedListener({
      lifecycle: INERT_LIFECYCLE,
      port: 0,
    });
    await listener.start();
    const url = listener.getUrl();
    assert.ok(url);
    const res = await request(`${url}/api/does-not-exist`, "GET");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: "not found" });
  });

  it("returns 404 for a GET to a session-mesh path (method check is AND, not OR, with the path check)", async () => {
    const listener = trackedListener({
      lifecycle: INERT_LIFECYCLE,
      port: 0,
    });
    await listener.start();
    const url = listener.getUrl();
    assert.ok(url);
    const res = await request(`${url}/api/session-mesh/hook`, "GET");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: "not found" });
  });

  it("rejects a Session Mesh request carrying an Origin header (browser CSRF guard)", async () => {
    const listener = trackedListener({
      lifecycle: INERT_LIFECYCLE,
      port: 0,
    });
    await listener.start();
    const url = listener.getUrl();
    assert.ok(url);
    const res = await request(
      `${url}/api/session-mesh/hook`,
      "POST",
      { harness: "claude", hook_type: "SessionStart", data: {} },
      { Origin: "http://evil.example" }
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false });
  });

  it("rejects a Session Mesh request carrying a Sec-Fetch-Site header", async () => {
    const listener = trackedListener({
      lifecycle: INERT_LIFECYCLE,
      port: 0,
    });
    await listener.start();
    const url = listener.getUrl();
    assert.ok(url);
    const res = await request(
      `${url}/api/session-mesh/hook`,
      "POST",
      { harness: "claude", hook_type: "SessionStart", data: {} },
      { "Sec-Fetch-Site": "cross-site" }
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false });
  });
});

describe("AgentHookListener: Claude hook route data-field defaulting", () => {
  it("treats an omitted `data` field as an empty object rather than failing", async () => {
    const seen: HookData[] = [];
    const lifecycle: AgentHookLifecycle = {
      processEvent: (_hookType, data) => {
        seen.push(data);
        return false;
      },
    };
    const listener = trackedListener({ lifecycle, port: 0 });
    await listener.start();
    const url = listener.getUrl();
    assert.ok(url);
    const res = await request(`${url}/api/hooks/event`, "POST", {
      hook_type: "SessionStart",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(seen).toEqual([{}]);
  });
});

describe("AgentHookListener: Claude hook route processEvent failure ternary", () => {
  it("logs error.message when processEvent's promise rejects with an Error", async () => {
    const logs: string[] = [];
    const lifecycle: AgentHookLifecycle = {
      processEvent: () => Promise.reject(new Error("lifecycle-boom")),
    };
    const listener = trackedListener({
      lifecycle,
      port: 0,
      log: (message) => logs.push(message),
    });
    await listener.start();
    const url = listener.getUrl();
    assert.ok(url);
    const res = await request(`${url}/api/hooks/event`, "POST", {
      hook_type: "SessionStart",
      data: { session_id: "s1" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
    expect(logs).toContain(
      "agent hook listener: failed to process event: lifecycle-boom"
    );
  });

  it("logs String(error) when processEvent's promise rejects with a non-Error value", async () => {
    const logs: string[] = [];
    const lifecycle: AgentHookLifecycle = {
      processEvent: () => Promise.reject("lifecycle-boom-string"),
    };
    const listener = trackedListener({
      lifecycle,
      port: 0,
      log: (message) => logs.push(message),
    });
    await listener.start();
    const url = listener.getUrl();
    assert.ok(url);
    const res = await request(`${url}/api/hooks/event`, "POST", {
      hook_type: "SessionStart",
      data: { session_id: "s1" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
    expect(logs).toContain(
      "agent hook listener: failed to process event: lifecycle-boom-string"
    );
  });

  it("logs String(error) via the outer catch when processEvent throws a non-Error synchronously", async () => {
    const logs: string[] = [];
    const lifecycle: AgentHookLifecycle = {
      processEvent: () => {
        // biome-ignore lint/style/useThrowOnlyError: pins the non-Error outer-catch branch
        throw "sync-non-error";
      },
    };
    const listener = trackedListener({
      lifecycle,
      port: 0,
      log: (message) => logs.push(message),
    });
    await listener.start();
    const url = listener.getUrl();
    assert.ok(url);
    const res = await request(`${url}/api/hooks/event`, "POST", {
      hook_type: "SessionStart",
      data: { session_id: "s1" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
    expect(logs).toContain(
      "agent hook listener: failed to handle event: sync-non-error"
    );
  });
});

describe("AgentHookListener: Session Mesh route branches", () => {
  it("skips as unavailable when the envelope fails schema validation", async () => {
    const received: unknown[] = [];
    const listener = trackedListener({
      lifecycle: INERT_LIFECYCLE,
      port: 0,
      onSessionMeshHookEvent: (event) => {
        received.push(event);
      },
    });
    await listener.start();
    const url = listener.getUrl();
    assert.ok(url);
    const res = await request(`${url}/api/session-mesh/hook`, "POST", {
      harness: "not-a-real-harness",
      hook_type: "SessionStart",
      data: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, skipped: "unavailable" });
    expect(received).toEqual([]);
  });

  it("treats an omitted `data` field on the Session Mesh envelope as an empty object", async () => {
    const received: Array<{ data: HookData }> = [];
    const listener = trackedListener({
      lifecycle: INERT_LIFECYCLE,
      port: 0,
      onSessionMeshHookEvent: (event) => {
        received.push({ data: event.data });
      },
    });
    await listener.start();
    const url = listener.getUrl();
    assert.ok(url);
    const res = await request(`${url}/api/session-mesh/hook`, "POST", {
      harness: "claude",
      hook_type: "SessionStart",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(received).toEqual([{ data: {} }]);
  });

  it("rejects a Session Mesh payload carrying the provider hint field", async () => {
    const received: unknown[] = [];
    const listener = trackedListener({
      lifecycle: INERT_LIFECYCLE,
      port: 0,
      onSessionMeshHookEvent: (event) => {
        received.push(event);
      },
    });
    await listener.start();
    const url = listener.getUrl();
    assert.ok(url);
    const res = await request(`${url}/api/session-mesh/hook`, "POST", {
      harness: "claude",
      hook_type: "SessionStart",
      data: { session_id: "s1", __provider: "codex" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, skipped: "invalid-provider-hint" });
    expect(received).toEqual([]);
  });

  it("logs error.message when onSessionMeshHookEvent's promise rejects with an Error", async () => {
    const logs: string[] = [];
    const listener = trackedListener({
      lifecycle: INERT_LIFECYCLE,
      port: 0,
      log: (message) => logs.push(message),
      onSessionMeshHookEvent: () => Promise.reject(new Error("mesh-boom")),
    });
    await listener.start();
    const url = listener.getUrl();
    assert.ok(url);
    const res = await request(`${url}/api/session-mesh/hook`, "POST", {
      harness: "claude",
      hook_type: "SessionStart",
      data: { session_id: "s1" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
    expect(logs).toContain(
      "session mesh hook listener: failed to process event: mesh-boom"
    );
  });

  it("logs String(error) when onSessionMeshHookEvent's promise rejects with a non-Error value", async () => {
    const logs: string[] = [];
    const listener = trackedListener({
      lifecycle: INERT_LIFECYCLE,
      port: 0,
      log: (message) => logs.push(message),
      onSessionMeshHookEvent: () => Promise.reject("mesh-boom-string"),
    });
    await listener.start();
    const url = listener.getUrl();
    assert.ok(url);
    const res = await request(`${url}/api/session-mesh/hook`, "POST", {
      harness: "claude",
      hook_type: "SessionStart",
      data: { session_id: "s1" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
    expect(logs).toContain(
      "session mesh hook listener: failed to process event: mesh-boom-string"
    );
  });
});

/** Replaces the next http.createServer() with a real, never-bound server whose
 *  listen() records its (port, host) and runs `onListen` instead of binding.
 *  Returns the recorded listen arguments. */
function stubListen(
  onListen: (server: http.Server) => void
): [unknown, unknown][] {
  const listenArgs: [unknown, unknown][] = [];
  vi.spyOn(http, "createServer").mockImplementationOnce(((
    requestListener: http.RequestListener
  ) => {
    const server = new http.Server(requestListener);
    server.listen = ((...args: unknown[]) => {
      listenArgs.push([args[0], args[1]]);
      const callback = args.find((arg) => typeof arg === "function");
      if (typeof callback === "function") {
        server.once("listening", callback as () => void);
      }
      onListen(server);
      return server;
    }) as typeof server.listen;
    return server;
  }) as typeof http.createServer);
  return listenArgs;
}

function eaccesError(): NodeJS.ErrnoException {
  return Object.assign(new Error("permission denied"), { code: "EACCES" });
}
