import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./deferred.js";
import {
  createMeshHarness,
  disposeMeshHarnesses,
  identityA,
  identityB,
  isInboxGet,
  isPresencePost,
  type MeshRequest,
  meshRepository,
  sessionEvent,
  sourceKeyOf,
} from "./session-mesh-runtime-cov-iss11283-harness.js";

const DISABLED_BODY = JSON.stringify({
  success: false,
  code: "session_mesh_disabled",
});

afterEach(() => {
  vi.useRealTimers();
  disposeMeshHarnesses();
});

function listCommand(agentId = "claude:session-1") {
  return sessionEvent("MeshCommand", "session-1", {
    operation: "list",
    agentId,
  });
}

function unavailable(): Response {
  return new Response("offline", { status: 503 });
}

const ABANDONED = "Session Mesh abandoned an operation after its one attempt:";

const PUBLISH_FORBIDDEN_BODY = JSON.stringify({
  success: false,
  code: "session_mesh_publish_forbidden",
});

function isMessagePost(request: MeshRequest): boolean {
  return request.method === "POST" && request.path === "/session-mesh/messages";
}

function queuedPublish(id: string, authorAgentId: string) {
  return {
    id,
    sourceKey: sourceKeyOf(identityA),
    path: "/session-mesh/messages",
    method: "POST",
    body: { idempotencyKey: id, authorAgentId, kind: "discovery" },
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: null,
    lastError: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("Session Mesh runtime delivery ledger", () => {
  it("abandons a presence the cloud cannot take and sends a fresh one on the next hook", async () => {
    const h = createMeshHarness();
    h.state.respond = (request) =>
      isPresencePost(request) ? unavailable() : undefined;
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    expect(
      h
        .ledger()
        .operations.filter((item) => item.path === "/session-mesh/presence")
    ).toEqual([]);
    expect(h.logs).toContain(
      `${ABANDONED} Error: Session Mesh cloud returned 503`
    );
    h.state.respond = () => undefined;
    h.resolveWorkspace.mockResolvedValueOnce({
      repository: meshRepository,
      revision: "rev-2",
      paths: ["src/later.ts"],
      symbols: [],
    });
    await runtime.handle(sessionEvent("UserPromptSubmit"));
    await runtime.whenIdle();
    const presences = h.requests.filter(isPresencePost);
    expect(presences).toHaveLength(2);
    expect(presences.at(-1)?.body).toMatchObject({
      workspace: { revision: "rev-2" },
    });
    expect(h.ledger().operations).toEqual([]);
  });

  it("refuses new work and reports it when the ledger already holds 2000 operations", async () => {
    const h = createMeshHarness();
    const operations = Array.from({ length: 2000 }, (_, index) => ({
      id: `other-${index}`,
      sourceKey: sourceKeyOf(identityB),
      path: "/session-mesh/messages",
      method: "POST",
      body: {},
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      lastError: null,
      updatedAt: "2026-09-01T00:00:00.000Z",
    }));
    writeFileSync(
      h.ledgerFile,
      JSON.stringify({ version: 1, operations, receipts: {} })
    );
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    expect(h.logs).toContain(
      "Error: Session Mesh delivery queue is full; pending work retained"
    );
    expect(h.requests).toEqual([]);
    const disk = h.ledger().operations;
    expect(disk).toHaveLength(2000);
    expect(disk.every((item) => item.id.startsWith("other-"))).toBe(true);
    expect(await runtime.handle(sessionEvent("UserPromptSubmit"))).toEqual({
      awaitContext: false,
    });
  });

  it("abandons a publish the cloud refuses for an expired author without holding back the work behind it", async () => {
    const h = createMeshHarness();
    writeFileSync(
      h.ledgerFile,
      JSON.stringify({
        version: 1,
        operations: [queuedPublish("expired-author", "claude:ended-subagent")],
        receipts: {},
      })
    );
    h.state.respond = (request) =>
      isMessagePost(request) &&
      request.body?.authorAgentId === "claude:ended-subagent"
        ? new Response(PUBLISH_FORBIDDEN_BODY, { status: 403 })
        : undefined;
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    expect(
      h.count(
        (request) =>
          isMessagePost(request) && request.body?.kind === "work_started"
      )
    ).toBe(1);
    expect(h.ledger().operations).toEqual([]);
    expect(h.logs).toContain(
      `${ABANDONED} Error: Session Mesh cloud returned 403`
    );
  });

  it("abandons only the attempted operation and stops the drain when the cloud is unavailable", async () => {
    const h = createMeshHarness();
    writeFileSync(
      h.ledgerFile,
      JSON.stringify({
        version: 1,
        operations: [
          queuedPublish("first", "claude:session-1"),
          queuedPublish("second", "claude:session-1"),
        ],
        receipts: {},
      })
    );
    h.state.respond = (request) =>
      isMessagePost(request) ? unavailable() : undefined;
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    expect(h.count(isMessagePost)).toBe(1);
    expect(
      h
        .ledger()
        .operations.filter((item) => item.path === "/session-mesh/messages")
        .map((item) => item.id)
    ).toEqual(["second", expect.any(String)]);
  });

  it("stops the drain on a proxy 403 that carries no API code", async () => {
    const h = createMeshHarness();
    writeFileSync(
      h.ledgerFile,
      JSON.stringify({
        version: 1,
        operations: [
          queuedPublish("first", "claude:session-1"),
          queuedPublish("second", "claude:session-1"),
        ],
        receipts: {},
      })
    );
    // An HTML 403 from a proxy in front of the API refuses every queued
    // operation equally. Reading the status alone as an item rejection would
    // send and abandon up to twenty of them against one source-wide refusal.
    h.state.respond = (request) =>
      isMessagePost(request)
        ? new Response("<html><body>403 Forbidden</body></html>", {
            status: 403,
            headers: { "Content-Type": "text/html" },
          })
        : undefined;
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();

    expect(h.count(isMessagePost)).toBe(1);
    expect(
      h
        .ledger()
        .operations.filter((item) => item.path === "/session-mesh/messages")
        .map((item) => item.id)
    ).toEqual(["second", expect.any(String)]);
    expect(h.logs).toContain(
      `${ABANDONED} Error: Session Mesh cloud returned 403`
    );
  });

  it("sends a legacy backoff row once it comes due and clears it", async () => {
    const h = createMeshHarness();
    const due = new Date(h.state.now + 30_000).toISOString();
    writeFileSync(
      h.ledgerFile,
      JSON.stringify({
        version: 1,
        operations: [
          {
            ...queuedPublish("legacy", "claude:session-1"),
            nextAttemptAt: due,
          },
        ],
        receipts: {},
      })
    );
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    expect(
      h.requests.filter(
        (request) =>
          isMessagePost(request) && request.body?.idempotencyKey === "legacy"
      )
    ).toEqual([]);

    // Exactly at the deadline the row is due. Without this case a predicate that
    // regressed to "skip any row with nextAttemptAt set" would leave every row an
    // older build parked in backoff sitting in the ledger forever, counting
    // toward the 2,000-item cap, with the suite still green.
    h.state.now += 30_000;
    await runtime.handle(sessionEvent("UserPromptSubmit"));
    await runtime.whenIdle();

    expect(
      h.requests.filter(
        (request) =>
          isMessagePost(request) && request.body?.idempotencyKey === "legacy"
      )
    ).toHaveLength(1);
    expect(h.ledger().operations.map((item) => item.id)).not.toContain(
      "legacy"
    );
  });

  it("sends new work past twenty operations still waiting out their backoff", async () => {
    const h = createMeshHarness();
    const waiting = Array.from({ length: 20 }, (_, index) => ({
      ...queuedPublish(`waiting-${index}`, "claude:session-1"),
      nextAttemptAt: new Date(h.state.now + 30_000).toISOString(),
    }));
    writeFileSync(
      h.ledgerFile,
      JSON.stringify({ version: 1, operations: waiting, receipts: {} })
    );
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    expect(h.count(isMessagePost)).toBe(1);
    expect(h.requests.find(isMessagePost)?.body?.kind).toBe("work_started");
    expect(h.ledger().operations.map((item) => item.id)).toEqual(
      waiting.map((item) => item.id)
    );
  });
});

describe("Session Mesh runtime cloud requests", () => {
  it("abandons the operation with an identity error when no access token is available", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime({ getAccessToken: () => Promise.resolve(null) });
    await runtime.handle(sessionEvent("Notification"));
    await runtime.whenIdle();
    expect(h.requests).toEqual([]);
    expect(h.ledger().operations).toEqual([]);
    expect(h.logs).toContain(
      `${ABANDONED} Error: Session Mesh identity unavailable`
    );
  });

  it("refuses a response larger than 512 KiB", async () => {
    const h = createMeshHarness();
    h.state.respond = (request) =>
      isPresencePost(request)
        ? new Response("x".repeat(512 * 1024 + 1), { status: 200 })
        : undefined;
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("Notification"));
    await runtime.whenIdle();
    expect(h.ledger().operations).toEqual([]);
    expect(h.logs).toContain(
      `${ABANDONED} Error: Session Mesh response too large`
    );
  });

  it("discards a response that arrives after the identity changed", async () => {
    const h = createMeshHarness();
    h.state.respond = (request) => {
      if (isPresencePost(request)) {
        h.state.identity = identityB;
      }
      return undefined;
    };
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("UserPromptSubmit"));
    await runtime.whenIdle();
    // The follow-up context poll is refused locally, before any fetch.
    expect(h.requests).toHaveLength(1);
    expect(h.count(isPresencePost)).toBe(1);
    expect(h.ledger().operations).toEqual([]);
    expect(h.logs).toContain(
      `${ABANDONED} Error: Session Mesh identity changed`
    );
  });

  it("refuses cloud work, including model commands, after the server disables the account", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    h.state.respond = () => new Response(DISABLED_BODY, { status: 403 });
    await runtime.handle(sessionEvent("UserPromptSubmit"));
    await runtime.whenIdle();
    expect(h.logs).toContain(
      "Error: Session Mesh disabled by server assignment"
    );
    const before = h.requests.length;
    await expect(runtime.handle(listCommand())).rejects.toThrow(
      "Session Mesh disabled by server assignment"
    );
    expect(h.requests).toHaveLength(before);
  });

  it("does not treat a denial body past 8 KiB as an authoritative server flag", async () => {
    const h = createMeshHarness();
    const encoder = new TextEncoder();
    h.state.respond = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(DISABLED_BODY));
            controller.enqueue(encoder.encode(" ".repeat(9000)));
            controller.close();
          },
        }),
        { status: 403 }
      );
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const before = h.requests.length;
    expect(before).toBeGreaterThan(0);
    await runtime.handle(sessionEvent("UserPromptSubmit"));
    await runtime.whenIdle();
    expect(h.requests.length).toBeGreaterThan(before);
  });

  it("does not cache a denial for an account that switched away while the body was read", async () => {
    const h = createMeshHarness();
    const encoder = new TextEncoder();
    let denied = false;
    h.state.respond = (request) => {
      if (denied || !isPresencePost(request)) {
        return undefined;
      }
      denied = true;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              h.state.identity = identityB;
              controller.enqueue(encoder.encode(DISABLED_BODY));
              controller.close();
            },
          },
          { highWaterMark: 0 }
        ),
        { status: 403 }
      );
    };
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    expect(denied).toBe(true);
    h.state.identity = identityA;
    const before = h.count(isInboxGet);
    expect(await runtime.handle(sessionEvent("UserPromptSubmit"))).toEqual({});
    await runtime.whenIdle();
    expect(h.count(isInboxGet)).toBe(before + 1);
  });
});

describe("Session Mesh runtime poll timer", () => {
  it("does nothing when stopped before the first queued tick runs", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    runtime.start();
    expect(h.markerExists()).toBe(true);
    runtime.stop();
    await runtime.whenIdle();
    expect(h.requests).toEqual([]);
    expect(h.markerExists()).toBe(false);
  });

  it("keeps a single interval when start is called twice", async () => {
    vi.useFakeTimers();
    const h = createMeshHarness();
    const runtime = h.runtime();
    runtime.start();
    runtime.start();
    expect(vi.getTimerCount()).toBe(1);
    await runtime.whenIdle();
    runtime.stop();
  });

  it("restarting while the server denial is cached leaves the liveness marker cleared", async () => {
    const h = createMeshHarness();
    h.state.respond = () => new Response(DISABLED_BODY, { status: 403 });
    const runtime = h.runtime();
    runtime.start();
    await runtime.whenIdle();
    expect(h.markerExists()).toBe(false);
    runtime.stop();
    runtime.start();
    expect(h.markerExists()).toBe(false);
    await runtime.whenIdle();
    expect(h.count(() => true)).toBe(1);
  });

  it("drops an interval tick that fires while the previous tick is still in flight", async () => {
    vi.useFakeTimers();
    const h = createMeshHarness();
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const hold = deferred<void>();
    let holding = true;
    h.state.respond = async (request) => {
      if (holding && isPresencePost(request)) {
        holding = false;
        await hold.promise;
      }
      return undefined;
    };
    const before = h.count(isPresencePost);
    runtime.start();
    await vi.advanceTimersByTimeAsync(10_000);
    hold.resolve();
    await runtime.whenIdle();
    await vi.advanceTimersByTimeAsync(0);
    await runtime.whenIdle();
    // The initial tick plus the one interval tick queued behind it.
    expect(h.count(isPresencePost) - before).toBe(2);
    runtime.stop();
  });

  it("does not re-arm the liveness marker when the probe returns after stop", async () => {
    const h = createMeshHarness();
    const hold = deferred<void>();
    const probing = deferred<void>();
    h.state.respond = async () => {
      probing.resolve();
      await hold.promise;
      return undefined;
    };
    const runtime = h.runtime();
    runtime.start();
    await probing.promise;
    runtime.stop();
    expect(h.markerExists()).toBe(false);
    hold.resolve();
    await runtime.whenIdle();
    expect(h.requests).toHaveLength(1);
    expect(h.markerExists()).toBe(false);
  });

  it("clears the live roster when a tick runs signed out", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    expect((await runtime.handle(listCommand())).commandResult).toHaveProperty(
      "agents"
    );
    runtime.start();
    await runtime.whenIdle();
    runtime.stop();
    h.state.identity = null;
    const before = h.requests.length;
    runtime.start();
    await runtime.whenIdle();
    expect(h.requests).toHaveLength(before);
    expect(h.markerExists()).toBe(false);
    h.state.identity = identityA;
    await expect(runtime.handle(listCommand())).rejects.toThrow(
      "locally registered"
    );
  });

  it("drops a session untouched for five minutes instead of refreshing its presence", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const before = h.count(isPresencePost);
    h.state.now += 300_001;
    runtime.start();
    await runtime.whenIdle();
    expect(h.count(isPresencePost)).toBe(before);
    await expect(runtime.handle(listCommand())).rejects.toThrow(
      "locally registered"
    );
  });

  it("still refreshes a session touched exactly five minutes ago", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const before = h.count(isPresencePost);
    h.state.now += 300_000;
    runtime.start();
    await runtime.whenIdle();
    expect(h.count(isPresencePost)).toBe(before + 1);
  });

  it("drops a live session registered under another account on the next tick", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const before = h.count(isPresencePost);
    h.state.identity = identityB;
    runtime.start();
    await runtime.whenIdle();
    expect(h.count(isPresencePost)).toBe(before);
    h.state.identity = identityA;
    await expect(runtime.handle(listCommand())).rejects.toThrow(
      "locally registered"
    );
  });
});
