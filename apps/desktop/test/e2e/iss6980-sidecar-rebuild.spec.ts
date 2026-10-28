import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { expect, type Page, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktop-app";
import {
  applyDesktopBusyTimeout,
  branchesDbPath,
} from "./helpers/desktop-seed-core";
import { seedClaudeTranscripts } from "./helpers/seed";

const SESSION_ID = "iss6980-sidecar-rebuild";
const PROJECT = "iss6980-sidecar-project";
const FIRST_TOOL_USE_ID = "toolu_z_source_first";
const SECOND_TOOL_USE_ID = "toolu_a_source_second";

test("ISS-6980 displayless rebuild preserves exact-id completion and timezone stability", async () => {
  test.setTimeout(240_000);
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss6980-claude-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss6980-codex-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss6980-udd-"));
  seedClaudeTranscripts(
    claudeHome,
    [{ sessionId: SESSION_ID, slug: "ISS-6980 Sidecar Rebuild" }],
    PROJECT
  );
  seedSidecar(claudeHome);

  try {
    await launchAndAssert({
      claudeHome,
      codexHome,
      userDataDir,
      timeZone: "UTC",
    });
    await makeProjectionStale(userDataDir);
    const rebuilt = await launchAndAssert({
      claudeHome,
      codexHome,
      userDataDir,
      timeZone: "America/Chicago",
    });
    const replayed = await launchAndAssert({
      claudeHome,
      codexHome,
      userDataDir,
      timeZone: "UTC",
    });
    expect(replayed).toEqual(rebuilt);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(claudeHome, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

async function launchAndAssert(input: {
  claudeHome: string;
  codexHome: string;
  userDataDir: string;
  timeZone: string;
}): Promise<Record<string, unknown>[]> {
  const app = await launchDesktopApp({
    env: {
      CLAUDE_HOME: input.claudeHome,
      CODEX_HOME: input.codexHome,
      TZ: input.timeZone,
    },
    keepUserDataDir: true,
    userDataDir: input.userDataDir,
  });
  try {
    const expected = expectedEvents();
    await expect
      .poll(() => readToolEvents(app.page), { timeout: 60_000 })
      .toEqual(expected);
    expect(app.pageErrors).toEqual([]);
    return await readToolEvents(app.page);
  } finally {
    await app.cleanup();
  }
}

function seedSidecar(claudeHome: string): void {
  const subagentsDir = path.join(
    claudeHome,
    "projects",
    PROJECT,
    SESSION_ID,
    "subagents"
  );
  fs.mkdirSync(subagentsDir, { recursive: true });
  const records = [
    resultRecord(SECOND_TOOL_USE_ID, "second completed", false),
    resultRecord(FIRST_TOOL_USE_ID, "first completed", false),
    actionRecord(FIRST_TOOL_USE_ID, "Write", { file_path: "src/first.ts" }),
    actionRecord(SECOND_TOOL_USE_ID, "Read", { file_path: "src/second.ts" }),
  ];
  fs.writeFileSync(
    path.join(subagentsDir, "agent-iss6980.jsonl"),
    `${JSON.stringify(records[0])}\n{malformed sibling\n${records
      .slice(1)
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
    "utf8"
  );
}

function actionRecord(id: string, name: string, input: Record<string, string>) {
  return {
    type: "assistant",
    timestamp: "2026-08-17T20:00:00.500Z",
    message: { content: [{ type: "tool_use", id, name, input }] },
  };
}

function resultRecord(id: string, content: string, isError: boolean) {
  return {
    type: "user",
    timestamp: "2026-08-17T20:00:01.000Z",
    message: {
      content: [
        { type: "tool_result", tool_use_id: id, content, is_error: isError },
      ],
    },
  };
}

function expectedEvents(): Record<string, unknown>[] {
  return [
    {
      providerToolUseId: FIRST_TOOL_USE_ID,
      kind: "builtin",
      tool_input: { file_path: "src/first.ts" },
      tool_response: "first completed",
      // ISS-10736: the result payload's footprint, counted at parse time and
      // persisted by `importToolEventData`. ceil(15 ASCII chars / 4) = 4 for
      // "first completed", ceil(16 / 4) = 4 for "second completed". Pinned as a
      // literal rather than recomputed through the estimator, so a change to the
      // estimator fails here instead of agreeing with itself.
      toolFootprintTokens: 4,
      resultTimestamp: "2026-08-17T20:00:01.000Z",
      isError: false,
    },
    {
      providerToolUseId: SECOND_TOOL_USE_ID,
      kind: "builtin",
      tool_input: { file_path: "src/second.ts" },
      tool_response: "second completed",
      toolFootprintTokens: 4,
      resultTimestamp: "2026-08-17T20:00:01.000Z",
      isError: false,
    },
  ];
}

async function makeProjectionStale(userDataDir: string): Promise<void> {
  const client = createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
  try {
    await applyDesktopBusyTimeout(client);
    await client.batch(
      [
        {
          sql: "UPDATE sessions SET data_revision = data_revision - 1, status = 'inactive' WHERE id = ?",
          args: [SESSION_ID],
        },
        {
          sql: "UPDATE events SET data = json_object('tool_name', tool_name) WHERE session_id = ? AND event_type = 'PostToolUse'",
          args: [SESSION_ID],
        },
      ],
      "write"
    );
  } finally {
    client.close();
  }
}

function readToolEvents(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(async (sessionId) => {
    const api = (
      globalThis as unknown as {
        desktopApi?: {
          db?: {
            getEvents?: (sessionId: string) => Promise<
              {
                eventType: string;
                toolName: string | null;
                data: string | null;
              }[]
            >;
          };
        };
      }
    ).desktopApi?.db;
    if (!api?.getEvents) {
      return [];
    }
    return (await api.getEvents(sessionId))
      .filter((event) => event.eventType === "PostToolUse" && event.data)
      .map(
        (event) => JSON.parse(event.data ?? "{}") as Record<string, unknown>
      );
  }, SESSION_ID);
}
