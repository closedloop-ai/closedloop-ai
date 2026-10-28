/**
 * @file live-hook-coverage-2.test.ts
 * @description ISS-10514: pins how a live `SubagentStop` resolves and reads a
 * native subagent sidecar transcript. Each refusal case builds a sidecar that
 * WOULD be ingested if that guard were missing, so the absence of the sidecar's
 * tool event is the guard's effect, not an empty fixture. The first case is the
 * positive control that proves the fixture ingests when nothing refuses it.
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookData } from "../src/main/dashboard/agent-dashboard-db-types.js";
import { DESKTOP_AGENT_STATUS } from "../src/main/database/db-constants.js";
import { mainAgentId } from "../src/main/database/write-core-main-agent-spine.js";
import {
  type LiveHookHarness,
  openLiveHookHarness,
  readAgents,
  readEvents,
} from "./live-hook-coverage-harness.js";

const SESSION_ID = "session";
const NATIVE_ID = "agent-sidecar1";
const STOP_AT = "2026-09-01T12:00:10.000Z";
const SIDECAR_TOOL = "Read";
const IS_ROOT = process.getuid?.() === 0;

const SIDECAR_LINE = `${JSON.stringify({
  type: "assistant",
  timestamp: "2026-09-01T12:00:05.000Z",
  message: {
    content: [
      {
        type: "tool_use",
        id: "toolu_iss10514_sidecar",
        name: SIDECAR_TOOL,
        input: { file_path: "src/index.ts" },
      },
    ],
  },
})}\n`;

let dir = "";
let projectDir = "";
let harness: LiveHookHarness | null = null;
let previousClaudeHome: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "live-hook-coverage-2-"));
  const claudeHome = path.join(dir, "claude-home");
  projectDir = path.join(claudeHome, "projects", "project");
  await mkdir(projectDir, { recursive: true });
  previousClaudeHome = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = claudeHome;
  harness = await openLiveHookHarness();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = null;
  if (previousClaudeHome === undefined) {
    Reflect.deleteProperty(process.env, "CLAUDE_HOME");
  } else {
    process.env.CLAUDE_HOME = previousClaudeHome;
  }
  await rm(dir, { recursive: true, force: true });
});

function current(): LiveHookHarness {
  if (!harness) {
    throw new Error("harness not open");
  }
  return harness;
}

/** Writes `<parentDir>/<stem>.jsonl` and its `<stem>/subagents/<native>.jsonl` sidecar. */
async function writeParentAndSidecar(
  parentDir: string,
  stem: string
): Promise<string> {
  const parent = path.join(parentDir, `${stem}.jsonl`);
  const subagentsDir = path.join(parentDir, stem, "subagents");
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(parent, "{}\n", "utf8");
  await writeFile(
    path.join(subagentsDir, `${NATIVE_ID}.jsonl`),
    SIDECAR_LINE,
    "utf8"
  );
  return parent;
}

async function spawnNativeSubagent(): Promise<void> {
  const h = current();
  await h.send("UserPromptSubmit", { session_id: SESSION_ID });
  await h.send("PreToolUse", {
    session_id: SESSION_ID,
    tool_name: "Task",
    tool_input: { description: "sidecar worker", agent_id: NATIVE_ID },
  });
  h.setNow(STOP_AT);
}

async function subagentRow() {
  const rows = await readAgents(current(), SESSION_ID);
  return rows.find((row) => row.id !== mainAgentId(SESSION_ID));
}

async function sidecarToolEvents() {
  const events = await readEvents(current(), SESSION_ID);
  return events.filter((event) => event.tool_name === SIDECAR_TOOL);
}

function stop(transcriptPath: string): Promise<boolean> {
  return current().send("SubagentStop", {
    session_id: SESSION_ID,
    agent_id: NATIVE_ID,
    transcript_path: transcriptPath,
  });
}

describe("live SubagentStop sidecar resolution", () => {
  it("ingests the native sidecar beside an admitted parent transcript", async () => {
    const parent = await writeParentAndSidecar(projectDir, SESSION_ID);
    await spawnNativeSubagent();

    expect(await stop(parent)).toBe(true);

    const row = await subagentRow();
    expect(row?.status).toBe(DESKTOP_AGENT_STATUS.COMPLETED);
    expect(await sidecarToolEvents()).toEqual([
      {
        agent_id: row?.id,
        event_type: "PostToolUse",
        tool_name: SIDECAR_TOOL,
        summary: SIDECAR_TOOL,
      },
    ]);
  });

  it("completes the subagent without a sidecar read when transcript_path is not a string", async () => {
    await writeParentAndSidecar(projectDir, SESSION_ID);
    await spawnNativeSubagent();

    // The hook body is JSON from the local listener, so a numeric path is
    // reachable at runtime even though HookData types it as a string.
    const data: HookData = JSON.parse(
      JSON.stringify({
        session_id: SESSION_ID,
        agent_id: NATIVE_ID,
        transcript_path: 42,
      })
    );
    expect(await current().send("SubagentStop", data)).toBe(true);

    expect((await subagentRow())?.status).toBe(DESKTOP_AGENT_STATUS.COMPLETED);
    expect(await sidecarToolEvents()).toEqual([]);
  });

  it("refuses a relative transcript path that only resolves into a subagents directory", async () => {
    const cwd = path.join(projectDir, "cwd");
    // Resolved against the faked cwd this is <cwd>/subagents/session.jsonl: an
    // admitted file with a readable sidecar, so only the resolved-path
    // subagents check stands between it and ingest.
    await writeParentAndSidecar(path.join(cwd, "subagents"), SESSION_ID);
    await spawnNativeSubagent();
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    expect(await stop(path.join("subagents", `${SESSION_ID}.jsonl`))).toBe(
      true
    );

    vi.restoreAllMocks();
    expect((await subagentRow())?.status).toBe(DESKTOP_AGENT_STATUS.COMPLETED);
    expect(await sidecarToolEvents()).toEqual([]);
  });

  it("refuses a sidecar whose subagents directory links outside the projects root", async () => {
    const parent = path.join(projectDir, `${SESSION_ID}.jsonl`);
    await writeFile(parent, "{}\n", "utf8");
    const outside = path.join(dir, "outside-subagents");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, `${NATIVE_ID}.jsonl`), SIDECAR_LINE);
    await mkdir(path.join(projectDir, SESSION_ID), { recursive: true });
    await symlink(outside, path.join(projectDir, SESSION_ID, "subagents"));
    await spawnNativeSubagent();

    expect(await stop(parent)).toBe(true);

    expect((await subagentRow())?.status).toBe(DESKTOP_AGENT_STATUS.COMPLETED);
    expect(await sidecarToolEvents()).toEqual([]);
  });

  // chmod 000 does not stop root from reading, so the unreadable-file fixture
  // cannot be built under uid 0.
  it("keeps the stop when the sidecar scan itself fails", {
    skip: IS_ROOT,
  }, async () => {
    const parent = await writeParentAndSidecar(projectDir, SESSION_ID);
    const sidecar = path.join(
      projectDir,
      SESSION_ID,
      "subagents",
      `${NATIVE_ID}.jsonl`
    );
    await chmod(sidecar, 0o000);
    await spawnNativeSubagent();

    try {
      expect(await stop(parent)).toBe(true);
    } finally {
      await chmod(sidecar, 0o600);
    }

    expect((await subagentRow())?.status).toBe(DESKTOP_AGENT_STATUS.COMPLETED);
    expect(await sidecarToolEvents()).toEqual([]);
    expect(current().logs).toEqual([]);
  });
});
