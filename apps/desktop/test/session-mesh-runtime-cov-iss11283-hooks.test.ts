import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMeshHarness,
  disposeMeshHarnesses,
  identityA,
  identityB,
  isInboxGet,
  isPresencePost,
  meshCwd,
  meshDelivery,
  meshEvent,
  sessionEvent,
  sourceKeyOf,
  valueAfterOneMacrotask,
} from "./session-mesh-runtime-cov-iss11283-harness.js";

const messageA = "0b9f5a52-7a4c-4b3e-9d61-1f7c2d0c9a01";
const messageB = "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const longSummary = "x".repeat(700);

afterEach(() => {
  vi.useRealTimers();
  disposeMeshHarnesses();
});

describe("Session Mesh runtime hook event parsing", () => {
  it("ignores a hook whose session id is not a string without touching the workspace or cloud", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    const numericSession = meshEvent("SessionStart", {
      session_id: 42,
      cwd: meshCwd,
    });
    expect(await runtime.handle(numericSession)).toEqual({});
    await runtime.whenIdle();
    expect(await runtime.handle(numericSession)).toEqual({});
    await runtime.whenIdle();
    expect(h.resolveWorkspace).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it("settles AwaitContext at once when the event carries no session id", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    expect(
      await valueAfterOneMacrotask(
        runtime.handle(meshEvent("AwaitContext", {}))
      )
    ).toEqual({});
  });

  it("keys a subagent by its provider agent_id and announces work_started", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    await runtime.handle(
      sessionEvent("SubagentStart", "session-1", { agent_id: "sub-7" })
    );
    await runtime.whenIdle();
    const presence = h.requests.find(isPresencePost);
    expect(presence?.body).toMatchObject({
      agentId: "claude:sub-7",
      lineage: { sessionId: "session-1" },
    });
    const message = h.requests.find(
      (request) => request.path === "/session-mesh/messages"
    );
    expect(message?.body).toMatchObject({
      authorAgentId: "claude:sub-7",
      kind: "work_started",
      summary: "claude:sub-7 started",
    });
    expect(h.requests.find(isInboxGet)?.query.get("agentId")).toBe(
      "claude:sub-7"
    );
  });

  it("publishes a claim for the file_path of a Claude Edit", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "Edit",
        tool_use_id: "tool-1",
        tool_input: { file_path: "src/edited.ts" },
      })
    );
    await runtime.whenIdle();
    expect(h.resolveWorkspace).toHaveBeenCalledWith(meshCwd, "src/edited.ts", [
      "src/edited.ts",
    ]);
    expect(
      h.requests.find((request) => request.path === "/session-mesh/messages")
        ?.body
    ).toMatchObject({ kind: "claim", summary: "Editing src/edited.ts" });
    expect(h.count(isInboxGet)).toBe(1);
  });

  it("polls context after a PostToolUse hook", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("PostToolUse"));
    await runtime.whenIdle();
    expect(h.count(isInboxGet)).toBe(1);
    expect(
      (await runtime.handle(sessionEvent("AwaitContext"))).additionalContext
    ).toContain("Your canonical Mesh ID: claude:session-1.");
  });

  it("falls through a non-string file_path to the patch text in input", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "apply_patch",
        tool_input: {
          file_path: 7,
          input:
            "*** Begin Patch\n*** Update File: src/patched.ts\n*** End Patch",
        },
      })
    );
    await runtime.whenIdle();
    expect(h.resolveWorkspace).toHaveBeenCalledWith(meshCwd, "src/patched.ts", [
      "src/patched.ts",
    ]);
  });

  it("reads patch paths from a bare string tool_input and prefers command over input", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_use_id: "tool-string",
        tool_input: "*** Add File: src/from-string.ts\n",
      })
    );
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_use_id: "tool-command",
        tool_input: {
          input: "*** Add File: src/from-input.ts\n",
          command: "*** Delete File: src/from-command.ts\n",
        },
      })
    );
    await runtime.whenIdle();
    expect(h.resolveWorkspace.mock.calls).toEqual([
      [meshCwd, "src/from-string.ts", ["src/from-string.ts"]],
      [meshCwd, "src/from-command.ts", ["src/from-command.ts"]],
    ]);
    expect(h.logs).toEqual([]);
  });

  it("keeps at most 200 patch paths", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    const patch = Array.from(
      { length: 201 },
      (_, index) => `*** Add File: src/f${index}.ts`
    ).join("\n");
    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", { tool_input: patch })
    );
    await runtime.whenIdle();
    const files = h.resolveWorkspace.mock.calls[0]?.[2] ?? [];
    expect(files).toHaveLength(200);
    expect(files.at(-1)).toBe("src/f199.ts");
  });

  it("coalesces a duplicate queued event to the latest payload", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    const first = runtime.handle(sessionEvent("UserPromptSubmit"));
    const second = runtime.handle(
      meshEvent("UserPromptSubmit", { session_id: "session-1", cwd: "/repo-2" })
    );
    expect(await first).toEqual({});
    expect(await second).toEqual({});
    await runtime.whenIdle();
    expect(h.resolveWorkspace).toHaveBeenCalledTimes(1);
    expect(h.resolveWorkspace).toHaveBeenCalledWith("/repo-2", undefined, []);
  });

  it("keeps events with different file sets distinct even when their paths concatenate alike", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    const single = runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_input: { file_path: "ab" },
      })
    );
    const pair = runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_input: "*** Add File: a\n*** Add File: b\n",
      })
    );
    expect(await Promise.all([single, pair])).toEqual([{}, {}]);
    await runtime.whenIdle();
    expect(h.resolveWorkspace).toHaveBeenCalledTimes(2);
  });

  it("drops a queued event that a stop-then-start cleared before it ran", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    const queued = runtime.handle(sessionEvent("SessionStart"));
    runtime.stop();
    runtime.start();
    expect(await queued).toEqual({});
    await runtime.whenIdle();
    expect(h.resolveWorkspace).not.toHaveBeenCalled();
    expect(h.logs).toEqual([]);
  });

  it("registers presence for an unlisted hook type without polling context", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("Notification"));
    await runtime.whenIdle();
    expect(h.count(isPresencePost)).toBe(1);
    expect(h.count(isInboxGet)).toBe(0);
    expect(await runtime.handle(sessionEvent("Notification"))).toEqual({
      awaitContext: false,
    });
    expect(h.logs).toEqual([]);
  });

  it("publishes an empty-await result without resolving the workspace when cwd is missing", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    const bare = meshEvent("SessionStart", { session_id: "session-1" });
    expect(await runtime.handle(bare)).toEqual({});
    await runtime.whenIdle();
    expect(h.resolveWorkspace).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
    expect(await runtime.handle(bare)).toEqual({ awaitContext: false });
    await runtime.handle(
      meshEvent("SessionStart", { session_id: "session-2", cwd: 42 })
    );
    await runtime.whenIdle();
    expect(h.resolveWorkspace).not.toHaveBeenCalled();
  });

  it("skips the workspace when the identity signs out between the queue check and the serial handler", async () => {
    const h = createMeshHarness();
    let identityReads = 0;
    const runtime = h.runtime({
      getIdentity: () => {
        identityReads += 1;
        // Read 1: handle(). Read 2: the queued run's source check.
        // Read 3: handleSerial's own source key.
        return identityReads === 3 ? null : identityA;
      },
    });
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    expect(identityReads).toBeGreaterThanOrEqual(4);
    expect(h.resolveWorkspace).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
    expect(await runtime.handle(sessionEvent("UserPromptSubmit"))).toEqual({
      awaitContext: false,
    });
  });

  it("publishes nothing for the old account when a failure lands after the identity changed", async () => {
    const h = createMeshHarness();
    const runtime = h.runtime();
    h.resolveWorkspace.mockImplementationOnce(() => {
      h.state.identity = identityB;
      return Promise.reject(new Error("git exploded"));
    });
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    expect(h.logs).toContain("Error: git exploded");
    h.state.identity = identityA;
    expect(await runtime.handle(sessionEvent("UserPromptSubmit"))).toEqual({});
  });
});

describe("Session Mesh runtime context waiters", () => {
  it("gives the first waiter the context, the second an empty result, and refuses a third", async () => {
    const h = createMeshHarness();
    h.state.inboxFor = (agentId) => [
      meshDelivery({
        id: messageA,
        recipientAgentId: agentId,
        summary: "peer owns a",
      }),
    ];
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const cached = await runtime.handle(sessionEvent("AwaitContext"));
    expect(cached.additionalContext).toContain("peer owns a");
    const first = runtime.handle(sessionEvent("AwaitContext"));
    const second = runtime.handle(sessionEvent("AwaitContext"));
    // A third waiter is refused at once, which also proves `second` holds the
    // agent's second slot.
    expect(
      await valueAfterOneMacrotask(runtime.handle(sessionEvent("AwaitContext")))
    ).toEqual({});
    await runtime.handle(sessionEvent("UserPromptSubmit"));
    await runtime.whenIdle();
    const delivered = await first;
    expect(delivered.additionalContext).toContain("peer owns a");
    expect(delivered.receipt).toEqual(expect.any(String));
    expect(await second).toEqual({});
  });

  it("refuses a waiter for a new agent once 500 agents are waiting, still registers a second waiter for a waiting agent, and stop settles the rest empty", async () => {
    // Fake timers keep each waiter's 5 s timeout from firing, so only a publish
    // or stop() can settle a registered waiter here.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = createMeshHarness();
    const runtime = h.runtime();
    const waiting = Array.from({ length: 500 }, (_, index) =>
      runtime.handle(sessionEvent("AwaitContext", `session-${index}`))
    );
    expect(
      await valueAfterOneMacrotask(
        runtime.handle(sessionEvent("AwaitContext", "late"))
      )
    ).toEqual({});
    const settleOrder: string[] = [];
    const secondForExisting = runtime
      .handle(sessionEvent("AwaitContext", "session-0"))
      .then((result) => {
        settleOrder.push("second-for-existing");
        return result;
      });
    // Two waiters per agent is the limit, so a third for session-0 is refused.
    expect(
      await valueAfterOneMacrotask(
        runtime.handle(sessionEvent("AwaitContext", "session-0"))
      )
    ).toEqual({});
    // The 500th waiter is registered: it receives the context a later hook
    // publishes for its agent.
    await runtime.handle(sessionEvent("SessionStart", "session-499"));
    await runtime.whenIdle();
    expect(
      (await (waiting[499] ?? Promise.resolve({}))).additionalContext
    ).toContain("Your canonical Mesh ID: claude:session-499.");
    settleOrder.push("stop");
    runtime.stop();
    expect(
      await Promise.all([...waiting.slice(0, 499), secondForExisting])
    ).toEqual(Array.from({ length: 500 }, () => ({})));
    // A refused waiter settles `{}` at once, and so does one released by
    // stop(). Settling only after stop() is what proves secondForExisting
    // was registered despite the 500-agent cap.
    expect(settleOrder).toEqual(["stop", "second-for-existing"]);
  });
});

describe("Session Mesh runtime receipts and previews", () => {
  it("keeps another agent's roster-only context when a receipt is delivered, and ignores a receipt-less delivery", async () => {
    const h = createMeshHarness();
    h.state.inboxFor = (agentId) =>
      agentId === "claude:session-a"
        ? [
            meshDelivery({
              id: messageA,
              recipientAgentId: agentId,
              summary: "for a",
            }),
          ]
        : [];
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart", "session-a"));
    await runtime.handle(sessionEvent("SessionStart", "session-b"));
    await runtime.whenIdle();
    const forA = await runtime.handle(
      sessionEvent("AwaitContext", "session-a")
    );
    expect(forA.receipt).toEqual(expect.any(String));
    await runtime.handle(meshEvent("ContextDelivered", {}));
    await runtime.whenIdle();
    expect(h.count((request) => request.path.endsWith("/disposition"))).toBe(0);
    expect(h.logs).toEqual([]);
    await runtime.handle(
      meshEvent("ContextDelivered", { receipt: forA.receipt })
    );
    await runtime.whenIdle();
    expect(
      h.requests.find((request) => request.path.endsWith("/disposition"))?.body
    ).toEqual({
      agentId: "claude:session-a",
      messageId: messageA,
      status: "delivered",
      reason: "Native hook context stdout flushed",
    });
    const forB = await runtime.handle(
      sessionEvent("UserPromptSubmit", "session-b")
    );
    expect(forB.additionalContext).toContain(
      "Your canonical Mesh ID: claude:session-b"
    );
    expect(forB.receipt).toBeUndefined();
  });

  it("hides a locally delivered message from the next preview until five minutes pass", async () => {
    const h = createMeshHarness();
    h.state.inboxFor = (agentId) => [
      meshDelivery({
        id: messageA,
        recipientAgentId: agentId,
        summary: "delivered once",
      }),
    ];
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const first = await runtime.handle(sessionEvent("AwaitContext"));
    await runtime.handle(
      meshEvent("ContextDelivered", { receipt: first.receipt })
    );
    await runtime.whenIdle();
    await runtime.handle(sessionEvent("UserPromptSubmit"));
    await runtime.whenIdle();
    const hidden = await runtime.handle(sessionEvent("AwaitContext"));
    expect(hidden.additionalContext).toContain("Live peers: codex:peer.");
    expect(hidden.additionalContext).not.toContain("delivered once");
    expect(hidden.receipt).toBeUndefined();
    h.state.now += 300_000;
    await runtime.handle(sessionEvent("UserPromptSubmit"));
    await runtime.whenIdle();
    expect(
      (await runtime.handle(sessionEvent("AwaitContext"))).additionalContext ??
        ""
    ).not.toContain("delivered once");
    h.state.now += 1;
    await runtime.handle(sessionEvent("UserPromptSubmit"));
    await runtime.whenIdle();
    const again = await runtime.handle(sessionEvent("AwaitContext"));
    expect(again.additionalContext).toContain(
      `[claim; ${messageA}; codex:peer] delivered once`
    );
    expect(again.receipt).toEqual(expect.any(String));
  });

  it("drops receipts older than five minutes when the next preview is recorded", async () => {
    const h = createMeshHarness();
    h.state.inboxFor = (agentId) => [
      meshDelivery({ id: messageA, recipientAgentId: agentId, summary: "m" }),
    ];
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const stale = Object.keys(h.ledger().receipts);
    expect(stale).toHaveLength(1);
    h.state.now += 300_000;
    await runtime.handle(sessionEvent("UserPromptSubmit"));
    await runtime.whenIdle();
    expect(Object.keys(h.ledger().receipts)).toContain(stale[0]);
    h.state.now += 1;
    await runtime.handle(sessionEvent("UserPromptSubmit"));
    await runtime.whenIdle();
    const fresh = Object.keys(h.ledger().receipts);
    expect(fresh).toHaveLength(2);
    expect(fresh).not.toContain(stale[0]);
    await runtime.handle(meshEvent("ContextDelivered", { receipt: stale[0] }));
    await runtime.whenIdle();
    expect(h.count((request) => request.path.endsWith("/disposition"))).toBe(0);
  });

  it("previews at most twenty peers, labels an authorless message, and truncates a long summary", async () => {
    const h = createMeshHarness();
    h.state.roster = () => [
      "claude:session-1",
      ...Array.from({ length: 22 }, (_, index) => `codex:peer-${index}`),
    ];
    h.state.inboxFor = (agentId) => [
      meshDelivery({
        id: messageB,
        recipientAgentId: agentId,
        summary: longSummary,
        kind: "discovery",
        authorAgentId: null,
      }),
    ];
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const context = (await runtime.handle(sessionEvent("AwaitContext")))
      .additionalContext;
    expect(context).toContain(
      "Roster preview: 2 additional peers omitted from this page; use list to inspect the returned page."
    );
    expect(context).toContain("codex:peer-19.");
    expect(context).not.toContain("codex:peer-20");
    expect(context).not.toContain("claude:session-1,");
    expect(context).toContain(
      `[discovery; ${messageB}; peer] ${"x".repeat(600)}… (fetch for full context)`
    );
    expect(context).not.toContain("x".repeat(601));
  });

  it("refuses a new preview once 500 receipts are outstanding", async () => {
    const h = createMeshHarness();
    const receipts = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `receipt-${index}`,
        {
          sourceKey: sourceKeyOf(identityB),
          agentId: "codex:other",
          messageIds: [],
          createdAt: h.state.now,
        },
      ])
    );
    writeFileSync(
      h.ledgerFile,
      JSON.stringify({ version: 1, operations: [], receipts })
    );
    h.state.inboxFor = (agentId) => [
      meshDelivery({ id: messageA, recipientAgentId: agentId, summary: "m" }),
    ];
    const runtime = h.runtime();
    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    expect(h.logs).toContain(
      "Error: Session Mesh outstanding receipt limit reached"
    );
    expect(Object.keys(h.ledger().receipts)).toHaveLength(500);
    expect(await runtime.handle(sessionEvent("UserPromptSubmit"))).toEqual({
      awaitContext: false,
    });
  });
});
