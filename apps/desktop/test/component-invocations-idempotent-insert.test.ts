/**
 * FEA-4160 regression: the component_invocations import must be idempotent and
 * never abort a session with SQLITE_CONSTRAINT 2067.
 *
 * Root cause: insertInvocationRows was a plain batched INSERT with no ON
 * CONFLICT, and a candidate batch can contain two rows sharing an
 * external_invocation_id for a session (an upstream subagent parent-linking /
 * evidence-merge collision, or a post-dedupe id remap in
 * restoreStableInvocationIdentities). The second row violated
 * UNIQUE(session_id, external_invocation_id), the raw INSERT threw, and the
 * whole session import transaction aborted.
 *
 * These tests assert the boundary fixes behaviorally:
 *  (1) a duplicate external_invocation_id in the batch is merged and imports
 *      without throwing;
 *  (2) re-running the same batch (the DELETE+insert re-import shape) is
 *      idempotent via ON CONFLICT DO UPDATE;
 *  (3) re-importing a session through the real importer converges;
 *  (4) the collision runs through the production materializer
 *      (materializeAgentComponentInvocations — the same path db.importer
 *      .importSession uses, reading prior evidence and running the remap
 *      before the insert), stays contained, persists the surviving row, and
 *      does not abort the following session; and
 *  (5) the merge itself (mergeInvocationRowsByExternalId) preserves the
 *      stronger-evidence candidate's identity/evidence on a remap collision
 *      instead of silently dropping it (the codex-P1 data-loss case).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import type { AgentComponentInvocationCandidate } from "../src/main/database/component-invocation-row-writer.js";
import {
  insertInvocationRows,
  mergeInvocationRowsByExternalId,
} from "../src/main/database/component-invocation-row-writer.js";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeSession } from "./normalized-session-test-utils.js";
import { ROLLUP_OPTS } from "./rollup-options-test-utils.js";

const NOW = "2026-07-22T17:00:00.000Z";
const MAIN_AGENT_ID = "main-agent";
/* ISS-5098: the writer's reporter is required; this suite is about ON CONFLICT
   convergence, not reporting, and every candidate it inserts has a null agent
   reference, so nothing here can produce a report. */
const REPORT = ROLLUP_OPTS.log;

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

function openDb(dir: string): Promise<Db> {
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
}

function toolSession(sessionId: string): ReturnType<typeof makeSession> {
  return makeSession({
    sessionId,
    startedAt: NOW,
    endedAt: "2026-07-22T17:05:00.000Z",
    toolUses: [
      {
        id: "toolu_read_1",
        providerToolUseId: "toolu_read_1",
        name: "Read",
        kind: "builtin",
        timestamp: "2026-07-22T17:00:01.000Z",
      },
    ],
  });
}

function invocationRows(
  db: Db,
  sessionId: string
): Promise<
  { external_invocation_id: string; component_key: string; sequence: number }[]
> {
  return db.prisma.client.$queryRawUnsafe<
    {
      external_invocation_id: string;
      component_key: string;
      sequence: number;
    }[]
  >(
    `SELECT external_invocation_id, component_key, sequence
       FROM agent_component_invocations
      WHERE session_id = $1
      ORDER BY sequence`,
    sessionId
  );
}

describe("FEA-4160 idempotent component_invocations insert", () => {
  test("a batch with a duplicate external_invocation_id imports without throwing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-4160-dup-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-4160-dup-batch";
      // Import once so the parent sessions row exists, then clear derived rows
      // so we can drive the raw insert boundary with a hand-built batch.
      await db.importer.importSession(toolSession(sessionId), "claude");
      await db.run(
        "DELETE FROM agent_component_invocations WHERE session_id = $1",
        sessionId
      );

      const candidates = deriveAgentComponentInvocationCandidates(
        toolSession(sessionId),
        MAIN_AGENT_ID,
        NOW
      );
      assert.equal(candidates.length, 1);
      const original = candidates[0];
      assert.ok(original);
      // Fabricate the exact 2067 scenario: a second candidate sharing the same
      // (session_id, external_invocation_id). Null the optional FK links so the
      // test targets the unique-constraint boundary, not component wiring. The
      // duplicate carries a distinct component_key at EQUAL evidence, so the
      // merge keeps the primary (equal-evidence stays first-wins).
      const duplicate = {
        ...original,
        componentKey: "second-collision",
        agentId: null,
        parentAgentId: null,
        localComponentId: null,
        localComponentVersionId: null,
        sequence: 1,
      };
      const primary = {
        ...original,
        agentId: null,
        parentAgentId: null,
        localComponentId: null,
        localComponentVersionId: null,
      };

      // The pre-fix raw INSERT would throw SQLITE_CONSTRAINT 2067 here.
      await db.prisma.write((client) =>
        insertInvocationRows(client, sessionId, [primary, duplicate], REPORT)
      );

      const rows = await invocationRows(db, sessionId);
      // Merge (equal evidence -> first-wins): one row, the primary's key.
      assert.equal(rows.length, 1);
      assert.equal(
        rows[0]?.external_invocation_id,
        original.externalInvocationId
      );
      assert.equal(rows[0]?.component_key, original.componentKey);
      assert.equal(rows[0]?.sequence, 0);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-running the same batch (DELETE+insert re-import) is idempotent via ON CONFLICT", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-4160-reinsert-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-4160-reinsert";
      await db.importer.importSession(toolSession(sessionId), "claude");
      await db.run(
        "DELETE FROM agent_component_invocations WHERE session_id = $1",
        sessionId
      );

      const candidates = deriveAgentComponentInvocationCandidates(
        toolSession(sessionId),
        MAIN_AGENT_ID,
        NOW
      ).map((candidate) => ({
        ...candidate,
        agentId: null,
        parentAgentId: null,
        localComponentId: null,
        localComponentVersionId: null,
      }));

      await db.prisma.write((client) =>
        insertInvocationRows(client, sessionId, candidates, REPORT)
      );
      const first = await invocationRows(db, sessionId);
      assert.equal(first.length, 1);

      // Insert the SAME batch again WITHOUT a DELETE. Without ON CONFLICT this
      // would throw 2067; with it the row converges (idempotent replay).
      await db.prisma.write((client) =>
        insertInvocationRows(client, sessionId, candidates, REPORT)
      );
      const second = await invocationRows(db, sessionId);
      assert.deepEqual(second, first);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-importing a session through the importer is idempotent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-4160-reimport-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-4160-reimport";
      const session = toolSession(sessionId);
      const first = await db.importer.importSession(session, "claude");
      assert.equal(first.incomplete, undefined);
      const before = await invocationRows(db, sessionId);
      assert.equal(before.length, 1);

      const second = await db.importer.importSession(session, "claude");
      assert.equal(second.incomplete, undefined);
      const after = await invocationRows(db, sessionId);
      assert.deepEqual(after, before);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-importing a session through the importer against its own prior evidence stays contained and does not abort the following session", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-4160-contained-"));
    const db = await openDb(dir);
    try {
      // Drive the collision through the REAL importer (db.importer.importSession,
      // which runs materializeAgentComponentInvocations: it reads prior PERSISTED
      // evidence, runs restoreStableInvocationIdentities +
      // linkSubagentParentExternalInvocations against those prior rows, then
      // insertInvocationRows) — NOT a hand-built insertInvocationRows call. The
      // second import re-materializes against the first import's persisted rows,
      // the exact prior-evidence remap path that produced the SQLITE_CONSTRAINT
      // 2067 abort in the field; it must converge and, critically, must not
      // abort the FOLLOWING session's import in the same pass.
      const poisonId = "session-4160-poison";
      const session = toolSession(poisonId);
      const firstResult = await db.importer.importSession(session, "claude");
      assert.equal(firstResult.incomplete, undefined);
      const persisted = await invocationRows(db, poisonId);
      assert.equal(persisted.length, 1);

      const secondResult = await db.importer.importSession(session, "claude");
      assert.equal(secondResult.incomplete, undefined);
      // Contained + idempotent: the session holds exactly the same surviving row.
      const afterPoison = await invocationRows(db, poisonId);
      assert.deepEqual(afterPoison, persisted);

      // The following session in the same pass still imports cleanly, proving
      // one session's re-materialization can never crash the whole import pass.
      const nextId = "session-4160-next";
      const next = await db.importer.importSession(
        toolSession(nextId),
        "claude"
      );
      assert.equal(next.incomplete, undefined);
      assert.equal((await invocationRows(db, nextId)).length, 1);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("mergeInvocationRowsByExternalId preserves the stronger-evidence candidate on a remap collision", () => {
    // codex-P1: when a remap lands two DISTINCT candidates on one
    // external_invocation_id, the merge must keep the stronger-evidence
    // candidate's component identity/evidence rather than dropping it at the
    // insert boundary. Build a base candidate, then a stronger sibling remapped
    // onto the same id carrying a different component key + stronger evidence.
    const base = baseTestCandidate({
      externalInvocationId: "remapped-id",
      componentKey: "weak-key",
      evidenceClass: AgentComponentInvocationEvidenceClass.PackMembership,
    });
    const stronger = baseTestCandidate({
      externalInvocationId: "remapped-id",
      componentKey: "strong-key",
      evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
      definitionHash: "hash-strong",
      definitionContent: "# strong definition",
    });

    const merged = mergeInvocationRowsByExternalId([base, stronger]);

    assert.equal(merged.length, 1);
    const survivor = merged[0];
    assert.ok(survivor);
    // The surviving row carries the STRONGER candidate's identity + evidence,
    // not the first-seen weak one — the distinct component key is not lost.
    assert.equal(survivor.componentKey, "strong-key");
    assert.equal(
      survivor.evidenceClass,
      AgentComponentInvocationEvidenceClass.TranscriptSnapshot
    );
    assert.equal(survivor.definitionHash, "hash-strong");
    assert.equal(survivor.definitionContent, "# strong definition");
    assert.equal(survivor.sequence, 0);
  });

  test("mergeInvocationRowsByExternalId keeps first-wins when the collision is equal-or-weaker evidence", () => {
    const primary = baseTestCandidate({
      externalInvocationId: "remapped-id",
      componentKey: "primary-key",
      evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
      definitionHash: "hash-primary",
    });
    const weaker = baseTestCandidate({
      externalInvocationId: "remapped-id",
      componentKey: "weaker-key",
      evidenceClass: AgentComponentInvocationEvidenceClass.PackMembership,
    });

    const merged = mergeInvocationRowsByExternalId([primary, weaker]);

    assert.equal(merged.length, 1);
    // The weaker collision does not clobber the primary's identity/evidence.
    assert.equal(merged[0]?.componentKey, "primary-key");
    assert.equal(merged[0]?.definitionHash, "hash-primary");
  });
});

function baseTestCandidate(
  overrides: Partial<AgentComponentInvocationCandidate> &
    Pick<AgentComponentInvocationCandidate, "externalInvocationId">
): AgentComponentInvocationCandidate {
  return {
    externalSourceId: null,
    childSessionId: null,
    agentId: null,
    parentAgentId: null,
    componentKind: AgentComponentInvocationKind.Tool,
    componentKey: "component",
    rawName: "Read",
    normalizedName: "Read",
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: NOW,
    sourceOrder: 0,
    sequence: 0,
    anchorKind: AgentComponentInvocationAnchorKind.Timestamp,
    anchorValue: "anchor",
    providerToolUseId: null,
    attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.PackMembership,
    evidencePointer: null,
    definitionHash: null,
    normalizerContractVersion: null,
    definitionContent: null,
    localComponentId: null,
    localComponentVersionId: null,
    gitBranch: null,
    repositoryFullName: null,
    succeeded: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
