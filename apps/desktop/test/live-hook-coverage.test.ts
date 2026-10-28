/**
 * @file live-hook-coverage.test.ts
 * @description ISS-10514: pins the live-hook lifecycle arms the focused
 * live-hook suites leave unexercised — the wrapper's extractor and write
 * failure handling, the Notification and unknown-hook dispatch arms, replay
 * and reactivation rules, subagent naming and parent placement, and the
 * SubagentStop identifier match order. Every case drives the real
 * `createSqliteLifecycle` over a migrated test database.
 */
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookData } from "../src/main/dashboard/agent-dashboard-db-types.js";
import { DESKTOP_AGENT_STATUS } from "../src/main/database/db-constants.js";
import { mainAgentId } from "../src/main/database/write-core-main-agent-spine.js";
import {
  emptyTranscript,
  HARNESS_NOW,
  type LiveHookHarness,
  openLiveHookHarness,
  readAgents,
  readEvents,
  readSession,
} from "./live-hook-coverage-harness.js";

const SESSION_ID = "iss10514-live-hook";
const MAIN = mainAgentId(SESSION_ID);
const T1 = "2026-09-01T12:00:01.000Z";
const T2 = "2026-09-01T12:00:02.000Z";
const T3 = "2026-09-01T12:00:03.000Z";
const T4 = "2026-09-01T12:00:04.000Z";
const T5 = "2026-09-01T12:00:05.000Z";
const TRANSCRIPT_PATH = "/tmp/iss10514-not-read.jsonl";
const WRITE_FAILURE = "token usage write refused";

let harness: LiveHookHarness | null = null;

async function open(
  overrides: Parameters<typeof openLiveHookHarness>[0] = {}
): Promise<LiveHookHarness> {
  harness = await openLiveHookHarness(overrides);
  return harness;
}

async function mainAgent(h: LiveHookHarness) {
  const agents = await readAgents(h, SESSION_ID);
  return agents.find((agent) => agent.id === MAIN);
}

async function subagents(h: LiveHookHarness) {
  const agents = await readAgents(h, SESSION_ID);
  return agents.filter((agent) => agent.id !== MAIN);
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("processEvent wrapper", () => {
  it("drops a transcript whose extractor throws a non-token error and still writes the hook", async () => {
    const h = await open({
      deps: {
        extractTranscript: () => {
          throw new Error("transcript unreadable");
        },
      },
    });

    const processed = await h.send("UserPromptSubmit", {
      session_id: SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
    });

    expect(processed).toBe(true);
    expect((await readSession(h, SESSION_ID))?.status).toBe(
      SESSION_STATUS.ACTIVE
    );
    expect(h.logs).toEqual([]);
  });

  it("logs an Error's message, rolls the write back, and skips emit when the transaction fails", async () => {
    const emit = vi.fn();
    const h = await open({
      deps: {
        emit,
        extractTranscript: () =>
          emptyTranscript({
            tokensByModel: new Map([
              [
                "claude-opus-4-5",
                { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
              ],
            ]),
          }),
      },
      tokenUsage: (base) => ({
        ...base,
        replace: () => Promise.reject(new Error(WRITE_FAILURE)),
      }),
    });

    const processed = await h.send("PostToolUse", {
      session_id: SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
    });

    expect(processed).toBe(false);
    expect(h.logs).toEqual([
      `sqlite lifecycle: failed to process PostToolUse: ${WRITE_FAILURE}`,
    ]);
    expect(emit).not.toHaveBeenCalled();
    expect(await readSession(h, SESSION_ID)).toBeUndefined();
  });

  // pins current behavior; looks odd because the `String(error)` arm never
  // runs here: the transaction layer hands the non-Error rejection back as an
  // Error whose message is the raw text, so the log reads the same either way.
  it("logs a non-Error rejection's raw text as the failure message", async () => {
    const h = await open({
      deps: {
        extractTranscript: () =>
          emptyTranscript({
            tokensByModel: new Map([
              [
                "claude-opus-4-5",
                { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
              ],
            ]),
          }),
      },
      tokenUsage: (base) => ({
        ...base,
        replace: () => Promise.reject(WRITE_FAILURE),
      }),
    });

    const processed = await h.send("Stop", {
      session_id: SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
    });

    expect(processed).toBe(false);
    expect(h.logs).toEqual([
      `sqlite lifecycle: failed to process Stop: ${WRITE_FAILURE}`,
    ]);
  });
});

describe("session creation", () => {
  it("stores `unknown` billing when the detector throws", async () => {
    const h = await open({
      deps: {
        detectBillingMode: () => {
          throw new Error("detector failed");
        },
      },
    });

    await h.send("SessionStart", { session_id: SESSION_ID });

    expect((await readSession(h, SESSION_ID))?.billing_mode).toBe("unknown");
  });

  it("classifies billing from the hook's model", async () => {
    const detectBillingMode = vi.fn(() => "subscription");
    const h = await open({ deps: { detectBillingMode } });

    await h.send("SessionStart", {
      session_id: SESSION_ID,
      model: "claude-opus-4-5",
    });

    expect(detectBillingMode).toHaveBeenCalledWith("claude", "claude-opus-4-5");
    expect((await readSession(h, SESSION_ID))?.billing_mode).toBe(
      "subscription"
    );
  });
});

describe("hook dispatch arms", () => {
  it("summarizes a resumed SessionStart as a resume", async () => {
    const h = await open();

    await h.send("SessionStart", { session_id: SESSION_ID, source: "resume" });

    expect(await readEvents(h, SESSION_ID)).toEqual([
      {
        agent_id: MAIN,
        event_type: "SessionStart",
        tool_name: null,
        summary: "Resumed session",
      },
    ]);
  });

  it("clears the main agent's current tool when PreToolUse carries no tool name", async () => {
    const h = await open();
    await h.send("PreToolUse", { session_id: SESSION_ID, tool_name: "Bash" });
    expect((await mainAgent(h))?.current_tool).toBe("Bash");

    h.setNow(T1);
    await h.send("PreToolUse", { session_id: SESSION_ID });

    const main = await mainAgent(h);
    expect(main?.current_tool).toBeNull();
    expect(main?.status).toBe(DESKTOP_AGENT_STATUS.WORKING);
  });

  it("leaves the current tool alone on PostToolUse when the main agent is not working", async () => {
    const h = await open();
    await h.send("PreToolUse", { session_id: SESSION_ID, tool_name: "Bash" });
    h.setNow(T1);
    await h.send("Stop", { session_id: SESSION_ID });
    expect((await mainAgent(h))?.status).toBe(DESKTOP_AGENT_STATUS.WAITING);

    h.setNow(T2);
    await h.send("PostToolUse", { session_id: SESSION_ID, tool_name: "Bash" });

    const main = await mainAgent(h);
    expect(main?.current_tool).toBe("Bash");
    expect(main?.status).toBe(DESKTOP_AGENT_STATUS.WAITING);
  });

  it("notifies the terminal error transition once when Stop(error) replays", async () => {
    const onSessionTerminal = vi.fn();
    const h = await open({ deps: { onSessionTerminal } });
    await h.send("UserPromptSubmit", { session_id: SESSION_ID });

    h.setNow(T1);
    expect(
      await h.send("Stop", { session_id: SESSION_ID, stop_reason: "error" })
    ).toBe(true);
    h.setNow(T2);
    expect(
      await h.send("Stop", { session_id: SESSION_ID, stop_reason: "error" })
    ).toBe(true);

    expect(onSessionTerminal.mock.calls).toEqual([
      [{ sessionId: SESSION_ID, status: SESSION_STATUS.ERROR }],
    ]);
    expect((await readSession(h, SESSION_ID))?.status).toBe(
      SESSION_STATUS.ERROR
    );
  });

  it("records a compaction Notification as a Compaction event", async () => {
    const h = await open();

    await h.send("Notification", {
      session_id: SESSION_ID,
      message: "Context compacted to fit the window",
    });

    const events = await readEvents(h, SESSION_ID);
    expect(events).toEqual([
      {
        agent_id: MAIN,
        event_type: "Compaction",
        tool_name: null,
        summary: "Context compaction",
      },
    ]);
    expect((await mainAgent(h))?.status).toBe(DESKTOP_AGENT_STATUS.WORKING);
  });

  it("marks the main agent waiting on a waiting-for-input Notification", async () => {
    const h = await open();
    const message = "Claude needs your permission to use Bash";

    await h.send("Notification", { session_id: SESSION_ID, message });

    expect(await readEvents(h, SESSION_ID)).toEqual([
      {
        agent_id: MAIN,
        event_type: "Notification",
        tool_name: null,
        summary: message,
      },
    ]);
    expect((await mainAgent(h))?.status).toBe(DESKTOP_AGENT_STATUS.WAITING);
    expect((await readSession(h, SESSION_ID))?.awaiting_input_since).toBe(
      HARNESS_NOW
    );
  });

  it("keeps a plain Notification's text as the summary, capped at 200 characters", async () => {
    const h = await open();
    const message = `Build finished ${"x".repeat(250)}`;

    await h.send("Notification", { session_id: SESSION_ID, message });

    const events = await readEvents(h, SESSION_ID);
    expect(events.map((event) => event.summary)).toEqual([
      message.slice(0, 200),
    ]);
    expect((await mainAgent(h))?.status).toBe(DESKTOP_AGENT_STATUS.WORKING);
  });

  it("stores a null summary for a Notification with no message", async () => {
    const h = await open();

    await h.send("Notification", { session_id: SESSION_ID });

    expect(await readEvents(h, SESSION_ID)).toEqual([
      {
        agent_id: MAIN,
        event_type: "Notification",
        tool_name: null,
        summary: null,
      },
    ]);
  });

  it("records an unrecognized hook type under its own name", async () => {
    const h = await open();

    await h.send("PreCompact", { session_id: SESSION_ID });

    expect(await readEvents(h, SESSION_ID)).toEqual([
      {
        agent_id: MAIN,
        event_type: "PreCompact",
        tool_name: null,
        summary: null,
      },
    ]);
  });

  it("keeps same-instant tool events apart by tool_use_id and dedupes an exact replay", async () => {
    const h = await open();
    const first = {
      session_id: SESSION_ID,
      tool_name: "Read",
      tool_use_id: "toolu_first",
    };

    await h.send("PostToolUse", first);
    await h.send("PostToolUse", { ...first, tool_use_id: "toolu_second" });
    await h.send("PostToolUse", first);

    const events = await readEvents(h, SESSION_ID);
    expect(
      events.filter((event) => event.event_type === "PostToolUse")
    ).toHaveLength(2);
  });
});

describe("reactivation", () => {
  it("revives an inactive session on SubagentStop", async () => {
    const h = await open();
    await h.send("SessionStart", { session_id: SESSION_ID });
    h.setNow(T1);
    await h.send("SessionEnd", { session_id: SESSION_ID });
    expect((await readSession(h, SESSION_ID))?.status).toBe(
      SESSION_STATUS.INACTIVE
    );

    h.setNow(T2);
    await h.send("SubagentStop", { session_id: SESSION_ID });

    const session = await readSession(h, SESSION_ID);
    expect(session?.status).toBe(SESSION_STATUS.ACTIVE);
    expect(session?.ends_with_error).toBe(0);
  });

  it("does not revive an error session on a Notification", async () => {
    const h = await open();
    await h.send("UserPromptSubmit", { session_id: SESSION_ID });
    h.setNow(T1);
    await h.send("Stop", { session_id: SESSION_ID, stop_reason: "error" });

    h.setNow(T2);
    await h.send("Notification", { session_id: SESSION_ID, message: "hello" });

    const session = await readSession(h, SESSION_ID);
    expect(session?.status).toBe(SESSION_STATUS.ERROR);
    expect(session?.ends_with_error).toBe(1);
  });
});

describe("subagent spawn", () => {
  const clocks = [T1, T2, T3, T4, T5];

  beforeEach(async () => {
    const h = await open();
    await h.send("UserPromptSubmit", { session_id: SESSION_ID });
  });

  async function spawn(h: LiveHookHarness, index: number, data: HookData) {
    h.setNow(clocks[index]);
    await h.send("PreToolUse", {
      session_id: SESSION_ID,
      tool_name: "Task",
      ...data,
    });
  }

  it("names a subagent from payload fields, then the first prompt line, then a default", async () => {
    const h = harness as LiveHookHarness;
    await spawn(h, 0, { description: "From payload description" });
    await spawn(h, 1, { subagent_type: "payload-type" });
    await spawn(h, 2, { tool_input: { subagent_type: "input-type" } });
    await spawn(h, 3, { tool_input: { prompt: "First line\nsecond line" } });
    await spawn(h, 4, {});

    const rows = await subagents(h);
    expect(
      rows.map((row) => ({
        name: row.name,
        subagentType: row.subagent_type,
        task: row.task,
      }))
    ).toEqual([
      { name: "From payload description", subagentType: null, task: null },
      { name: "payload-type", subagentType: "payload-type", task: null },
      { name: "input-type", subagentType: "input-type", task: null },
      {
        name: "First line",
        subagentType: null,
        task: "First line\nsecond line",
      },
      { name: "Subagent", subagentType: null, task: null },
    ]);
  });

  it("strips a .jsonl suffix from the native subagent id it stores", async () => {
    const h = harness as LiveHookHarness;

    await spawn(h, 0, { agent_id: "agent-abc123.jsonl" });

    const [row] = await subagents(h);
    expect(JSON.parse(row.metadata ?? "null")).toEqual({
      nativeSubagentId: "agent-abc123",
    });
  });

  it("parents a new subagent under the deepest working subagent when the main agent is not working", async () => {
    const h = harness as LiveHookHarness;
    await spawn(h, 0, { description: "outer" });
    h.setNow(T2);
    await h.send("Stop", { session_id: SESSION_ID });
    await spawn(h, 2, { description: "inner" });

    const rows = await subagents(h);
    const outer = rows.find((row) => row.name === "outer");
    const inner = rows.find((row) => row.name === "inner");
    expect(outer?.parent_agent_id).toBe(MAIN);
    expect(inner?.parent_agent_id).toBe(outer?.id);
  });
});

describe("SubagentStop matching", () => {
  async function stopAgentIds(h: LiveHookHarness) {
    const events = await readEvents(h, SESSION_ID);
    return events
      .filter((event) => event.event_type === "SubagentStop")
      .map((event) => event.agent_id);
  }

  async function statusByName(h: LiveHookHarness) {
    const rows = await subagents(h);
    return Object.fromEntries(rows.map((row) => [row.name, row.status]));
  }

  it("records an unattributed stop when the session has no subagents", async () => {
    const h = await open();
    await h.send("UserPromptSubmit", { session_id: SESSION_ID });

    await h.send("SubagentStop", { session_id: SESSION_ID });

    expect(await stopAgentIds(h)).toEqual([null]);
  });

  it("matches a native id past a newer subagent that has no metadata, and never guesses on an unknown native id", async () => {
    const h = await open();
    await h.send("UserPromptSubmit", { session_id: SESSION_ID });
    h.setNow(T1);
    await h.send("PreToolUse", {
      session_id: SESSION_ID,
      tool_name: "Task",
      description: "native",
      agent_id: "agent-native1",
    });
    h.setNow(T2);
    await h.send("PreToolUse", {
      session_id: SESSION_ID,
      tool_name: "Task",
      description: "plain",
    });

    h.setNow(T3);
    await h.send("SubagentStop", {
      session_id: SESSION_ID,
      agent_id: "agent-unknown9",
    });
    expect(await statusByName(h)).toEqual({
      native: DESKTOP_AGENT_STATUS.WORKING,
      plain: DESKTOP_AGENT_STATUS.WORKING,
    });

    h.setNow(T4);
    await h.send("SubagentStop", {
      session_id: SESSION_ID,
      agent_id: "agent-native1",
    });

    expect(await statusByName(h)).toEqual({
      native: DESKTOP_AGENT_STATUS.COMPLETED,
      plain: DESKTOP_AGENT_STATUS.WORKING,
    });
    const native = (await subagents(h)).find((row) => row.name === "native");
    expect(await stopAgentIds(h)).toEqual([null, native?.id]);
  });

  it("matches by agent_type when no name starts with it", async () => {
    const h = await open();
    await h.send("UserPromptSubmit", { session_id: SESSION_ID });
    h.setNow(T1);
    await h.send("PreToolUse", {
      session_id: SESSION_ID,
      tool_name: "Task",
      tool_input: { description: "Review code", subagent_type: "reviewer" },
    });
    h.setNow(T2);
    await h.send("PreToolUse", {
      session_id: SESSION_ID,
      tool_name: "Task",
      tool_input: { description: "Other work", subagent_type: "other" },
    });

    h.setNow(T3);
    await h.send("SubagentStop", {
      session_id: SESSION_ID,
      agent_type: "reviewer",
    });

    expect(await statusByName(h)).toEqual({
      "Review code": DESKTOP_AGENT_STATUS.COMPLETED,
      "Other work": DESKTOP_AGENT_STATUS.WORKING,
    });
  });

  it("matches by prompt when name and type miss, then falls back to the newest working subagent", async () => {
    const h = await open();
    await h.send("UserPromptSubmit", { session_id: SESSION_ID });
    h.setNow(T1);
    await h.send("PreToolUse", {
      session_id: SESSION_ID,
      tool_name: "Task",
      tool_input: { description: "alpha", prompt: "task alpha body" },
    });
    h.setNow(T2);
    await h.send("PreToolUse", {
      session_id: SESSION_ID,
      tool_name: "Task",
      tool_input: { description: "beta", prompt: "task beta body" },
    });

    h.setNow(T3);
    await h.send("SubagentStop", {
      session_id: SESSION_ID,
      agent_type: "nobody",
      prompt: "task alpha body",
    });
    expect(await statusByName(h)).toEqual({
      alpha: DESKTOP_AGENT_STATUS.COMPLETED,
      beta: DESKTOP_AGENT_STATUS.WORKING,
    });

    h.setNow(T4);
    await h.send("SubagentStop", {
      session_id: SESSION_ID,
      agent_type: "nobody",
      prompt: "a prompt no subagent ran",
    });
    expect(await statusByName(h)).toEqual({
      alpha: DESKTOP_AGENT_STATUS.COMPLETED,
      beta: DESKTOP_AGENT_STATUS.COMPLETED,
    });
  });
});
