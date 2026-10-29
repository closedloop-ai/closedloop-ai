import { rm } from "node:fs/promises";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { parseCodexRollout } from "@repo/lib/harness/codex/parse-codex";
import { describe, expect, it } from "vitest";
import {
  Harness,
  type NormalizedSession,
} from "../src/main/collectors/types.js";
import {
  readStoredInvocationRows,
  storedRowToSyncItem,
} from "../src/main/database/component-invocation-sync-item.js";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import {
  storedToolResultSucceeded,
  toolUseSucceeded,
} from "../src/main/database/tool-result-outcome.js";
import {
  makeInvocationSyncDir,
  openDb,
} from "./helpers/invocation-sync-fixtures.js";
import { staleRebuildFromStoredRows } from "./helpers/stored-rebuild.js";
import { makeSession } from "./normalized-session-test-utils.js";

// Codex outputs as rollouts record them (packages/golden-sessions 98a1952f,
// cc6c71e9), with the home path made relative.
const EXEC_EXIT_128 =
  "Chunk ID: cec30e\nWall time: 0.0000 seconds\nProcess exited with code 128\nOriginal token count: 29\nOutput:\nfatal: Unable to create '.git/index.lock': Operation not permitted\n";
const EXEC_EXIT_0 =
  "Chunk ID: 270610\nWall time: 0.1449 seconds\nProcess exited with code 0\nOriginal token count: 5\nOutput:\nfeature/FEA-1316\n";
const EXEC_RUNNING =
  "Chunk ID: 0c02b3\nWall time: 1.0089 seconds\nProcess running with session ID 53213\nOriginal token count: 0\nOutput:\n";
const EXEC_BODY_ONLY_NAMES_AN_EXIT =
  "Chunk ID: 9b2bc8\nWall time: 0.0000 seconds\nProcess running with session ID 7\nOriginal token count: 9\nOutput:\nProcess exited with code 0\n";
const MCP_RESULT =
  'Wall time: 3.9802 seconds\nOutput:\n[{"type":"text","text":"{\\"projects\\":[]}"}]';
const PATCH_OK =
  '{"output":"Success. Updated the following files:\\nM apps/desktop/package.json\\n","metadata":{"exit_code":0,"duration_seconds":0.2}}';
const PATCH_EXIT_1 =
  '{"output":"error: patch failed\\n","metadata":{"exit_code":1,"duration_seconds":0.1}}';
const PATCH_VERIFICATION_FAILED =
  "apply_patch verification failed: Failed to find expected lines in apps/desktop/scripts/agent-monitor-packs/catalog.js";
const PLAN_UPDATED = "Plan updated";

const codexVerdicts: readonly [string, string, boolean | null][] = [
  ["exit-128", EXEC_EXIT_128, false],
  ["exit-0", EXEC_EXIT_0, true],
  ["running", EXEC_RUNNING, null],
  ["body-only-exit", EXEC_BODY_ONLY_NAMES_AN_EXIT, null],
  ["mcp", MCP_RESULT, null],
  ["patch-ok", PATCH_OK, true],
  ["patch-exit-1", PATCH_EXIT_1, false],
  ["patch-verification-failed", PATCH_VERIFICATION_FAILED, null],
  ["plan", PLAN_UPDATED, null],
];

const start = "2026-08-01T10:00:00.000Z";
const end = "2026-08-01T10:00:09.000Z";
const sessionId = "codex-tool-outcome-session";

describe("Codex tool result outcome", () => {
  it("reads the exit code a Codex output carries, and nothing else", () => {
    for (const [id, output, expected] of codexVerdicts) {
      // The Codex parser stamps isError=false on every plain-text output.
      expect(
        toolUseSucceeded({ output, isError: false }, Harness.Codex),
        id
      ).toBe(expected);
      expect(
        storedToolResultSucceeded(
          AgentComponentInvocationKind.Tool,
          { isError: false, tool_response: output },
          Harness.Codex
        ),
        id
      ).toBe(expected);
    }
  });

  it("is unknown for a Codex call with no result, or a stored row whose output was dropped", () => {
    expect(toolUseSucceeded({}, Harness.Codex)).toBeNull();
    expect(
      storedToolResultSucceeded(
        AgentComponentInvocationKind.Tool,
        { isError: false },
        Harness.Codex
      )
    ).toBeNull();
    expect(
      storedToolResultSucceeded(
        AgentComponentInvocationKind.Tool,
        { tool_response: EXEC_EXIT_0 },
        Harness.Codex
      )
    ).toBeNull();
  });

  it("leaves Claude-shaped verdicts on isError, whatever the output says", () => {
    expect(
      toolUseSucceeded({ output: "ok", isError: true }, Harness.Claude)
    ).toBe(false);
    expect(toolUseSucceeded({ output: "ok" }, Harness.Claude)).toBe(true);
    expect(
      toolUseSucceeded(
        { output: EXEC_EXIT_128, isError: false },
        Harness.Claude
      )
    ).toBe(true);
    expect(
      storedToolResultSucceeded(
        AgentComponentInvocationKind.Tool,
        { isError: true, tool_response: EXEC_EXIT_0 },
        Harness.Claude
      )
    ).toBe(false);
    expect(
      storedToolResultSucceeded(
        AgentComponentInvocationKind.Tool,
        { isError: false, tool_response: EXEC_EXIT_128 },
        Harness.Claude
      )
    ).toBe(true);
  });

  it("derives the verdict from a parsed Codex rollout", async () => {
    const session = await parseRollout();
    expect(
      session.toolUses?.map((toolUse) => [toolUse.output, toolUse.isError])
    ).toEqual(codexVerdicts.map(([, output]) => [output, false]));

    const derived = deriveAgentComponentInvocationCandidates(
      session,
      "main-agent",
      end,
      Harness.Codex
    )
      .filter(
        (candidate) =>
          candidate.componentKind === AgentComponentInvocationKind.Tool
      )
      .sort((a, b) => a.sequence - b.sequence)
      .map((candidate) => candidate.succeeded);
    expect(derived).toEqual(codexVerdicts.map(([, , verdict]) => verdict));
  });

  it("carries the Codex verdict through storage and a stored-only rebuild", async () => {
    const dir = await makeInvocationSyncDir("codex-tool-outcome-");
    const db = await openDb(dir);
    try {
      await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: start,
          endedAt: end,
          toolUses: codexVerdicts.map(([id, output]) => ({
            id,
            name: "exec_command",
            timestamp: start,
            output,
            isError: false,
          })),
        }),
        Harness.Codex
      );
      const expected = new Map(
        codexVerdicts.map(([id, , verdict]) => [id, verdict ?? undefined])
      );
      const stored = await db.prisma.read((reader) =>
        readStoredInvocationRows(reader, sessionId)
      );
      expect(wireVerdicts(stored.map(storedRowToSyncItem))).toEqual(expected);

      const rebuilt = await staleRebuildFromStoredRows(db, sessionId);
      expect(rebuilt.rebuilt).toBe(true);
      const after = await db.prisma.read((reader) =>
        readStoredInvocationRows(reader, sessionId)
      );
      expect(wireVerdicts(after.map(storedRowToSyncItem))).toEqual(expected);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function wireVerdicts(
  rows: readonly { externalInvocationId: string; succeeded?: boolean }[]
): Map<string, boolean | undefined> {
  return new Map(
    rows.map((row) => [
      row.externalInvocationId,
      Object.hasOwn(row, "succeeded") ? row.succeeded : undefined,
    ])
  );
}

async function parseRollout(): Promise<NormalizedSession> {
  const lines = [
    JSON.stringify({
      type: "session_meta",
      timestamp: start,
      payload: { cwd: "/work" },
    }),
    JSON.stringify({
      type: "turn_context",
      timestamp: start,
      payload: { model: "gpt-5" },
    }),
    ...codexVerdicts.flatMap(([id, output], index) => [
      responseItem(index, {
        type: "function_call",
        name: "exec_command",
        arguments: "{}",
        call_id: id,
      }),
      responseItem(index, {
        type: "function_call_output",
        call_id: id,
        output,
      }),
    ]),
  ];
  const session = await parseCodexRollout(lines, { sessionId });
  if (!session) {
    throw new Error("the Codex rollout fixture did not parse");
  }
  return session;
}

function responseItem(
  second: number,
  payload: Record<string, unknown>
): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: `2026-08-01T10:00:0${second}.000Z`,
    payload,
  });
}
