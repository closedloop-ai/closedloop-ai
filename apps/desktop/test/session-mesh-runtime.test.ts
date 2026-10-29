import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentHookListener } from "../src/main/agent-monitor/agent-monitor-listener.js";
import { installSessionMeshCommandPack } from "../src/main/session-mesh/session-mesh-command-pack.js";
import { supportsSessionMeshAsyncHooks } from "../src/main/session-mesh/session-mesh-harness-support.js";
import { installSessionMeshHooks } from "../src/main/session-mesh/session-mesh-hook-installer-core.js";
import { sessionMeshLocalToken } from "../src/main/session-mesh/session-mesh-local-auth.js";
import {
  SessionMeshRuntime,
  type SessionMeshRuntimeOptions,
} from "../src/main/session-mesh/session-mesh-runtime.js";

const messageId = "9e4c0a84-0176-4cfa-a45a-53d071bd552d";
const token = "a".repeat(64);
const workspace = {
  repository: "github.com/org/repo",
  revision: "abc123",
  paths: ["src/a.ts"],
  symbols: [],
};
const event = {
  harness: "claude" as const,
  hookType: "SessionStart",
  localToken: token,
  data: { session_id: "session-123", cwd: "/repo" },
};

function invokeHandler(
  handler: string,
  hookType: string,
  harness: string,
  port: string,
  data: unknown,
  asyncNative = false
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [handler, hookType, harness, ...(asyncNative ? ["async"] : [])],
      {
        env: { ...process.env, CLAUDE_DASHBOARD_PORT: port },
      }
    );
    let stdout = "";
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`hook exited ${code}: ${stdout}`))
    );
    child.stdin.end(JSON.stringify(data));
  });
}

function fixture(
  directory = mkdtempSync(path.join(os.tmpdir(), "mesh-runtime-"))
) {
  const requests: Array<{
    path: string;
    query: string;
    body: Record<string, unknown> | null;
    authorization: string | null;
    method?: string;
  }> = [];
  let offline = false;
  let emptyInbox = false;
  let identity: {
    userId: string;
    organizationId: string;
    computeTargetId: string;
  } | null = {
    userId: "user-a",
    organizationId: "org-a",
    computeTargetId: "desktop-a",
  };
  const options: SessionMeshRuntimeOptions = {
    directory,
    localToken: token,
    getIdentity: () => identity,
    getAccessToken: async () => "access-token",
    getApiOrigin: () => "https://api.example.test",
    invalidateAccessToken: () => undefined,
    resolveWorkspace: async () => workspace,
    log: () => undefined,
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({
        path: url.pathname,
        query: url.search,
        method: init?.method,
        body,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      if (offline && url.pathname.endsWith("/messages")) {
        throw new Error("offline");
      }
      let data: unknown = {
        updated: 1,
        removed: 1,
        presence: { agentId: "claude:session-123" },
      };
      if (url.pathname === "/session-mesh/inbox") {
        data = {
          messages: emptyInbox
            ? []
            : [
                {
                  id: "delivery-id",
                  messageId,
                  recipientAgentId: "claude:session-123",
                  status: "queued",
                  relevance: {},
                  queuedAt: new Date().toISOString(),
                  deliveredAt: null,
                  acknowledgedAt: null,
                  failureReason: null,
                  message: {
                    id: messageId,
                    summary: "Peer already owns src/a.ts",
                    kind: "claim",
                    authorAgentId: "codex:canonical-peer-id",
                    repository: workspace.repository,
                    revision: workspace.revision,
                    paths: [],
                    symbols: [],
                    context: {},
                    sensitivity: "normal",
                    replyToMessageId: null,
                  },
                },
              ],
        };
      } else if (
        url.pathname === "/session-mesh/messages" &&
        init?.method === "GET"
      ) {
        data = {
          message: { id: messageId, summary: "full delivered context" },
        };
      } else if (init?.method === "GET") {
        data = {
          agents: [
            {
              agentId: "codex:canonical-peer-id",
              repository: workspace.repository,
              revision: workspace.revision,
              dirtyStateHash: null,
              configurationHash: null,
              harness: "codex",
              capabilities: [],
              lineage: {},
              context: {},
              paths: [],
              symbols: [],
              user: { id: "peer-user", firstName: null, lastName: null },
              expiresAt: new Date().toISOString(),
            },
          ],
        };
      } else if (url.pathname.endsWith("/messages")) {
        data = { message: { id: messageId }, idempotent: false };
      } else if (url.pathname.endsWith("/feedback")) {
        data = { event: { id: messageId } };
      }
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data }), {
          status: 200,
        })
      );
    },
  };
  return {
    options,
    requests,
    offline: () => {
      offline = true;
    },
    emptyInbox: () => {
      emptyInbox = true;
    },
    identity: (next: typeof identity) => {
      identity = next;
    },
  };
}

describe("Session Mesh native runtime", () => {
  it("publishes captured branch lineage and discloses the roster continuation", async () => {
    const f = fixture();
    f.options.resolveWorkspace = () =>
      Promise.resolve({ ...workspace, branch: "feature/mesh" });
    const cloud = f.options.fetch;
    if (!cloud) {
      throw new Error("fixture transport unavailable");
    }
    f.options.fetch = async (input, init) => {
      const response = await cloud(input, init);
      if (init?.method !== "GET" || !String(input).includes("/presence")) {
        return response;
      }
      const body = await response.json();
      return Response.json({
        ...body,
        data: { ...body.data, nextCursor: "codex:next-page" },
      });
    };
    const runtime = new SessionMeshRuntime(f.options);
    await runtime.handle(event);
    await runtime.whenIdle();
    for (const endpoint of [
      "/session-mesh/presence",
      "/session-mesh/messages",
    ]) {
      expect(
        f.requests.find(
          (request) => request.path === endpoint && request.method === "POST"
        )?.body
      ).toMatchObject({
        lineage: { sessionId: "session-123", branch: "feature/mesh" },
      });
    }
    const context = await runtime.handle({
      ...event,
      hookType: "AwaitContext",
    });
    expect(context.additionalContext).toContain(
      "this is not a complete roster"
    );
    expect(context.additionalContext).toContain('cursor:"codex:next-page"');
    expect(context.additionalContext).toContain(
      `repository:"${workspace.repository}"`
    );
    const page = await runtime.handle({
      ...event,
      hookType: "MeshCommand",
      data: {
        operation: "list",
        agentId: "claude:session-123",
        payload: {
          cursor: "codex:next-page",
          repository: workspace.repository,
        },
      },
    });
    expect(page.commandResult).toHaveProperty("nextCursor", "codex:next-page");
    expect(new URLSearchParams(f.requests.at(-1)?.query).get("cursor")).toBe(
      "codex:next-page"
    );
    expect(
      new URLSearchParams(f.requests.at(-1)?.query).get("repository")
    ).toBe(workspace.repository);
    runtime.stop();
  });

  it("caches the exact server flag denial, skips hooks and polling, and recovers off-turn", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const cloud = f.options.fetch;
    if (!cloud) {
      throw new Error("fixture transport unavailable");
    }
    let enabled = false;
    let calls = 0;
    f.options.fetch = (input, init) => {
      calls += 1;
      return enabled
        ? cloud(input, init)
        : Promise.resolve(
            new Response(
              JSON.stringify({ success: false, code: "session_mesh_disabled" }),
              { status: 403 }
            )
          );
    };
    const runtime = new SessionMeshRuntime(f.options);
    const marker = path.join(f.options.directory, "active-runtime");
    try {
      runtime.start();
      await runtime.whenIdle();
      expect(calls).toBe(1);
      expect(existsSync(marker)).toBe(false);
      expect(await runtime.handle(event)).toEqual({ awaitContext: false });
      expect(
        await runtime.handle({ ...event, hookType: "AwaitContext" })
      ).toEqual({ awaitContext: false });
      await vi.advanceTimersByTimeAsync(55_000);
      await runtime.whenIdle();
      expect(calls).toBe(1);
      enabled = true;
      await vi.advanceTimersByTimeAsync(5000);
      await runtime.whenIdle();
      expect(calls).toBe(2);
      expect(existsSync(marker)).toBe(true);
      await runtime.handle(event);
      await runtime.whenIdle();
      expect(
        f.requests.some((request) => request.path.endsWith("/inbox"))
      ).toBe(true);
    } finally {
      runtime.stop();
      vi.useRealTimers();
    }
  });

  it("unknown cloud errors settle cold waiters without fabricating a disabled flag", async () => {
    const f = fixture();
    f.options.fetch = () =>
      Promise.resolve(new Response("older server error", { status: 403 }));
    const runtime = new SessionMeshRuntime(f.options);
    runtime.start();
    try {
      await runtime.whenIdle();
      expect(existsSync(path.join(f.options.directory, "active-runtime"))).toBe(
        true
      );
      await runtime.handle(event);
      const context = runtime.handle({ ...event, hookType: "AwaitContext" });
      await runtime.whenIdle();
      expect(await context).toEqual({ awaitContext: false });
      expect(existsSync(path.join(f.options.directory, "active-runtime"))).toBe(
        true
      );
    } finally {
      runtime.stop();
    }
  });

  it("settles an unchanged no-message poll instead of holding the async hook open", async () => {
    const f = fixture();
    const cloud = f.options.fetch;
    if (!cloud) {
      throw new Error("fixture transport unavailable");
    }
    f.emptyInbox();
    f.options.fetch = (input, init) =>
      init?.method === "GET" && String(input).includes("/presence")
        ? Promise.resolve(
            Response.json({ success: true, data: { agents: [] } })
          )
        : cloud(input, init);
    const runtime = new SessionMeshRuntime(f.options);
    await runtime.handle(event);
    await runtime.whenIdle();
    expect(
      (await runtime.handle({ ...event, hookType: "AwaitContext" }))
        .additionalContext
    ).toContain("Live peers: none");
    await runtime.handle({ ...event, hookType: "UserPromptSubmit" });
    const waiting = runtime.handle({ ...event, hookType: "AwaitContext" });
    await runtime.whenIdle();
    expect(await waiting).toEqual({ awaitContext: false });
    runtime.stop();
  });

  it("persists coalesced measured reports and abandons one the cloud cannot take", async () => {
    const f = fixture();
    let now = 1000;
    let monotonic = 0;
    f.options.now = () => now;
    f.options.monotonicNow = () => monotonic;
    f.options.resolveWorkspace = () => {
      monotonic += 25;
      return Promise.resolve(workspace);
    };
    const runtime = new SessionMeshRuntime(f.options);
    await runtime.handle(event);
    await runtime.whenIdle();
    expect(
      f.requests.some((request) => request.path.endsWith("/feedback"))
    ).toBe(false);
    now += 60_000;
    await runtime.handle({ ...event, hookType: "UserPromptSubmit" });
    await runtime.whenIdle();
    const ledger = JSON.parse(
      readFileSync(
        path.join(f.options.directory, "delivery-ledger.json"),
        "utf8"
      )
    );
    const report = ledger.operations.find((item: { path: string }) =>
      item.path.endsWith("/feedback")
    );
    expect(report.body).toMatchObject({
      coordinationOverheadMs: 50,
      agentId: "claude:session-123",
      kind: "coordination_overhead",
    });
    const cloud = f.options.fetch;
    if (!cloud) {
      throw new Error("fixture transport unavailable");
    }
    let rejectFeedback = true;
    f.options.fetch = async (input, init) => {
      const response = await cloud(input, init);
      if (String(input).endsWith("/feedback") && rejectFeedback) {
        rejectFeedback = false;
        return new Response("offline", { status: 503 });
      }
      return response;
    };
    await runtime.handle({ ...event, hookType: "UserPromptSubmit" });
    await runtime.whenIdle();
    runtime.stop();
    now += 31_000;
    const restarted = new SessionMeshRuntime(f.options);
    restarted.start();
    await restarted.whenIdle();
    restarted.stop();
    expect(
      f.requests
        .filter((request) => request.path.endsWith("/feedback"))
        .map((request) => request.body)
    ).toEqual([report.body]);
    const replayed = JSON.parse(
      readFileSync(
        path.join(f.options.directory, "delivery-ledger.json"),
        "utf8"
      )
    );
    expect(replayed.operations).toEqual([]);
  });

  it("only installs native async hooks for verified supported versions", () => {
    expect(supportsSessionMeshAsyncHooks("codex", "codex-cli 0.156.1")).toBe(
      true
    );
    expect(
      supportsSessionMeshAsyncHooks("claude", "2.1.267 (Claude Code)")
    ).toBe(true);
    expect(supportsSessionMeshAsyncHooks("codex", "codex-cli 0.100.0")).toBe(
      false
    );
    expect(supportsSessionMeshAsyncHooks("claude", "unknown")).toBe(false);
  });
  it("native hook fails open when the local listener stalls", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "mesh-outage-"));
    const handler = path.join(directory, "hook.cjs");
    copyFileSync(
      path.resolve("resources/hooks/session-mesh-hook-handler.js"),
      handler
    );
    writeFileSync(path.join(directory, "local-token"), token);
    const server = http.createServer(() => undefined);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    try {
      const result = await new Promise<{ code: number | null; stdout: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [handler, "SessionStart", "codex"],
            {
              env: {
                ...process.env,
                CLAUDE_DASHBOARD_PORT: String(
                  (server.address() as AddressInfo).port
                ),
              },
            }
          );
          let stdout = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout }));
          child.stdin.end(JSON.stringify(event.data));
        }
      );
      expect(result).toEqual({ code: 0, stdout: "" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("returns without awaiting stalled cloud or workspace inspection", async () => {
    const test = fixture();
    let release: ((value: typeof workspace) => void) | undefined;
    test.options.resolveWorkspace = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const runtime = new SessionMeshRuntime(test.options);
    expect(await runtime.handle(event)).toEqual({});
    // This completes while workspace inspection is still explicitly suspended.
    expect(release).toBeTypeOf("function");
    expect(test.requests).toEqual([]);
    release?.(workspace);
    await runtime.whenIdle();
    expect((await runtime.handle(event)).additionalContext).toContain(
      "Peer already owns"
    );
    release?.(workspace);
  });
  it("registers authoritative identity, exposes roster and context, and only acknowledges after stdout receipt", async () => {
    const test = fixture();
    const runtime = new SessionMeshRuntime(test.options);
    await runtime.handle(event);
    await runtime.whenIdle();
    const output = await runtime.handle(event);
    expect(output.additionalContext).toContain("codex:canonical-peer-id");
    expect(output.additionalContext).toContain("Peer already owns src/a.ts");
    expect(test.requests[0]?.body).toMatchObject({
      agentId: "claude:session-123",
      lineage: { sessionId: "session-123" },
    });
    expect(
      test.requests.every(
        (request) => request.authorization === "Bearer access-token"
      )
    ).toBe(true);
    expect(
      test.requests.some((request) => request.path.endsWith("/disposition"))
    ).toBe(false);
    await runtime.handle({
      ...event,
      hookType: "ContextDelivered",
      data: { receipt: output.receipt },
    });
    await runtime.whenIdle();
    expect(
      test.requests.find((request) => request.path.endsWith("/disposition"))
        ?.body
    ).toMatchObject({
      agentId: "claude:session-123",
      messageId,
      status: "delivered",
    });
  });

  it("preserves a corrupt ledger for inspection and recovers without crashing hooks", async () => {
    const test = fixture();
    writeFileSync(
      path.join(test.options.directory, "delivery-ledger.json"),
      "{broken"
    );
    const warnings: string[] = [];
    test.options.log = (message) => warnings.push(message);
    const runtime = new SessionMeshRuntime(test.options);
    expect(warnings[0]).toContain("invalid delivery ledger preserved");
    expect(
      readdirSync(test.options.directory).some((file) =>
        file.includes(".corrupt-")
      )
    ).toBe(true);
    expect(await runtime.handle(event)).toEqual({});
    await runtime.whenIdle();
  });

  it("routes explicit model commands with local session ownership and fire-and-forget publication", async () => {
    const test = fixture();
    const runtime = new SessionMeshRuntime(test.options);
    await runtime.handle(event);
    await runtime.whenIdle();
    const command = (
      operation: string,
      payload: Record<string, unknown> = {}
    ) =>
      runtime.handle({
        ...event,
        hookType: "MeshCommand",
        data: { operation, agentId: "claude:session-123", payload },
      });
    expect((await command("list")).commandResult).toHaveProperty("agents");
    expect((await command("fetch")).commandResult).toHaveProperty("messages");
    expect((await command("fetch", { messageId })).commandResult).toMatchObject(
      { message: { id: messageId, summary: "full delivered context" } }
    );
    expect(test.requests.at(-1)?.query).toContain(`messageId=${messageId}`);
    expect(
      (
        await command("reply", {
          replyToMessageId: messageId,
          recipientAgentIds: ["codex:canonical-peer-id"],
          summary: "I will avoid the conflicting file",
          idempotencyKey: "reply-key",
        })
      ).commandResult
    ).toMatchObject({ accepted: true, queued: false });
    await command("ack", { messageId });
    expect(test.requests.at(-1)?.body).toMatchObject({
      agentId: "claude:session-123",
      status: "acknowledged",
    });
    await command("hold", { messageId });
    expect(test.requests.at(-1)?.body).toMatchObject({ status: "held" });
    await command("refuse", { messageId, reason: "outside my task" });
    expect(test.requests.at(-1)?.body).toMatchObject({ status: "refused" });
    await command("subscribe");
    expect(test.requests.at(-1)?.body).toMatchObject({ muted: false });
    await command("unsubscribe");
    expect(test.requests.at(-1)?.body).toMatchObject({ muted: true });
    await command("context");
    expect(test.requests.at(-1)?.path).toBe("/session-mesh/related");
    await command("mute", { muted: true });
    expect(test.requests.at(-1)?.body).toMatchObject({
      repository: workspace.repository,
      muted: true,
    });
    await expect(
      runtime.handle({
        ...event,
        hookType: "MeshCommand",
        data: { operation: "list", agentId: "claude:some-other-session" },
      })
    ).rejects.toThrow("locally registered");
    test.offline();
    expect(
      (
        await command("publish", {
          kind: "discovery",
          summary: "bounded analysis",
          idempotencyKey: "offline-publication",
        })
      ).commandResult
    ).toMatchObject({
      queued: false,
      accepted: false,
      idempotencyKey: "offline-publication",
    });
  });

  it("installs a discoverable command pack without overwriting user-owned skills", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "mesh-command-pack-"));
    const input = {
      skillsDirectory: directory,
      execPath: process.execPath,
      handler: "/desktop/session-mesh-hook-handler.js",
      harness: "codex" as const,
    };
    installSessionMeshCommandPack(input);
    const file = path.join(directory, "closedloop-session-mesh", "SKILL.md");
    const content = readFileSync(file, "utf8");
    installSessionMeshCommandPack(input);
    expect(readFileSync(file, "utf8")).toBe(content);
    writeFileSync(file, "user content");
    expect(() => installSessionMeshCommandPack(input)).toThrow("user-owned");
    expect(readFileSync(file, "utf8")).toBe("user content");
  });

  it("expires cached context and cannot repopulate after stop", async () => {
    const test = fixture();
    let now = 1000;
    test.options.now = () => now;
    const runtime = new SessionMeshRuntime(test.options);
    await runtime.handle(event);
    await runtime.whenIdle();
    now += 60_001;
    expect(await runtime.handle(event)).toEqual({});
    runtime.stop();
    await runtime.whenIdle();
    expect(await runtime.handle(event)).toEqual({ awaitContext: false });
  });

  it("retains edit interests across later prompts and resolves all Codex patch paths", async () => {
    const test = fixture();
    test.options.resolveWorkspace = async (_cwd, file, files) => ({
      ...workspace,
      paths: files ?? (file ? [file] : []),
    });
    const runtime = new SessionMeshRuntime(test.options);
    await runtime.handle({
      ...event,
      harness: "codex",
      hookType: "PreToolUse",
      data: {
        ...event.data,
        tool_name: "apply_patch",
        tool_input: {
          command:
            "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch",
        },
      },
    });
    await runtime.whenIdle();
    await runtime.handle({
      ...event,
      harness: "codex",
      hookType: "UserPromptSubmit",
    });
    await runtime.whenIdle();
    const presences = test.requests.filter(
      (request) => request.path.endsWith("/presence") && request.body
    );
    expect(presences.at(-1)?.body).toMatchObject({
      workspace: { paths: ["src/a.ts", "src/b.ts"] },
    });
    expect(
      test.requests.find((request) => request.body?.kind === "claim")?.body
    ).toMatchObject({ workspace: { paths: ["src/a.ts", "src/b.ts"] } });
  });

  it("refuses unauthenticated local hooks and never routes a prior account's receipt", async () => {
    const test = fixture();
    const runtime = new SessionMeshRuntime(test.options);
    await expect(
      runtime.handle({ ...event, localToken: "bad" })
    ).rejects.toThrow("Unauthorized");
    expect(test.requests).toEqual([]);
    await runtime.handle(event);
    await runtime.whenIdle();
    const output = await runtime.handle(event);
    test.identity({
      userId: "user-b",
      organizationId: "org-b",
      computeTargetId: "desktop-b",
    });
    await runtime.handle({
      ...event,
      hookType: "ContextDelivered",
      data: { receipt: output.receipt },
    });
    await runtime.whenIdle();
    expect(
      test.requests.some((request) => request.path.endsWith("/disposition"))
    ).toBe(false);
  });

  it("polls live sessions every five seconds and unregisters ended sessions", async () => {
    vi.useFakeTimers();
    const test = fixture();
    const runtime = new SessionMeshRuntime(test.options);
    try {
      runtime.start();
      await runtime.handle(event);
      await runtime.whenIdle();
      const before = test.requests.filter((request) =>
        request.path.endsWith("/inbox")
      ).length;
      await vi.advanceTimersByTimeAsync(5000);
      await runtime.whenIdle();
      expect(
        test.requests.filter((request) => request.path.endsWith("/inbox"))
      ).toHaveLength(before + 1);
      await runtime.handle({ ...event, hookType: "SessionEnd" });
      await runtime.whenIdle();
      expect(
        test.requests.find((request) => request.method === "DELETE")?.body
      ).toEqual({ agentId: "claude:session-123" });
      const endedCount = test.requests.length;
      await vi.advanceTimersByTimeAsync(5000);
      await runtime.whenIdle();
      expect(test.requests).toHaveLength(endedCount);
    } finally {
      runtime.stop();
      vi.useRealTimers();
    }
  });

  it("does not overwrite undelivered roster context with an unchanged empty poll", async () => {
    vi.useFakeTimers();
    const test = fixture();
    test.emptyInbox();
    const runtime = new SessionMeshRuntime(test.options);
    try {
      runtime.start();
      await runtime.handle(event);
      await runtime.whenIdle();
      await vi.advanceTimersByTimeAsync(5000);
      await runtime.whenIdle();
      expect((await runtime.handle(event)).additionalContext).toContain(
        "claude:session-123"
      );
    } finally {
      runtime.stop();
      vi.useRealTimers();
    }
  });

  it("abandons a failed publication instead of resending it after restart", async () => {
    const test = fixture();
    test.offline();
    const offlineRuntime = new SessionMeshRuntime(test.options);
    await offlineRuntime.handle(event);
    await offlineRuntime.whenIdle();
    expect(
      test.requests.some((request) => request.path.endsWith("/messages"))
    ).toBe(true);
    const ledgerFile = path.join(
      test.options.directory,
      "delivery-ledger.json"
    );
    const queuedMessages = () =>
      JSON.parse(readFileSync(ledgerFile, "utf8")).operations.filter(
        (item: { path: string }) => item.path === "/session-mesh/messages"
      );
    expect(queuedMessages()).toEqual([]);
    const recovered = fixture(test.options.directory);
    recovered.options.now = () => Date.now() + 60_000;
    const onlineRuntime = new SessionMeshRuntime(recovered.options);
    await onlineRuntime.handle({
      ...event,
      hookType: "UserPromptSubmit",
    });
    await onlineRuntime.whenIdle();
    expect(
      recovered.requests.some((request) => request.path.endsWith("/messages"))
    ).toBe(false);
  });

  for (const harness of ["claude", "codex"] as const) {
    it(`${harness} cold async SessionStart delivers freshly fetched context without an edit or another turn`, async () => {
      const test = fixture();
      const runtime = new SessionMeshRuntime(test.options);
      const listener = new AgentHookListener({
        lifecycle: { processEvent: () => true },
        port: 0,
        onSessionMeshHookEvent: (input) => runtime.handle(input),
      });
      await listener.start();
      const handler = path.join(
        test.options.directory,
        "session-mesh-hook-handler.cjs"
      );
      copyFileSync(
        path.resolve("resources/hooks/session-mesh-hook-handler.js"),
        handler
      );
      writeFileSync(path.join(test.options.directory, "local-token"), token);
      try {
        const stdout = await invokeHandler(
          handler,
          "SessionStart",
          harness,
          new URL(listener.getUrl() ?? "").port,
          event.data,
          true
        );
        expect(
          JSON.parse(stdout).hookSpecificOutput.additionalContext
        ).toContain("Peer already owns src/a.ts");
        await runtime.whenIdle();
        expect(
          test.requests.find((request) => request.path.endsWith("/disposition"))
            ?.body
        ).toMatchObject({ status: "delivered" });
      } finally {
        runtime.stop();
        await listener.stop();
      }
    });

    it(`${harness} handler crosses actual loopback listener and prints model-visible context before ack`, async () => {
      const test = fixture();
      const runtime = new SessionMeshRuntime(test.options);
      await runtime.handle({ ...event, harness });
      await runtime.whenIdle();
      const listener = new AgentHookListener({
        lifecycle: { processEvent: () => true },
        port: 0,
        onSessionMeshHookEvent: (input) => runtime.handle(input),
      });
      await listener.start();
      const handler = path.join(
        test.options.directory,
        "session-mesh-hook-handler.cjs"
      );
      copyFileSync(
        path.resolve("resources/hooks/session-mesh-hook-handler.js"),
        handler
      );
      writeFileSync(path.join(test.options.directory, "local-token"), token);
      try {
        const port = new URL(listener.getUrl() ?? "").port;
        const stdout = await invokeHandler(
          handler,
          "SessionStart",
          harness,
          port,
          event.data
        );
        expect(
          JSON.parse(stdout).hookSpecificOutput.additionalContext
        ).toContain("Peer already owns src/a.ts");
        await runtime.whenIdle();
        expect(
          test.requests.find((request) => request.path.endsWith("/disposition"))
            ?.body
        ).toMatchObject({
          agentId: `${harness}:session-123`,
          messageId,
          status: "delivered",
        });
        const command = await invokeHandler(
          handler,
          "MeshCommand",
          harness,
          port,
          { operation: "list", agentId: `${harness}:session-123` }
        );
        expect(JSON.parse(command).commandResult.agents[0].agentId).toBe(
          "codex:canonical-peer-id"
        );
        expect(
          JSON.parse(
            await invokeHandler(handler, "Stop", harness, port, event.data)
          )
        ).toEqual({});
        await runtime.whenIdle();
      } finally {
        await listener.stop();
      }
    });
  }

  it("installs both native harness configs idempotently without replacing unrelated hooks", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "mesh-install-"));
    const claude = path.join(directory, "settings.json");
    const codex = path.join(directory, "config.toml");
    writeFileSync(
      claude,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "existing-hook" }] },
          ],
        },
      })
    );
    const options = {
      file: claude,
      execPath: "/Electron",
      handler: "/userdata/session-mesh-hook-handler.js",
      codexConfigFile: codex,
      receiverState: null,
      nativeAsyncSupport: { claude: true, codex: true },
    };
    installSessionMeshHooks(options);
    installSessionMeshHooks(options);
    expect(
      JSON.parse(readFileSync(claude, "utf8")).hooks.SessionStart
    ).toHaveLength(2);
    expect(
      JSON.parse(readFileSync(claude, "utf8")).hooks.PreToolUse[0].hooks[0]
        .async
    ).toBe(true);
    const hooks = JSON.parse(readFileSync(claude, "utf8")).hooks;
    expect(hooks.PostToolUse).toBeUndefined();
    const matcher = new RegExp(hooks.PreToolUse[0].matcher);
    expect(matcher.test("Edit")).toBe(true);
    expect(matcher.test("Read")).toBe(false);
    expect(matcher.test("Bash")).toBe(false);
    expect(
      JSON.parse(readFileSync(path.join(directory, "hooks.json"), "utf8")).hooks
        .UserPromptSubmit[0].hooks[0].async
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(directory, "hooks.json"), "utf8")).hooks
        .SessionStart
    ).toHaveLength(1);
    expect(sessionMeshLocalToken(directory)).toBe(
      sessionMeshLocalToken(directory)
    );
    installSessionMeshHooks({
      ...options,
      nativeAsyncSupport: { claude: false, codex: false },
    });
    expect(
      JSON.parse(readFileSync(claude, "utf8")).hooks.SessionStart
    ).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(path.join(directory, "hooks.json"), "utf8")).hooks
    ).toBeUndefined();
  });
});
