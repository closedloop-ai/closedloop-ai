import { createHash } from "node:crypto";
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
import { describe, expect, it } from "vitest";
import { rewriteInvocationOutbox } from "../scripts/vibe-profile/invocation-outbox-rewrite";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";

const SESSION_ID = "session-outbox";
const SOURCE_KEY = "agent_component_invocations";
const CORPUS_TOOL = "mcp__closedloop__get-document";
const ACME_TOOL = "mcp__acme__get-document";
const INVOKED_AT = "2026-08-01T10:00:00.000Z";

type Executed = { sql: string; params: unknown[] };

/**
 * A store stand-in: the raw read returns the given rows, and every write is
 * recorded. Lets a row's payload arrive already parsed, as Prisma hands back a
 * JSONB column, which the real SQLite raw read never does.
 */
function fakeDb(rows: unknown[]): {
  db: SqliteAgentDatabase;
  executed: Executed[];
} {
  const executed: Executed[] = [];
  const client = {
    $queryRawUnsafe: () => Promise.resolve(rows),
    $executeRawUnsafe: (sql: string, ...params: unknown[]) => {
      executed.push({ sql, params });
      return Promise.resolve(1);
    },
  };
  const db = {
    prisma: {
      client,
      write: (fn: (c: typeof client) => Promise<unknown>) => fn(client),
    },
  } as unknown as SqliteAgentDatabase;
  return { db, executed };
}

function outboxRow(rowid: number, part: AgentComponentInvocationSyncPart) {
  return {
    rowid,
    sourceKey: SOURCE_KEY,
    externalSessionId: SESSION_ID,
    externalGenerationId: part.externalGenerationId,
    partIndex: part.partIndex,
    payload: part,
  };
}

describe("rewriteInvocationOutbox", () => {
  it("re-signs a generation whose payload arrives already parsed, and moves its cursor", async () => {
    const [stale] = signedParts([[item(0, CORPUS_TOOL)]]);
    const [expected] = signedParts([[item(0, ACME_TOOL)]]);
    if (stale === undefined || expected === undefined) {
      throw new Error("fixture produced no part");
    }
    const { db, executed } = fakeDb([outboxRow(7, stale)]);

    expect(await rewriteInvocationOutbox(db)).toBe(1);

    expect(executed).toHaveLength(2);
    expect(executed[0]?.params).toEqual([
      expected.externalGenerationId,
      expected.partHash,
      JSON.stringify(expected),
      7,
    ]);
    expect(executed[1]?.params).toEqual([
      expected.externalGenerationId,
      SOURCE_KEY,
      SESSION_ID,
      stale.externalGenerationId,
    ]);
  });

  it("writes nothing for a generation whose names need no rewrite", async () => {
    const [part] = signedParts([[item(0, "Read")]]);
    if (part === undefined) {
      throw new Error("fixture produced no part");
    }
    const { db, executed } = fakeDb([
      { ...outboxRow(1, part), payload: JSON.stringify(part) },
    ]);

    expect(await rewriteInvocationOutbox(db)).toBe(0);
    expect(executed).toEqual([]);
  });

  it("renames only the name fields an item carries, leaving absent ones absent", async () => {
    const {
      rawName: _raw,
      normalizedName: _normalized,
      ...bare
    } = item(0, CORPUS_TOOL);
    const [stale] = signedParts([[bare]]);
    if (stale === undefined) {
      throw new Error("fixture produced no part");
    }
    const { db, executed } = fakeDb([outboxRow(1, stale)]);

    expect(await rewriteInvocationOutbox(db)).toBe(1);

    const written = JSON.parse(String(executed[0]?.params[2]));
    expect(written.items).toEqual([{ ...bare, componentKey: ACME_TOOL }]);
  });

  it("returns zero on an empty outbox", async () => {
    const { db, executed } = fakeDb([]);

    expect(await rewriteInvocationOutbox(db)).toBe(0);
    expect(executed).toEqual([]);
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
