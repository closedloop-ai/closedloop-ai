import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
  type AgentComponentInvocationSyncPart,
  agentComponentInvocationGenerationHashPreimage,
  agentComponentInvocationSyncPartHashPreimage,
} from "@repo/api/src/types/agent-component-invocation";
import { agentComponentInvocationSyncPartSchema } from "@repo/api/src/types/agent-component-invocation-schema";
import { afterEach, describe, it } from "vitest";
import { rewriteStoreCorpus } from "../scripts/vibe-profile/corpus-rewrite";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { insertSqliteSession } from "./sqlite-session-fixtures.js";

/**
 * ISS-12135: the invocations the vibe Desktop posts from its outbox name each
 * component the way the rewritten inventory does, and still carry generation
 * and part hashes the server accepts.
 */

const SESSION_ID = "session-with-invocations";
const SOURCE_KEY = "agent_component_invocations";
const CORPUS_TOOL = "mcp__closedloop__get-document";
const ACME_TOOL = "mcp__acme__get-document";
const INVOKED_AT = "2026-08-01T10:00:00.000Z";
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("rewriteStoreCorpus invocation outbox", () => {
  it("renames each invoked component and re-signs the generation, its parts and the cursor", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-outbox-rewrite-"));
    dirs.push(dir);
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "store"),
      detectBillingMode: () => "api",
    });
    try {
      await insertSqliteSession(db, SESSION_ID, {});
      const stale = signedParts([[item(0, CORPUS_TOOL)], [item(1, "Read")]]);
      for (const part of stale) {
        await db.run(
          `INSERT INTO agent_component_invocation_sync_outbox
             (source_key, external_session_id, external_generation_id, part_index,
              part_count, part_hash, source_updated_at, data_revision,
              source_sequence, payload, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 105, 0, $8, $7, $7)`,
          SOURCE_KEY,
          SESSION_ID,
          part.externalGenerationId,
          part.partIndex,
          part.partCount,
          part.partHash,
          INVOKED_AT,
          JSON.stringify(part)
        );
      }
      await db.run(
        `INSERT INTO agent_component_invocation_sync_cursors
           (source_key, external_session_id, external_generation_id, source_sequence, updated_at)
         VALUES ($1, $2, $3, 0, $4)`,
        SOURCE_KEY,
        SESSION_ID,
        stale[0]?.externalGenerationId,
        INVOKED_AT
      );

      await rewriteStoreCorpus(db);

      const rows = await db.prisma.client.$queryRawUnsafe<
        { generationId: string; partHash: string; payload: unknown }[]
      >(
        `SELECT external_generation_id AS "generationId", part_hash AS "partHash",
                payload AS "payload"
           FROM agent_component_invocation_sync_outbox ORDER BY part_index`
      );
      const parts = rows.map(
        (row): AgentComponentInvocationSyncPart =>
          agentComponentInvocationSyncPartSchema.parse(
            typeof row.payload === "string"
              ? JSON.parse(row.payload)
              : row.payload
          )
      );
      const expected = signedParts([[item(0, ACME_TOOL)], [item(1, "Read")]]);
      assert.deepEqual(
        parts.map((part) => part.items.map((entry) => entry.componentKey)),
        [[ACME_TOOL], ["Read"]]
      );
      assert.deepEqual(parts, expected);
      assert.deepEqual(
        rows.map(({ generationId, partHash }) => ({ generationId, partHash })),
        expected.map((part) => ({
          generationId: part.externalGenerationId,
          partHash: part.partHash,
        }))
      );
      assert.notEqual(
        expected[0]?.externalGenerationId,
        stale[0]?.externalGenerationId
      );
      const cursors = await db.prisma.client.$queryRawUnsafe<
        { generationId: string }[]
      >(
        'SELECT external_generation_id AS "generationId" FROM agent_component_invocation_sync_cursors'
      );
      assert.deepEqual(cursors, [
        { generationId: expected[0]?.externalGenerationId },
      ]);
    } finally {
      await db.close();
    }
  });
});

function item(
  sequence: number,
  componentKey: string
): AgentComponentInvocationSyncItem {
  return {
    externalInvocationId: `tool:${sequence}:${INVOKED_AT}`,
    sourceSessionId: SESSION_ID,
    kind: AgentComponentInvocationKind.Tool,
    componentKey,
    rawName: componentKey,
    normalizedName: componentKey,
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: INVOKED_AT,
    sequence,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Timestamp,
      timestamp: INVOKED_AT,
      ordinal: 0,
    },
    status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
  };
}

/** One generation of parts, signed the way Desktop's payload packer signs them. */
function signedParts(
  partItems: readonly AgentComponentInvocationSyncItem[][]
): AgentComponentInvocationSyncPart[] {
  const externalGenerationId = sha256Hex(
    agentComponentInvocationGenerationHashPreimage({
      externalSessionId: SESSION_ID,
      items: partItems.flat(),
    })
  );
  return partItems.map((items, partIndex) => {
    const withoutHash = {
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      externalSessionId: SESSION_ID,
      externalGenerationId,
      sourceUpdatedAt: INVOKED_AT,
      dataRevision: 105,
      sourceSequence: 0,
      partIndex,
      partCount: partItems.length,
      items,
    };
    return {
      ...withoutHash,
      partHash: sha256Hex(
        agentComponentInvocationSyncPartHashPreimage(withoutHash)
      ),
    };
  });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
