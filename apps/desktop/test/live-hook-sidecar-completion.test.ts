import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { scanSubagentTranscriptStream } from "../src/main/collectors/parsing/subagent-scanner.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

test("live SubagentStop persists exact-id sidecar completion metadata", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "live-sidecar-completion-"));
  const previousClaudeHome = process.env.CLAUDE_HOME;
  const claudeHome = path.join(dir, "claude-home");
  const projectDir = path.join(claudeHome, "projects", "project");
  const parentTranscript = path.join(projectDir, "session.jsonl");
  const subagentsDir = path.join(projectDir, "session", "subagents");
  const agentId = "agent-completion";
  const sidecarPath = path.join(subagentsDir, `${agentId}.jsonl`);
  const action = {
    type: "assistant",
    timestamp: "2026-08-17T20:00:00.000Z",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_live_completion",
          name: "Read",
          input: { file_path: "src/index.ts" },
        },
      ],
    },
  };
  const result = {
    type: "user",
    timestamp: "2026-08-17T20:00:01.000Z",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_live_completion",
          content: "finished",
          is_error: false,
        },
      ],
    },
  };
  process.env.CLAUDE_HOME = claudeHome;
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(parentTranscript, "{}\n", "utf8");
  await writeSidecar(sidecarPath, [action]);
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-08-17T20:00:00.000Z",
  });
  try {
    await db.processEvent(
      "SessionStart",
      { session_id: "session", cwd: path.join(dir, "workspace") },
      "claude"
    );
    await db.processEvent(
      "PreToolUse",
      {
        session_id: "session",
        agent_id: agentId,
        tool_name: "Task",
        tool_input: {
          subagent_type: "engineer",
          description: "completion",
          prompt: "completion",
          agent_id: agentId,
        },
      },
      "claude"
    );
    await db.processEvent(
      "SubagentStop",
      {
        session_id: "session",
        agent_id: agentId,
        tool_name: "Task",
        transcript_path: parentTranscript,
      },
      "claude"
    );

    const partialEvent = (await db.events.getBySession("session")).find(
      (candidate) =>
        candidate.eventType === "PostToolUse" && candidate.toolName === "Read"
    );
    assert.ok(partialEvent);
    assert.deepEqual(JSON.parse(partialEvent.data ?? "{}"), {
      tool_name: "Read",
      tool_use_id: "toolu_live_completion",
      tool_input: { file_path: "src/index.ts" },
    });

    await writeSidecar(sidecarPath, [action, result]);
    await db.processEvent(
      "SubagentStop",
      {
        session_id: "session",
        agent_id: agentId,
        tool_name: "Task",
        transcript_path: parentTranscript,
      },
      "claude"
    );
    const completedEvent = (await db.events.getBySession("session")).find(
      (candidate) =>
        candidate.eventType === "PostToolUse" && candidate.toolName === "Read"
    );
    assert.ok(completedEvent);
    assert.deepEqual(JSON.parse(completedEvent.data ?? "{}"), {
      tool_name: "Read",
      tool_use_id: "toolu_live_completion",
      tool_input: { file_path: "src/index.ts" },
      tool_response: "finished",
      resultTimestamp: "2026-08-17T20:00:01.000Z",
      isError: false,
    });

    await writeSidecar(sidecarPath, [
      action,
      result,
      {
        ...result,
        timestamp: "2026-08-17T20:00:02.000Z",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_live_completion",
              content: "conflicting result",
              is_error: true,
            },
          ],
        },
      },
    ]);
    assert.deepEqual(
      (await scanSubagentTranscriptStream(sidecarPath, "session", agentId))
        .conflictedToolUseIds,
      ["toolu_live_completion"]
    );
    await db.processEvent(
      "SubagentStop",
      {
        session_id: "session",
        agent_id: agentId,
        tool_name: "Task",
        transcript_path: parentTranscript,
      },
      "claude"
    );
    assert.equal(
      (await db.events.getBySession("session")).some(
        (candidate) =>
          candidate.eventType === "PostToolUse" && candidate.toolName === "Read"
      ),
      false
    );
  } finally {
    await db.close();
    if (previousClaudeHome === undefined) {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    } else {
      process.env.CLAUDE_HOME = previousClaudeHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeSidecar(
  sidecarPath: string,
  entries: readonly unknown[]
): Promise<void> {
  await writeFile(
    sidecarPath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8"
  );
}
