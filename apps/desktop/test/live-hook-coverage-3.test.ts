/**
 * @file live-hook-coverage-3.test.ts
 * @description ISS-10514 survivor pass: the live-hook cases that pin the
 * branches the first two coverage suites reached but did not distinguish — the
 * fresh-start summary, the PostToolUse tool clear, text caps, non-string tool
 * ids, reactivation on a non-stop hook, and SubagentStop's task matching.
 */
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterEach, describe, expect, it } from "vitest";
import type { HookData } from "../src/main/dashboard/agent-dashboard-db-types.js";
import { DESKTOP_AGENT_STATUS } from "../src/main/database/db-constants.js";
import { mainAgentId } from "../src/main/database/write-core-main-agent-spine.js";
import {
  HARNESS_NOW,
  type LiveHookHarness,
  openLiveHookHarness,
  readAgents,
  readEvents,
  readSession,
} from "./live-hook-coverage-harness.js";

const SESSION_ID = "iss10514-live-hook-3";
const MAIN = mainAgentId(SESSION_ID);
const T1 = "2026-09-01T12:00:01.000Z";
const T2 = "2026-09-01T12:00:02.000Z";
const T3 = "2026-09-01T12:00:03.000Z";

let harness: LiveHookHarness | null = null;

async function open(): Promise<LiveHookHarness> {
  harness = await openLiveHookHarness();
  return harness;
}

async function mainAgent(h: LiveHookHarness) {
  const agents = await readAgents(h, SESSION_ID);
  return agents.find((agent) => agent.id === MAIN);
}

async function statusByName(h: LiveHookHarness) {
  const agents = await readAgents(h, SESSION_ID);
  return Object.fromEntries(
    agents
      .filter((agent) => agent.id !== MAIN)
      .map((agent) => [agent.name, agent.status])
  );
}

async function spawn(h: LiveHookHarness, at: string, data: HookData) {
  h.setNow(at);
  await h.send("PreToolUse", {
    session_id: SESSION_ID,
    tool_name: "Task",
    ...data,
  });
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("hook dispatch", () => {
  it("summarizes a fresh SessionStart as a start", async () => {
    const h = await open();

    await h.send("SessionStart", { session_id: SESSION_ID });

    const events = await readEvents(h, SESSION_ID);
    expect(events.map((event) => event.summary)).toEqual(["Started session"]);
  });

  it("clears the working main agent's tool on PostToolUse", async () => {
    const h = await open();
    await h.send("PreToolUse", { session_id: SESSION_ID, tool_name: "Bash" });
    expect((await mainAgent(h))?.current_tool).toBe("Bash");

    h.setNow(T1);
    await h.send("PostToolUse", { session_id: SESSION_ID, tool_name: "Bash" });

    const main = await mainAgent(h);
    expect(main?.current_tool).toBeNull();
    expect(main?.status).toBe(DESKTOP_AGENT_STATUS.WORKING);
    const events = await readEvents(h, SESSION_ID);
    expect(events.at(-1)).toEqual({
      agent_id: MAIN,
      event_type: "PostToolUse",
      tool_name: "Bash",
      summary: null,
    });
  });

  it("clears the session's waiting flag on PostToolUse", async () => {
    const h = await open();
    await h.send("Notification", {
      session_id: SESSION_ID,
      message: "Claude needs your permission to use Bash",
    });
    expect((await readSession(h, SESSION_ID))?.awaiting_input_since).toBe(
      HARNESS_NOW
    );

    h.setNow(T1);
    await h.send("PostToolUse", { session_id: SESSION_ID, tool_name: "Bash" });

    expect((await readSession(h, SESSION_ID))?.awaiting_input_since).toBeNull();
  });

  it("caps a waiting-for-input Notification's summary at 200 characters", async () => {
    const h = await open();
    const message = `Claude needs your permission to use Bash ${"y".repeat(250)}`;

    await h.send("Notification", { session_id: SESSION_ID, message });

    const events = await readEvents(h, SESSION_ID);
    expect(events.map((event) => event.summary)).toEqual([
      message.slice(0, 200),
    ]);
    expect((await readSession(h, SESSION_ID))?.awaiting_input_since).toBe(
      HARNESS_NOW
    );
  });

  it("does not use a non-string tool_use_id to keep same-instant events apart", async () => {
    const h = await open();
    // Hook bodies are JSON from the local listener, so a numeric id is
    // reachable at runtime even though it is not a string.
    const withNumericId = (id: number): HookData =>
      JSON.parse(
        JSON.stringify({
          session_id: SESSION_ID,
          tool_name: "Read",
          tool_use_id: id,
        })
      );

    await h.send("PostToolUse", withNumericId(7));
    await h.send("PostToolUse", withNumericId(8));

    const events = await readEvents(h, SESSION_ID);
    expect(
      events.filter((event) => event.event_type === "PostToolUse")
    ).toHaveLength(1);
  });
});

describe("reactivation", () => {
  it("revives an inactive session on a Notification", async () => {
    const h = await open();
    await h.send("SessionStart", { session_id: SESSION_ID });
    h.setNow(T1);
    await h.send("SessionEnd", { session_id: SESSION_ID });
    expect((await readSession(h, SESSION_ID))?.status).toBe(
      SESSION_STATUS.INACTIVE
    );

    h.setNow(T2);
    await h.send("Notification", { session_id: SESSION_ID, message: "hello" });

    expect((await readSession(h, SESSION_ID))?.status).toBe(
      SESSION_STATUS.ACTIVE
    );
    expect((await mainAgent(h))?.status).toBe(DESKTOP_AGENT_STATUS.WORKING);
  });
});

describe("subagent naming and task matching", () => {
  it("caps a prompt-derived subagent name at 60 characters", async () => {
    const h = await open();
    await h.send("UserPromptSubmit", { session_id: SESSION_ID });
    const firstLine = "z".repeat(80);

    await spawn(h, T1, { tool_input: { prompt: `${firstLine}\nrest` } });

    expect(Object.keys(await statusByName(h))).toEqual([
      firstLine.slice(0, 60),
    ]);
  });

  it("matches a stop's prompt against the task stored truncated to 500 characters", async () => {
    const h = await open();
    await h.send("UserPromptSubmit", { session_id: SESSION_ID });
    const longPrompt = "p".repeat(700);
    await spawn(h, T1, {
      tool_input: { description: "long", prompt: longPrompt },
    });
    await spawn(h, T2, {
      tool_input: { description: "newer", prompt: "short" },
    });

    h.setNow(T3);
    await h.send("SubagentStop", {
      session_id: SESSION_ID,
      agent_type: "nobody",
      prompt: longPrompt,
    });

    expect(await statusByName(h)).toEqual({
      long: DESKTOP_AGENT_STATUS.COMPLETED,
      newer: DESKTOP_AGENT_STATUS.WORKING,
    });
  });

  it("does not match by task when the stop carries no prompt", async () => {
    const h = await open();
    await h.send("UserPromptSubmit", { session_id: SESSION_ID });
    // A task whose text is literally "undefined" is what a stop without a
    // prompt would match if the absent prompt were stringified.
    await spawn(h, T1, {
      tool_input: { description: "older", prompt: "undefined" },
    });
    await spawn(h, T2, {
      tool_input: { description: "newer", prompt: "other" },
    });

    h.setNow(T3);
    await h.send("SubagentStop", {
      session_id: SESSION_ID,
      agent_type: "nobody",
    });

    expect(await statusByName(h)).toEqual({
      older: DESKTOP_AGENT_STATUS.WORKING,
      newer: DESKTOP_AGENT_STATUS.COMPLETED,
    });
  });
});
