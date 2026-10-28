/**
 * ISS-12552: a Codex subagent's code-mode MCP calls fold into
 * the root session's `mcpCallEvidence`, owned by that subagent, the same way
 * its tool uses fold into `toolUses`.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { afterAll, test } from "vitest";
import { createCodexCollector } from "../src/main/collectors/codex/codex-collector.js";
import { PARSE_POLICY_BASE } from "../src/main/parse-policy/parse-policy.js";
import {
  CODEX_CHILD_UUID,
  CODEX_PARENT_UUID,
  codexSubagentMeta,
  minimalCodexRollout,
  writeCodexCollectorRollout,
} from "./codex-rollout-fixture.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";
import { withParsePolicy } from "./support/attribution-parse-policy.js";

afterAll(() => cleanupTempDirs());

const CHILD_TIMESTAMP = "2026-06-24T10:01:00.000Z";

function mcpToolCall(id: string, timestamp: string): unknown {
  return {
    type: "event_msg",
    timestamp,
    payload: {
      type: "item_completed",
      item: {
        type: "McpToolCall",
        id,
        server: "closedloop",
        tool: "get-document",
        arguments: { documentId: "PLN-2191" },
        status: "completed",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ id: "d1", slug: "PLN-2191" }),
            },
          ],
        },
      },
    },
  };
}

test("a child rollout's McpToolCall items fold into the root as that subagent's evidence", async () => {
  const root = makeTempDir("codex-mcp-evidence-");
  const parentPath = writeCodexCollectorRollout(root, CODEX_PARENT_UUID, [
    ...minimalCodexRollout(CODEX_PARENT_UUID, "2026-06-24T10:00:00.000Z", {
      input: 100,
      cached: 0,
      output: 10,
    }),
    mcpToolCall("exec-parent", "2026-06-24T10:00:05.000Z"),
  ]);
  const childPath = writeCodexCollectorRollout(
    root,
    CODEX_CHILD_UUID,
    [
      ...minimalCodexRollout(
        CODEX_CHILD_UUID,
        CHILD_TIMESTAMP,
        { input: 50, cached: 0, output: 5 },
        codexSubagentMeta(
          CHILD_TIMESTAMP,
          CODEX_CHILD_UUID,
          CODEX_PARENT_UUID,
          1
        )
      ),
      mcpToolCall("exec-child", "2026-06-24T10:01:05.000Z"),
    ],
    "2026-06-24T10-01-00"
  );
  const collector = createCodexCollector({
    sessionsDir: root,
    archivedDir: path.join(root, "archive"),
    listSources: () => [parentPath, childPath],
  });

  const [parent] = await collector.parse(parentPath);

  assert.deepEqual(
    (parent.mcpCallEvidence ?? []).map((call) => [
      call.providerToolUseId,
      call.subagentId,
    ]),
    [
      ["exec-parent", undefined],
      ["exec-child", CODEX_CHILD_UUID],
    ]
  );
  assert.equal(
    parent.toolUses.some((tool) => tool.mcpServer === "closedloop"),
    false,
    "code-mode MCP calls never enter the tool stream"
  );
});

test("no McpToolCall item is evidence with the attribution policy off", async () => {
  const root = makeTempDir("codex-mcp-evidence-");
  const parentPath = writeCodexCollectorRollout(root, CODEX_PARENT_UUID, [
    ...minimalCodexRollout(CODEX_PARENT_UUID, "2026-06-24T10:00:00.000Z", {
      input: 100,
      cached: 0,
      output: 10,
    }),
    mcpToolCall("exec-parent", "2026-06-24T10:00:05.000Z"),
  ]);
  const childPath = writeCodexCollectorRollout(
    root,
    CODEX_CHILD_UUID,
    [
      ...minimalCodexRollout(
        CODEX_CHILD_UUID,
        CHILD_TIMESTAMP,
        { input: 50, cached: 0, output: 5 },
        codexSubagentMeta(
          CHILD_TIMESTAMP,
          CODEX_CHILD_UUID,
          CODEX_PARENT_UUID,
          1
        )
      ),
      mcpToolCall("exec-child", "2026-06-24T10:01:05.000Z"),
    ],
    "2026-06-24T10-01-00"
  );
  const collector = createCodexCollector({
    sessionsDir: root,
    archivedDir: path.join(root, "archive"),
    listSources: () => [parentPath, childPath],
  });

  const [parent] = await withParsePolicy(PARSE_POLICY_BASE, () =>
    collector.parse(parentPath)
  );

  assert.ok(parent, "the parent rollout must still parse");
  assert.equal(parent.mcpCallEvidence, undefined);
});
