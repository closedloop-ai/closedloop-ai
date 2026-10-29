import { rm } from "node:fs/promises";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SUCCEEDED_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_TOOL_OUTCOME_PROTOCOL_VERSION,
  AgentComponentInvocationKind,
  agentComponentInvocationSyncProtocolVersionForItems,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import { Harness } from "../src/main/collectors/types.js";
import { toLocalInvocationReadRow } from "../src/main/dashboard/local-invocation-read.js";
import {
  readStoredInvocationRows,
  storedRowToSyncItem,
} from "../src/main/database/component-invocation-sync-item.js";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import { readSessionInvocationTree } from "../src/main/database/session-invocation-tree-read.js";
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

const start = "2026-07-22T17:00:00.000Z";
const end = "2026-07-22T17:00:01.000Z";
const sessionId = "tool-outcome-session";

const toolUses = [
  { id: "denied", name: "Bash", timestamp: start, isError: true },
  { id: "ok", name: "Bash", timestamp: start, resultTimestamp: end },
  {
    id: "mcp-denied",
    name: "mcp__linear__get_issue",
    timestamp: start,
    isError: true,
  },
  { id: "pending", name: "Write", timestamp: start },
];

const expected = new Map<string, boolean | undefined>([
  ["denied", false],
  ["ok", true],
  ["mcp-denied", false],
  ["pending", undefined],
]);

function verdicts(
  rows: readonly { externalInvocationId: string; succeeded?: boolean }[]
): Map<string, boolean | undefined> {
  return new Map(
    rows.map((row) => [
      row.externalInvocationId,
      Object.hasOwn(row, "succeeded") ? row.succeeded : undefined,
    ])
  );
}

describe("tool result outcome", () => {
  it("reads a verdict only once a result exists", () => {
    expect(toolUseSucceeded({ isError: true }, Harness.Claude)).toBe(false);
    expect(toolUseSucceeded({ isError: false }, Harness.Claude)).toBe(true);
    expect(toolUseSucceeded({ output: "done" }, Harness.Claude)).toBe(true);
    expect(toolUseSucceeded({ resultTimestamp: end }, Harness.Claude)).toBe(
      true
    );
    expect(toolUseSucceeded({}, Harness.Claude)).toBeNull();
    expect(
      storedToolResultSucceeded(
        AgentComponentInvocationKind.Tool,
        {
          isError: true,
        },
        Harness.Claude
      )
    ).toBe(false);
    expect(
      storedToolResultSucceeded(
        AgentComponentInvocationKind.Tool,
        {
          isError: false,
        },
        Harness.Claude
      )
    ).toBe(true);
    expect(
      storedToolResultSucceeded(
        AgentComponentInvocationKind.Tool,
        {},
        Harness.Claude
      )
    ).toBeNull();
    expect(
      storedToolResultSucceeded(
        AgentComponentInvocationKind.Tool,
        {
          isError: 1,
        },
        Harness.Claude
      )
    ).toBeNull();
    expect(
      storedToolResultSucceeded(
        AgentComponentInvocationKind.Mcp,
        null,
        Harness.Claude
      )
    ).toBeNull();
    expect(
      storedToolResultSucceeded(
        AgentComponentInvocationKind.Skill,
        {
          isError: true,
        },
        Harness.Claude
      )
    ).toBeNull();
  });

  it("stamps the verdict on every derived tool candidate", () => {
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({ sessionId, startedAt: start, toolUses }),
      "main-agent",
      end,
      Harness.Claude
    );
    const byId = new Map(
      candidates.map((candidate) => [
        candidate.externalInvocationId,
        candidate.succeeded,
      ])
    );
    for (const [id, succeeded] of expected) {
      expect(byId.get(id), id).toBe(succeeded ?? null);
    }
  });

  it("carries the verdict through storage, sync, the local read and a stored-only rebuild", async () => {
    const dir = await makeInvocationSyncDir("tool-outcome-");
    const db = await openDb(dir);
    try {
      await db.importer.importSession(
        makeSession({ sessionId, startedAt: start, endedAt: end, toolUses }),
        Harness.Claude
      );

      const tree = await readSessionInvocationTree(db.prisma, { sessionId });
      const local =
        tree?.rows.map((row) => toLocalInvocationReadRow(row, new Map())) ?? [];
      expect(verdicts(local)).toEqual(expected);

      const stored = await db.prisma.read((reader) =>
        readStoredInvocationRows(reader, sessionId)
      );
      const wire = stored.map(storedRowToSyncItem);
      expect(verdicts(wire)).toEqual(expected);
      expect(agentComponentInvocationSyncProtocolVersionForItems(wire)).toBe(
        AGENT_COMPONENT_INVOCATION_SYNC_TOOL_OUTCOME_PROTOCOL_VERSION
      );
      const parts =
        await db.prisma.client.agentComponentInvocationSyncOutbox.findMany();
      expect(parts.length).toBeGreaterThan(0);
      for (const part of parts) {
        expect(part.payload).toMatchObject({
          protocolVersion:
            AGENT_COMPONENT_INVOCATION_SYNC_TOOL_OUTCOME_PROTOCOL_VERSION,
        });
      }

      const rebuilt = await staleRebuildFromStoredRows(db, sessionId);
      expect(rebuilt.rebuilt).toBe(true);
      const after = await db.prisma.read((reader) =>
        readStoredInvocationRows(reader, sessionId)
      );
      expect(verdicts(after.map(storedRowToSyncItem))).toEqual(expected);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves a part with no tool verdict on its prior version", () => {
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        { kind: AgentComponentInvocationKind.Hook, succeeded: false },
      ])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_SUCCEEDED_PROTOCOL_VERSION);
  });
});
