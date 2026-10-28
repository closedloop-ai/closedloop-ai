import { rm } from "node:fs/promises";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_TOOL_OUTCOME_PROTOCOL_VERSION,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import { Harness } from "../src/main/collectors/types.js";
import { toLocalInvocationReadRow } from "../src/main/dashboard/local-invocation-read.js";
import {
  readStoredInvocationRows,
  storedRowToSyncItem,
} from "../src/main/database/component-invocation-sync-item.js";
import { readSessionInvocationTree } from "../src/main/database/session-invocation-tree-read.js";
import {
  makeInvocationSyncDir,
  openDb,
} from "./helpers/invocation-sync-fixtures.js";
import { staleRebuildFromStoredRows } from "./helpers/stored-rebuild.js";
import { makeSession } from "./normalized-session-test-utils.js";

const start = "2026-07-22T17:00:00.000Z";
const end = "2026-07-22T17:00:10.000Z";
const sessionId = "measured-duration-session";

describe("invocation duration through real SQLite storage", () => {
  it.each([start, "2026-07-22T17:00:02.000Z"])(
    "keeps contradictory call identities starting at %s unknown through reimport and stored-only rebuild",
    async (conflictingStart) => {
      const dir = await makeInvocationSyncDir("ambiguous-duration-");
      const db = await openDb(dir);
      const firstCall = {
        id: "same",
        name: "Read",
        timestamp: start,
        resultTimestamp: end,
      };
      const conflictingCall = {
        ...firstCall,
        timestamp: conflictingStart,
        resultTimestamp: "2026-07-22T17:00:12.000Z",
      };
      const read = async () => {
        const rows = await db.prisma.read((reader) =>
          readStoredInvocationRows(reader, sessionId)
        );
        return rows
          .map(storedRowToSyncItem)
          .find((row) => row.externalInvocationId === "same");
      };
      try {
        await db.importer.importSession(
          makeSession({ sessionId, toolUses: [firstCall] }),
          Harness.Claude
        );
        expect(await read()).toMatchObject({ durationMs: 10_000 });
        await db.importer.importSession(
          makeSession({ sessionId, toolUses: [firstCall, conflictingCall] }),
          Harness.Claude
        );
        const imported = await read();
        expect(imported).toBeDefined();
        expect(imported).not.toHaveProperty("durationMs");
        expect((await staleRebuildFromStoredRows(db, sessionId)).rebuilt).toBe(
          true
        );
        const rebuilt = await read();
        expect(rebuilt).toBeDefined();
        expect(rebuilt).not.toHaveProperty("durationMs");
        if (conflictingStart === start) {
          // Same-start results share one stored event, so the durable marker
          // is the only witness left; it is exercised above.
          return;
        }
        // whitlockk on #8910: different-start events both survive in storage, and
        // they alone must keep the call unmeasured on a stored-only rebuild.
        await db.run(
          "UPDATE agent_component_invocations SET duration_ambiguous = 0, duration_ms = NULL WHERE session_id = $1",
          sessionId
        );
        expect((await staleRebuildFromStoredRows(db, sessionId)).rebuilt).toBe(
          true
        );
        expect(await read()).not.toHaveProperty("durationMs");
      } finally {
        await db.close();
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it("drops only an out-of-order call's duration, reports it, and keeps the rest of the set", async () => {
    const dir = await makeInvocationSyncDir("refused-duration-");
    const logged: string[] = [];
    const db = await openDb(dir, (message) => logged.push(message));
    const read = async () => {
      const rows = await db.prisma.read((reader) =>
        readStoredInvocationRows(reader, sessionId)
      );
      return rows.map(storedRowToSyncItem);
    };
    try {
      await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: start,
          endedAt: end,
          toolUses: [
            {
              id: "timed",
              name: "Read",
              timestamp: start,
              resultTimestamp: end,
            },
            {
              id: "backwards",
              name: "Read",
              timestamp: end,
              resultTimestamp: start,
            },
          ],
        }),
        Harness.Claude
      );
      const imported = await read();
      expect(
        imported.find((row) => row.externalInvocationId === "timed")
      ).toMatchObject({ durationMs: 10_000 });
      const backwards = imported.find(
        (row) => row.externalInvocationId === "backwards"
      );
      expect(backwards).toBeDefined();
      expect(backwards).not.toHaveProperty("durationMs");
      expect(
        logged.filter((message) =>
          message.includes("withheld measured duration on 1 row(s)")
        )
      ).toHaveLength(1);

      expect((await staleRebuildFromStoredRows(db, sessionId)).rebuilt).toBe(
        true
      );
      const rebuilt = await read();
      expect(
        rebuilt.find((row) => row.externalInvocationId === "timed")
      ).toMatchObject({ durationMs: 10_000 });
      expect(
        rebuilt.find((row) => row.externalInvocationId === "backwards")
      ).not.toHaveProperty("durationMs");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers subagent timing from durable spawn events and preserves its aligned start", async () => {
    const dir = await makeInvocationSyncDir("subagent-duration-");
    const db = await openDb(dir);
    const childStart = "2026-07-22T17:00:02.000Z";
    try {
      await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: start,
          endedAt: end,
          toolUses: [
            {
              id: "spawn",
              name: "Agent",
              timestamp: start,
              resultTimestamp: end,
              input: { subagent_type: "reviewer" },
            },
          ],
          subagents: [
            {
              id: "child",
              type: "reviewer",
              name: "reviewer",
              startedAt: childStart,
              endedAt: end,
              metadata: { spawnedByToolUseId: "spawn" },
            },
          ],
        }),
        Harness.Claude
      );
      const child = async () => {
        const stored = await db.prisma.read((reader) =>
          readStoredInvocationRows(reader, sessionId)
        );
        return stored
          .map(storedRowToSyncItem)
          .find((row) => row.kind === AgentComponentInvocationKind.Subagent);
      };
      expect(await child()).toMatchObject({
        invokedAt: start,
        durationMs: 10_000,
      });
      // Simulate an older invocation row: the durable spawn event alone is
      // enough to recover timing even after the transcript has rotated away.
      await db.run(
        "UPDATE agent_component_invocations SET duration_ms = NULL, invoked_at = $1 WHERE session_id = $2",
        childStart,
        sessionId
      );
      expect((await staleRebuildFromStoredRows(db, sessionId)).rebuilt).toBe(
        true
      );
      expect(await child()).toMatchObject({
        invokedAt: start,
        durationMs: 10_000,
      });
      await db.run(
        "UPDATE events SET data = json_remove(data, '$.resultTimestamp') WHERE session_id = $1",
        sessionId
      );
      expect((await staleRebuildFromStoredRows(db, sessionId)).rebuilt).toBe(
        true
      );
      expect(await child()).toMatchObject({
        invokedAt: start,
        durationMs: 10_000,
      });
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("migrates, imports, reads and rebuilds measured, zero and unknown durations", async () => {
    const dir = await makeInvocationSyncDir("measured-invocation-");
    const db = await openDb(dir);
    try {
      await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: start,
          endedAt: end,
          toolUses: [
            {
              id: "timed",
              name: "Read",
              timestamp: start,
              resultTimestamp: end,
            },
            {
              id: "zero",
              name: "Read",
              timestamp: start,
              resultTimestamp: start,
            },
            { id: "point", name: "Read", timestamp: start },
          ],
        }),
        Harness.Claude
      );

      const read = await readSessionInvocationTree(db.prisma, { sessionId });
      expect(read?.total).toBe(3);
      const rows =
        read?.rows.map((row) => toLocalInvocationReadRow(row, new Map())) ?? [];
      expect(
        rows.find((row) => row.externalInvocationId === "timed")?.durationMs
      ).toBe(10_000);
      expect(
        rows.find((row) => row.externalInvocationId === "zero")?.durationMs
      ).toBe(0);
      expect(
        rows.find((row) => row.externalInvocationId === "point")
      ).not.toHaveProperty("durationMs");

      const stored = await db.prisma.read((reader) =>
        readStoredInvocationRows(reader, sessionId)
      );
      const wire = stored.map(storedRowToSyncItem);
      expect(
        wire.find((row) => row.externalInvocationId === "timed")?.durationMs
      ).toBe(10_000);
      expect(
        wire.find((row) => row.externalInvocationId === "zero")?.durationMs
      ).toBe(0);
      const parts =
        await db.prisma.client.agentComponentInvocationSyncOutbox.findMany();
      expect(parts.length).toBeGreaterThan(0);
      // A measured call has a result, so it also carries the result's verdict,
      // and the part declares the highest version any of its fields needs.
      expect(
        wire.find((row) => row.externalInvocationId === "timed")?.succeeded
      ).toBe(true);
      expect(parts[0]?.payload).toMatchObject({
        protocolVersion:
          AGENT_COMPONENT_INVOCATION_SYNC_TOOL_OUTCOME_PROTOCOL_VERSION,
      });

      // Lose result evidence from the retained event: rebuild must preserve the
      // prior measurement rather than erase it when the transcript is gone.
      await db.run(
        "UPDATE events SET data = json_remove(data, '$.resultTimestamp') WHERE session_id = $1",
        sessionId
      );
      const rebuilt = await staleRebuildFromStoredRows(db, sessionId);
      expect(rebuilt.rebuilt).toBe(true);
      const after = await db.prisma.read((reader) =>
        readStoredInvocationRows(reader, sessionId)
      );
      expect(
        after
          .map(storedRowToSyncItem)
          .find((row) => row.externalInvocationId === "timed")?.durationMs
      ).toBe(10_000);

      // The migration refuses corrupt durations even outside the importer.
      await expect(
        db.run(
          "UPDATE agent_component_invocations SET duration_ms = -1 WHERE session_id = $1",
          sessionId
        )
      ).rejects.toThrow();
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
