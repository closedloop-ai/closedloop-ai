/**
 * ISS-7795: the producer round-trip — a real Claude transcript carrying the
 * harness's per-turn `attributionSkill` stamp, through the parser and the
 * materializer, to NON-NULL telemetry columns on `agent_component_invocations`
 * and out again as a labelled wire item.
 *
 * The assertion is deliberately on the STORED VALUE, not on the producer being
 * called. Every column here was NULL in production before this change while the
 * whole pipeline below already existed, so a test that only proved the
 * materializer ran would have passed against the exact bug being fixed.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentComponentInvocationUsageMeasurement } from "@repo/api/src/types/agent-component-invocation";
import { parseClaudeTranscript } from "@repo/lib/harness/claude/parse-claude";
import { describe, test } from "vitest";
import {
  readStoredInvocationRows,
  storedRowToSyncItem,
} from "../src/main/database/component-invocation-sync-item.js";
import { type Db, openDb } from "./helpers/invocation-sync-fixtures.js";
import { staleRebuildFromStoredRows } from "./helpers/stored-rebuild.js";

const SESSION_ID = "iss7795-roundtrip";

/**
 * Two turns: the one that OPENS the skill (not yet attributed to it) and the
 * one the harness stamps for it. Shaped exactly like a real record — the
 * counters live under `message.usage` with Anthropic's own key spelling.
 */
function transcriptLines(): string[] {
  return [
    JSON.stringify({
      type: "assistant",
      uuid: "00000000-0000-4000-8000-0000000000a1",
      timestamp: "2026-08-23T09:00:00.000Z",
      requestId: "req_open",
      message: {
        id: "msg_open",
        model: "claude-opus-4-8",
        content: [
          // A non-Skill tool so the session also produces a `tool`-kind row.
          // `toolCandidates` skips `Skill` outright, so without this the
          // unmeasured-kind case below would iterate an empty set and assert
          // nothing.
          { type: "tool_use", id: "toolu_plain_read", name: "Read", input: {} },
          {
            type: "tool_use",
            id: "toolu_measured_skill",
            name: "Skill",
            input: { skill: "code-review" },
          },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 22,
          cache_read_input_tokens: 33,
          cache_creation_input_tokens: 44,
        },
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "00000000-0000-4000-8000-0000000000a2",
      timestamp: "2026-08-23T09:00:05.000Z",
      requestId: "req_body",
      attributionSkill: "code-review",
      message: {
        id: "msg_body",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "reviewing" }],
        usage: {
          input_tokens: 7,
          output_tokens: 13,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 5,
        },
      },
    }),
  ];
}

type StoredTelemetry = {
  component_key: string;
  model: string | null;
  input_tokens: bigint | null;
  output_tokens: bigint | null;
  cache_read_tokens: bigint | null;
  cache_write_tokens: bigint | null;
  usage_measurement: string | null;
};

async function materializeTranscript(db: Db): Promise<void> {
  const session = await parseClaudeTranscript(transcriptLines(), {
    sessionId: SESSION_ID,
  });
  if (!session) {
    throw new Error("fixture must parse into a session");
  }
  // The production import path, not a hand-built row: it writes the session, its
  // events and its invocations together, which is what the stored-row rebuild
  // below needs to reconstruct from.
  await db.importer.importSession(session, "claude");
}

describe("ISS-7795 measured usage reaches the store and the wire", () => {
  test("persists the harness-reported counts on the skill row", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7795-roundtrip-"));
    const db = await openDb(dir);
    try {
      await materializeTranscript(db);

      const rows = await db.prisma.read((reader) =>
        reader.$queryRawUnsafe<StoredTelemetry[]>(
          `SELECT component_key, model, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens, usage_measurement
             FROM agent_component_invocations
            WHERE session_id = $1 AND component_kind = 'skill'`,
          SESSION_ID
        )
      );
      const stored = rows.find((row) => row.component_key === "code-review");

      // The literals are the second turn's counters, chosen when the fixture was
      // written. They are NOT the sum of both turns: the opening turn belongs to
      // whatever ran before the skill, and charging it here would be the
      // over-attribution this producer exists to avoid.
      assert.ok(stored, "the skill invocation must be persisted");
      assert.equal(stored.model, "claude-opus-4-8");
      assert.equal(stored.input_tokens, 7n);
      assert.equal(stored.output_tokens, 13n);
      assert.equal(stored.cache_read_tokens, 100n);
      assert.equal(stored.cache_write_tokens, 5n);
      assert.equal(
        stored.usage_measurement,
        AgentComponentInvocationUsageMeasurement.Measured
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("projects the stored row onto the wire with its measurement label", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7795-wire-"));
    const db = await openDb(dir);
    try {
      await materializeTranscript(db);

      const rows = await db.prisma.read((reader) =>
        readStoredInvocationRows(reader, SESSION_ID)
      );
      const skill = rows.find((row) => row.component_kind === "skill");
      assert.ok(skill, "the skill row must be readable for sync");
      const item = storedRowToSyncItem(skill);

      // The kind gate used to drop all of this on anything but `subagent`, so a
      // skill row reaching the wire WITH its counts is the widening working.
      assert.equal(item.model, "claude-opus-4-8");
      assert.equal(item.inputTokens, 7);
      assert.equal(item.outputTokens, 13);
      assert.equal(item.cacheReadTokens, 100);
      assert.equal(item.cacheWriteTokens, 5);
      assert.equal(
        item.usageMeasurement,
        AgentComponentInvocationUsageMeasurement.Measured
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The rebuild bridge deletes and re-inserts a session's whole invocation set
   * from stored rows, and it cannot measure — the per-turn attribution stamp
   * lives only in the transcript. Without the carry-forward, the first rebuild
   * after a transcript rotates away replaces real counts with NULL, and NULL is
   * the value that means "never measured": the erasure would be indistinguishable
   * from an invocation nothing ever measured.
   */
  test("keeps measured telemetry across a stored-row rebuild", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7795-rebuild-"));
    const db = await openDb(dir);
    try {
      await materializeTranscript(db);
      await staleRebuildFromStoredRows(db, SESSION_ID);

      const rows = await db.prisma.read((reader) =>
        reader.$queryRawUnsafe<StoredTelemetry[]>(
          `SELECT component_key, model, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens, usage_measurement
             FROM agent_component_invocations
            WHERE session_id = $1 AND component_kind = 'skill'`,
          SESSION_ID
        )
      );
      const stored = rows.find((row) => row.component_key === "code-review");

      assert.ok(stored, "the skill invocation must survive the rebuild");
      assert.equal(stored.input_tokens, 7n);
      assert.equal(stored.model, "claude-opus-4-8");
      assert.equal(
        stored.usage_measurement,
        AgentComponentInvocationUsageMeasurement.Measured
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("leaves an unmeasured kind's telemetry NULL and unlabelled", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss7795-null-"));
    const db = await openDb(dir);
    try {
      await materializeTranscript(db);

      const rows = await db.prisma.read((reader) =>
        reader.$queryRawUnsafe<StoredTelemetry[]>(
          `SELECT component_key, model, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens, usage_measurement
             FROM agent_component_invocations
            WHERE session_id = $1 AND component_kind = 'tool'`,
          SESSION_ID
        )
      );

      // Sibling of the positive assertions above, in the opposite state: the
      // same store, the same pass, a kind nothing measures. NULL here is the
      // producer declining to invent a number, and its coexistence with the
      // populated skill row is what proves the columns are not simply unwritten.
      // The count guard is load-bearing — an empty result set would make every
      // assertion below vacuous and the case would pass against any mutation.
      assert.ok(
        rows.length > 0,
        "the fixture must produce at least one unmeasured-kind row"
      );
      for (const row of rows) {
        assert.equal(row.model, null);
        assert.equal(row.input_tokens, null);
        assert.equal(row.usage_measurement, null);
      }
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * ISS-10725 review (tamsinb): the findings half of the same erasure ISS-7795
 * had to come back and fix for telemetry.
 *
 * Nothing attributes a funnel on this diff, so the write is made here the way an
 * attributor will make it — straight onto the stored row — and the assertion is
 * on the value AFTER the transcript-less rebuild bridge has deleted and
 * re-inserted the session's whole invocation set. Without
 * `preserveMeasuredFindings` the ON CONFLICT `findings_emitted =
 * excluded.findings_emitted` writes NULL back over it, which is the value that
 * means "nothing ever measured this".
 */
describe("ISS-10725 a stored findings funnel survives a stored-row rebuild", () => {
  test("keeps an attributed funnel, measured zero included", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss10725-rebuild-"));
    const db = await openDb(dir);
    try {
      await materializeTranscript(db);
      await db.run(
        `UPDATE agent_component_invocations
            SET findings_emitted = 6, findings_invalidated = 0
          WHERE session_id = $1 AND component_key = 'code-review'`,
        SESSION_ID
      );

      await staleRebuildFromStoredRows(db, SESSION_ID);

      const rows = await db.prisma.read((reader) =>
        reader.$queryRawUnsafe<StoredFindings[]>(
          `SELECT component_key, findings_emitted, findings_invalidated
             FROM agent_component_invocations
            WHERE session_id = $1 AND component_kind = 'skill'`,
          SESSION_ID
        )
      );
      const stored = rows.find((row) => row.component_key === "code-review");

      assert.ok(stored, "the skill invocation must survive the rebuild");
      assert.equal(stored.findings_emitted, 6n);
      // A measured ZERO is the case a truthiness-based carry-forward would drop.
      assert.equal(stored.findings_invalidated, 0n);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

type StoredFindings = {
  component_key: string;
  findings_emitted: bigint | null;
  findings_invalidated: bigint | null;
};
