import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AgentComponentInvocationSyncLocalError,
  buildAgentComponentInvocationSyncSourceKey,
} from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  type Db,
  NOW,
  openDb,
  SKILL_CONTENT_V1,
  SKILL_CONTENT_V2,
  skillSession,
} from "./helpers/invocation-sync-fixtures.js";
import { staleRebuildFromStoredRows } from "./helpers/stored-rebuild.js";
import { makeSession } from "./normalized-session-test-utils.js";

async function invocationCount(db: Db, sessionId: string): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM agent_component_invocations WHERE session_id = $1",
    sessionId
  );
  return Number(rows[0]?.n ?? 0);
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return typeof value === "string"
    ? (JSON.parse(value) as Record<string, unknown>)
    : {};
}

describe("FEA-3294 Desktop component invocation materialization", () => {
  test("ID-less tool and skill rows use trace ordinals while commands share a stable user-turn id", () => {
    const timestamp = "2026-07-22T17:00:01.000Z";
    const toolCandidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        sessionId: "minimal-idless-tool",
        toolUses: [{ name: "Read", timestamp }],
      }),
      "main-agent",
      NOW
    );
    assert.equal(
      toolCandidates[0]?.anchorKind,
      AgentComponentInvocationAnchorKind.Timestamp
    );
    assert.deepEqual(JSON.parse(toolCandidates[0]?.anchorValue ?? ""), {
      timestamp,
      ordinal: 0,
    });

    const definitionSnapshot = {
      kind: "skill" as const,
      rawName: "review",
      normalizedName: "review",
      content: SKILL_CONTENT_V1,
      capturedAt: timestamp,
    };
    const skillCandidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        sessionId: "idless-skill-after-human",
        messages: [{ role: "human", timestamp, text: "/review" }],
        skills: [
          {
            name: "review",
            timestamp,
            definitionSnapshot,
          },
        ],
        toolUses: [
          {
            name: "Skill",
            skillName: "review",
            timestamp,
            definitionSnapshot,
          },
        ],
      }),
      "main-agent",
      NOW
    );
    assert.equal(
      skillCandidates[0]?.anchorKind,
      AgentComponentInvocationAnchorKind.Timestamp
    );
    assert.deepEqual(JSON.parse(skillCandidates[0]?.anchorValue ?? ""), {
      timestamp,
      ordinal: 1,
    });

    const commandCandidate = deriveAgentComponentInvocationCandidates(
      makeSession({
        sessionId: "command-without-provider-id",
        messages: [{ role: "human", timestamp, text: "/review" }],
        slashCommands: [{ name: "/review", timestamp }],
      }),
      "main-agent",
      NOW
    ).find(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Command
    );
    const commandTurnId = `command:0:${timestamp}:/review`;
    assert.equal(commandCandidate?.externalInvocationId, commandTurnId);
    assert.equal(
      commandCandidate?.anchorKind,
      AgentComponentInvocationAnchorKind.UserTurn
    );
    assert.equal(commandCandidate?.anchorValue, commandTurnId);
  });

  test("first import links five exact skill rows, derives count five, and queues one immutable generation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-five-skills-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-five-skills";
      const session = skillSession(
        sessionId,
        Array.from({ length: 5 }, () => SKILL_CONTENT_V1)
      );
      const first = await db.importer.importSession(session, "claude");
      assert.equal(first.incomplete, undefined);
      assert.equal(await invocationCount(db, sessionId), 5);

      const invocations = await db.prisma.client.$queryRawUnsafe<
        {
          external_invocation_id: string;
          attribution_status: string;
          evidence_class: string;
          local_component_id: string | null;
          local_component_version_id: string | null;
        }[]
      >(
        `SELECT external_invocation_id, attribution_status, evidence_class,
                local_component_id, local_component_version_id
           FROM agent_component_invocations
          WHERE session_id = $1 ORDER BY sequence`,
        sessionId
      );
      assert.equal(invocations.length, 5);
      assert.ok(
        invocations.every((row) => row.attribution_status === "matched")
      );
      assert.ok(
        invocations.every((row) => row.evidence_class === "transcriptSnapshot")
      );
      assert.ok(invocations.every((row) => row.local_component_id));
      assert.ok(invocations.every((row) => row.local_component_version_id));

      const usage = await db.prisma.client.$queryRawUnsafe<
        {
          invocations: number;
          agent_component_id: string | null;
          component_version_hash: string | null;
        }[]
      >(
        `SELECT invocations, agent_component_id, component_version_hash
           FROM agent_component_session_usage
          WHERE session_id = $1 AND component_kind = 'skill'
            AND component_key = 'review'`,
        sessionId
      );
      assert.equal(Number(usage[0]?.invocations), 5);
      assert.ok(usage[0]?.agent_component_id, "linked on the first import");
      assert.equal(
        usage[0]?.component_version_hash,
        computeDefinitionHash({
          frontmatter: "",
          body: SKILL_CONTENT_V1,
          kind: "skill",
        }).definitionHash
      );

      const outboxBefore = await db.prisma.client.$queryRawUnsafe<
        { source_key: string; part_hash: string; payload: unknown }[]
      >(
        `SELECT source_key, part_hash, payload
           FROM agent_component_invocation_sync_outbox
          WHERE external_session_id = $1`,
        sessionId
      );
      assert.equal(outboxBefore.length, 1);
      assert.equal(outboxBefore[0]?.source_key, "agent_component_invocations");
      assert.equal(
        (jsonObject(outboxBefore[0]?.payload).items as unknown[]).length,
        5
      );

      await db.importer.importSession(session, "claude");
      assert.equal(await invocationCount(db, sessionId), 5);
      const outboxAfter = await db.prisma.client.$queryRawUnsafe<
        { part_hash: string }[]
      >(
        `SELECT part_hash FROM agent_component_invocation_sync_outbox
          WHERE external_session_id = $1`,
        sessionId
      );
      assert.deepEqual(outboxAfter, [
        { part_hash: outboxBefore[0]?.part_hash },
      ]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a changed generation advances sequence after the prior outbox drains", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-sequence-cursor-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-sequence-cursor";
      await db.importer.importSession(
        skillSession(sessionId, [SKILL_CONTENT_V1]),
        "claude"
      );
      const first = await db.prisma.client.$queryRawUnsafe<
        { external_generation_id: string; source_sequence: number }[]
      >(
        `SELECT external_generation_id, source_sequence
           FROM agent_component_invocation_sync_outbox
          WHERE external_session_id = $1`,
        sessionId
      );
      assert.equal(first[0]?.source_sequence, 0);

      await db.prisma.client.agentComponentInvocationSyncOutbox.deleteMany({
        where: { externalSessionId: sessionId },
      });
      await db.importer.importSession(
        skillSession(sessionId, [SKILL_CONTENT_V1, SKILL_CONTENT_V2]),
        "claude"
      );

      const second = await db.prisma.client.$queryRawUnsafe<
        { external_generation_id: string; source_sequence: number }[]
      >(
        `SELECT external_generation_id, source_sequence
           FROM agent_component_invocation_sync_outbox
          WHERE external_session_id = $1`,
        sessionId
      );
      assert.equal(second.length, 1);
      assert.notEqual(
        second[0]?.external_generation_id,
        first[0]?.external_generation_id
      );
      assert.equal(second[0]?.source_sequence, 1);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("acknowledging one compute target does not consume another target's backfill", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-target-scope-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-target-scope";
      await db.importer.importSession(
        skillSession(sessionId, [SKILL_CONTENT_V1]),
        "claude"
      );
      const targetA = buildAgentComponentInvocationSyncSourceKey("target-a");
      const targetB = buildAgentComponentInvocationSyncSourceKey("target-b");
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      const load = db.syncSource.loadReadyInvocationSyncParts;
      const clear = db.syncSource.clearAcknowledgedInvocationSyncPart;
      assert.ok(prepare && load && clear);

      await prepare(targetA, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
      const partsA = await load(targetA, NOW, 10);
      assert.equal(partsA.length, 1);
      await clear(targetA, partsA[0]?.part ?? assert.fail("missing part A"));
      assert.deepEqual(await load(targetA, NOW, 10), []);

      await prepare(targetB, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
      const partsB = await load(targetB, NOW, 10);
      assert.equal(partsB.length, 1);
      assert.equal(
        partsB[0]?.part.externalGenerationId,
        partsA[0]?.part.externalGenerationId
      );

      await db.importer.importSession(
        skillSession(sessionId, [SKILL_CONTENT_V1, SKILL_CONTENT_V2]),
        "claude"
      );
      await db.importer.importSession(
        skillSession(sessionId, [SKILL_CONTENT_V1]),
        "claude"
      );
      await prepare(targetA, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
      const recurringPartsA = await load(targetA, NOW, 10);
      assert.equal(recurringPartsA.length, 1);
      assert.equal(recurringPartsA[0]?.part.sourceSequence, 2);
      assert.equal(
        recurringPartsA[0]?.part.externalGenerationId,
        partsA[0]?.part.externalGenerationId
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("compute-target preparation clones at most the requested session batch", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-target-batch-"));
    const db = await openDb(dir);
    try {
      await db.importer.importSession(
        skillSession("session-target-batch-a", [SKILL_CONTENT_V1]),
        "claude"
      );
      await db.importer.importSession(
        skillSession("session-target-batch-b", [SKILL_CONTENT_V1]),
        "claude"
      );
      const target = buildAgentComponentInvocationSyncSourceKey("target-batch");
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      const load = db.syncSource.loadReadyInvocationSyncParts;
      const clear = db.syncSource.clearAcknowledgedInvocationSyncPart;
      assert.ok(prepare && load && clear);

      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 1);
      const firstBatch = await load(target, NOW, 10);
      assert.equal(firstBatch.length, 1);
      await clear(
        target,
        firstBatch[0]?.part ?? assert.fail("missing first target batch")
      );

      await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 1);
      const secondBatch = await load(target, NOW, 10);
      assert.equal(secondBatch.length, 1);
      assert.notEqual(
        secondBatch[0]?.part.externalSessionId,
        firstBatch[0]?.part.externalSessionId
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("invalid persisted outbox payloads are quarantined instead of retried forever", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-invalid-outbox-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-invalid-outbox";
      await db.importer.importSession(
        skillSession(sessionId, [SKILL_CONTENT_V1]),
        "claude"
      );
      await db.prisma.client.$executeRawUnsafe(
        `UPDATE agent_component_invocation_sync_outbox
            SET payload = $1
          WHERE source_key = $2 AND external_session_id = $3`,
        JSON.stringify({ invalid: true }),
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        sessionId
      );

      const load = db.syncSource.loadReadyInvocationSyncParts;
      assert.ok(load);
      assert.deepEqual(
        await load(AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, NOW, 10),
        []
      );
      const rows = await db.prisma.client.$queryRawUnsafe<
        { status: string; last_error: string | null }[]
      >(
        `SELECT status, last_error
           FROM agent_component_invocation_sync_outbox
          WHERE source_key = $1 AND external_session_id = $2`,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        sessionId
      );
      assert.deepEqual(rows, [
        {
          status: OutboxStatus.DeadLettered,
          last_error:
            AgentComponentInvocationSyncLocalError.InvalidPersistedPayload,
        },
      ]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("branch attribution uses ordered created-link evidence and omits timestamp-less invocations", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-branch-proof-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-branch-proof";
      const invokedAt = "2026-07-22T10:00:00-05:00";
      await db.importer.importSession(
        makeSession({
          sessionId,
          gitBranch: "main",
          startedAt: NOW,
          endedAt: "2026-07-22T17:05:00.000Z",
          toolUses: [
            {
              id: "toolu_branch_proof",
              name: "Read",
              timestamp: invokedAt,
              gitBranch: "main",
            },
          ],
          subagents: [
            {
              id: "timestamp-less-agent",
              name: "Legacy agent",
              type: "reviewer",
              startedAt: null,
            },
          ],
        }),
        "claude"
      );
      await db.run(
        `UPDATE agents SET started_at = NULL
          WHERE session_id = $1 AND type = 'subagent'`,
        sessionId
      );
      await db.run(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, branch_name,
            created_at, last_seen_at)
         VALUES ($1, $2, 'branch', $3, $4, $5, $5),
                ($6, $7, 'branch', $3, $8, $5, $5)`,
        "artifact-branch-proof",
        "branch:closedloop-ai/symphony-alpha:feat/fea-3294",
        "closedloop-ai/symphony-alpha",
        "feat/fea-3294",
        NOW,
        "artifact-branch-older",
        "branch:closedloop-ai/symphony-alpha:feat/older",
        "feat/older"
      );
      await db.run(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence,
            extractor_version, observed_at, created_at)
         VALUES ($1, $2, $3, 'created', 'git_push', '{}', 1, $4, $5),
                ($6, $2, $7, 'created', 'git_commit', '{}', 1, $8, $5)`,
        "link-branch-proof",
        sessionId,
        "artifact-branch-proof",
        "2026-07-22T10:00:00-05:00",
        NOW,
        "link-branch-older",
        "artifact-branch-older",
        "2026-07-22T14:30:00.000Z"
      );

      const rebuilt = await staleRebuildFromStoredRows(db, sessionId);
      assert.equal(rebuilt.rebuilt, true);
      const rows = await db.prisma.client.$queryRawUnsafe<
        {
          component_kind: string;
          git_branch: string | null;
          repository_full_name: string | null;
        }[]
      >(
        `SELECT component_kind, git_branch, repository_full_name
           FROM agent_component_invocations
          WHERE session_id = $1 AND component_kind IN ('tool', 'subagent')
          ORDER BY component_kind`,
        sessionId
      );
      assert.deepEqual(rows, [
        {
          component_kind: "subagent",
          git_branch: null,
          repository_full_name: null,
        },
        {
          component_kind: "tool",
          git_branch: "feat/fea-3294",
          repository_full_name: "closedloop-ai/symphony-alpha",
        },
      ]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("mixed exact versions retain distinct rows and null the aggregate version hash", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-mixed-version-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-mixed-version";
      await db.importer.importSession(
        skillSession(sessionId, [SKILL_CONTENT_V1, SKILL_CONTENT_V2]),
        "claude"
      );
      const rows = await db.prisma.client.$queryRawUnsafe<
        { definition_hash: string; local_component_version_id: string }[]
      >(
        `SELECT definition_hash, local_component_version_id
           FROM agent_component_invocations
          WHERE session_id = $1 ORDER BY sequence`,
        sessionId
      );
      assert.equal(rows.length, 2);
      assert.equal(new Set(rows.map((row) => row.definition_hash)).size, 2);
      assert.equal(
        new Set(rows.map((row) => row.local_component_version_id)).size,
        2
      );
      const usage = await db.prisma.client.$queryRawUnsafe<
        { invocations: number; component_version_hash: string | null }[]
      >(
        `SELECT invocations, component_version_hash
           FROM agent_component_session_usage
          WHERE session_id = $1 AND component_kind = 'skill'`,
        sessionId
      );
      assert.equal(Number(usage[0]?.invocations), 2);
      assert.equal(usage[0]?.component_version_hash, null);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("multiple component matches stay ambiguous instead of linking arbitrarily", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-ambiguous-link-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-ambiguous-link";
      const session = skillSession(sessionId, [SKILL_CONTENT_V1]);
      await db.importer.importSession(session, "claude");
      await db.prisma.client.$executeRawUnsafe(
        `INSERT INTO agent_components
           (id, component_kind, external_id, component_key, resolved_state,
            first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        "ambiguous-review-component",
        AgentComponentKind.Skill,
        "review-from-another-source",
        "review",
        AgentComponentInvocationAttributionStatus.Unresolved,
        NOW
      );

      await db.importer.importSession(session, "claude");

      const rows = await db.prisma.client.$queryRawUnsafe<
        {
          attribution_status: string;
          local_component_id: string | null;
          local_component_version_id: string | null;
        }[]
      >(
        `SELECT attribution_status, local_component_id,
                local_component_version_id
           FROM agent_component_invocations WHERE session_id = $1`,
        sessionId
      );
      assert.deepEqual(rows, [
        {
          attribution_status:
            AgentComponentInvocationAttributionStatus.Ambiguous,
          local_component_id: null,
          local_component_version_id: null,
        },
      ]);
      const usage = await db.prisma.client.$queryRawUnsafe<
        { agent_component_id: string | null }[]
      >(
        `SELECT agent_component_id FROM agent_component_session_usage
          WHERE session_id = $1 AND component_kind = $2`,
        sessionId,
        AgentComponentKind.Skill
      );
      assert.equal(usage[0]?.agent_component_id, null);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("definitionless subagents stay invocation-only and later relink to genuine inventory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-runtime-subagent-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-runtime-subagent";
      const session = makeSession({
        sessionId,
        startedAt: NOW,
        endedAt: "2026-07-22T17:05:00.000Z",
        toolUses: [
          {
            id: "toolu_runtime_subagent",
            providerToolUseId: "toolu_runtime_subagent",
            name: "Agent",
            timestamp: "2026-07-22T17:00:01.000Z",
            input: { subagent_type: "Explore", prompt: "Inspect the code" },
          },
        ],
      });

      await db.importer.importSession(session, "claude");

      const inventoryBefore = await db.prisma.client.$queryRawUnsafe<
        { n: number }[]
      >(
        `SELECT COUNT(*) AS n FROM agent_components
          WHERE component_kind = $1 AND component_key = $2`,
        AgentComponentKind.Subagent,
        "Explore"
      );
      assert.equal(Number(inventoryBefore[0]?.n ?? 0), 0);

      const invocationBefore = await db.prisma.client.$queryRawUnsafe<
        {
          attribution_status: string;
          local_component_id: string | null;
        }[]
      >(
        `SELECT attribution_status, local_component_id
           FROM agent_component_invocations
          WHERE session_id = $1 AND component_kind = $2`,
        sessionId,
        AgentComponentKind.Subagent
      );
      assert.deepEqual(invocationBefore, [
        {
          attribution_status:
            AgentComponentInvocationAttributionStatus.Unresolved,
          local_component_id: null,
        },
      ]);

      await db.prisma.client.$executeRawUnsafe(
        `INSERT INTO agent_components
           (id, component_kind, external_id, component_key, resolved_state,
            content, content_hash, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $3, 'resolved', $4, $5, $6, $6)`,
        "genuine-explore-component",
        AgentComponentKind.Subagent,
        "Explore",
        "# Explore\nInspect the repository.",
        "genuine-explore-content-hash",
        NOW
      );

      await db.importer.importSession(session, "claude");

      const invocationAfter = await db.prisma.client.$queryRawUnsafe<
        {
          attribution_status: string;
          local_component_id: string | null;
        }[]
      >(
        `SELECT attribution_status, local_component_id
           FROM agent_component_invocations
          WHERE session_id = $1 AND component_kind = $2`,
        sessionId,
        AgentComponentKind.Subagent
      );
      assert.deepEqual(invocationAfter, [
        {
          attribution_status:
            AgentComponentInvocationAttributionStatus.Unresolved,
          local_component_id: "genuine-explore-component",
        },
      ]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a weaker re-import preserves transcript evidence by stable invocation id", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-evidence-sticky-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-evidence-sticky";
      const withEvidence = skillSession(sessionId, [SKILL_CONTENT_V1]);
      await db.importer.importSession(withEvidence, "claude");

      const withoutEvidence = skillSession(sessionId, [SKILL_CONTENT_V1]);
      withoutEvidence.skills = withoutEvidence.skills.map((skill) => ({
        ...skill,
        definitionSnapshot: undefined,
      }));
      withoutEvidence.toolUses = withoutEvidence.toolUses.map((toolUse) => ({
        ...toolUse,
        definitionSnapshot: undefined,
      }));
      await db.importer.importSession(withoutEvidence, "claude");

      const rows = await db.prisma.client.$queryRawUnsafe<
        {
          evidence_class: string;
          definition_hash: string | null;
          definition_content: string | null;
        }[]
      >(
        `SELECT evidence_class, definition_hash, definition_content
           FROM agent_component_invocations WHERE session_id = $1`,
        sessionId
      );
      assert.equal(rows[0]?.evidence_class, "transcriptSnapshot");
      assert.ok(rows[0]?.definition_hash);
      assert.equal(rows[0]?.definition_content, SKILL_CONTENT_V1);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stored fallback and later source recovery preserve durable provider invocation identity", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-source-recovery-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-source-recovery";
      const providerToolUseId = "toolu_source_recovery";
      const session = makeSession({
        sessionId,
        startedAt: NOW,
        endedAt: "2026-07-22T17:05:00.000Z",
        toolUses: [
          {
            id: providerToolUseId,
            providerToolUseId,
            name: "Read",
            kind: "builtin",
            timestamp: "2026-07-22T17:00:01.000Z",
          },
        ],
      });
      await db.importer.importSession(session, "claude");
      const events = await db.prisma.client.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM events
          WHERE session_id = $1 AND tool_name = 'Read'`,
        sessionId
      );
      const eventId = events[0]?.id;
      assert.ok(eventId, "stored fallback requires a durable event anchor");
      await db.run(
        "DELETE FROM agent_component_invocations WHERE session_id = $1",
        sessionId
      );

      const rebuilt = await staleRebuildFromStoredRows(db, sessionId);
      assert.equal(rebuilt.rebuilt, true);
      const fallbackRows = await db.prisma.client.$queryRawUnsafe<
        {
          external_invocation_id: string;
          external_source_id: string | null;
          provider_tool_use_id: string | null;
        }[]
      >(
        `SELECT external_invocation_id, external_source_id,
                provider_tool_use_id
           FROM agent_component_invocations
          WHERE session_id = $1 AND component_key = 'Read'`,
        sessionId
      );
      assert.deepEqual(fallbackRows, [
        {
          external_invocation_id: providerToolUseId,
          external_source_id: providerToolUseId,
          provider_tool_use_id: providerToolUseId,
        },
      ]);

      await db.run(
        `UPDATE agent_component_invocations
            SET external_invocation_id = $1
          WHERE session_id = $2 AND component_key = 'Read'`,
        eventId,
        sessionId
      );
      await db.importer.importSession(session, "claude");
      const recoveredRows = await db.prisma.client.$queryRawUnsafe<
        {
          external_invocation_id: string;
          external_source_id: string | null;
          provider_tool_use_id: string | null;
        }[]
      >(
        `SELECT external_invocation_id, external_source_id,
                provider_tool_use_id
           FROM agent_component_invocations
          WHERE session_id = $1 AND component_key = 'Read'`,
        sessionId
      );
      assert.deepEqual(recoveredRows, [
        {
          external_invocation_id: eventId,
          external_source_id: providerToolUseId,
          provider_tool_use_id: providerToolUseId,
        },
      ]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-import disambiguates distinct provider ids that share one session anchor", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-shared-anchor-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-shared-event-anchor";
      const firstProviderId = "toolu_shared_anchor_first";
      const secondProviderId = "toolu_shared_anchor_second";
      const session = makeSession({
        sessionId,
        startedAt: NOW,
        endedAt: "2026-07-22T17:05:00.000Z",
        toolUses: [
          {
            id: firstProviderId,
            providerToolUseId: firstProviderId,
            name: "Read",
            kind: "builtin",
            timestamp: null,
          },
          {
            id: secondProviderId,
            providerToolUseId: secondProviderId,
            name: "Read",
            kind: "builtin",
            timestamp: null,
          },
        ],
      });
      await db.importer.importSession(session, "claude");
      await db.run(
        `UPDATE agent_component_invocations
            SET external_invocation_id = CASE provider_tool_use_id
                  WHEN $1 THEN 'stored-fallback-first'
                  WHEN $2 THEN 'stored-fallback-second'
                END
          WHERE session_id = $3`,
        firstProviderId,
        secondProviderId,
        sessionId
      );
      const second = await db.importer.importSession(session, "claude");
      assert.equal(second.incomplete, undefined);
      const rows = await db.prisma.client.$queryRawUnsafe<
        {
          external_invocation_id: string;
          provider_tool_use_id: string | null;
          anchor_kind: string;
          anchor_value: string;
        }[]
      >(
        `SELECT external_invocation_id, provider_tool_use_id,
                anchor_kind, anchor_value
           FROM agent_component_invocations
          WHERE session_id = $1 ORDER BY external_invocation_id`,
        sessionId
      );
      assert.deepEqual(rows, [
        {
          external_invocation_id: "stored-fallback-first",
          provider_tool_use_id: firstProviderId,
          anchor_kind: AgentComponentInvocationAnchorKind.Session,
          anchor_value: sessionId,
        },
        {
          external_invocation_id: "stored-fallback-second",
          provider_tool_use_id: secondProviderId,
          anchor_kind: AgentComponentInvocationAnchorKind.Session,
          anchor_value: sessionId,
        },
      ]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stored nested subagents retain child and parent ownership in transport", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-stored-tree-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-stored-subagent-tree";
      await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: NOW,
          endedAt: "2026-07-22T17:05:00.000Z",
          subagents: [
            {
              id: "stored-parent",
              childSessionId: "stored-child-parent",
              name: "Stored parent",
              type: "reviewer",
              nativeSubagentId: "provider-stored-parent",
              startedAt: "2026-07-22T17:00:01.000Z",
            },
            {
              id: "stored-child",
              parentId: "stored-parent",
              childSessionId: "stored-child-child",
              name: "Stored child",
              type: "researcher",
              nativeSubagentId: "provider-stored-child",
              startedAt: "2026-07-22T17:00:02.000Z",
            },
          ],
        }),
        "claude"
      );
      await db.run(
        "DELETE FROM agent_component_invocations WHERE session_id = $1",
        sessionId
      );
      const rebuilt = await staleRebuildFromStoredRows(db, sessionId);
      assert.equal(rebuilt.rebuilt, true);

      const rows = await db.prisma.client.$queryRawUnsafe<
        {
          external_invocation_id: string;
          child_session_id: string | null;
          agent_id: string | null;
          parent_agent_id: string | null;
          relationship: string;
          evidence_pointer: unknown;
        }[]
      >(
        `SELECT external_invocation_id, child_session_id, agent_id,
                parent_agent_id, relationship, evidence_pointer
           FROM agent_component_invocations
          WHERE session_id = $1 AND component_kind = 'subagent'
          ORDER BY invoked_at`,
        sessionId
      );
      assert.equal(rows.length, 2);
      const parent = rows[0];
      const child = rows[1];
      assert.ok(parent);
      assert.ok(child);
      assert.equal(parent.child_session_id, "stored-child-parent");
      assert.equal(child.child_session_id, "stored-child-child");
      assert.equal(child.parent_agent_id, parent.agent_id);
      assert.equal(
        child.relationship,
        AgentComponentInvocationRelationship.ChildSession
      );
      assert.equal(
        jsonObject(child.evidence_pointer).parentExternalInvocationId,
        parent.external_invocation_id
      );

      const outbox = await db.prisma.client.$queryRawUnsafe<
        { payload: unknown }[]
      >(
        `SELECT payload
           FROM agent_component_invocation_sync_outbox
          WHERE source_key = $1 AND external_session_id = $2`,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        sessionId
      );
      assert.equal(outbox.length, 1);
      const items = jsonObject(outbox[0]?.payload).items;
      assert.ok(Array.isArray(items));
      const childItem = items
        .map((item) => jsonObject(item))
        .find(
          (item) => item.externalInvocationId === child.external_invocation_id
        );
      assert.ok(childItem, "child invocation missing from sync generation");
      assert.equal(
        childItem.parentExternalInvocationId,
        parent.external_invocation_id
      );
      assert.equal(childItem.childSessionId, "stored-child-child");
      assert.equal(childItem.externalAgentId, "provider-stored-child");
      assert.equal(
        jsonObject(childItem.anchor).transcriptFileId,
        "stored-child"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("nested parser subagents preserve parent and child identities", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-subagent-tree-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-subagent-tree";
      await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: NOW,
          endedAt: "2026-07-22T17:05:00.000Z",
          subagents: [
            {
              id: "agent-parent",
              childSessionId: "child-parent",
              name: "Parent",
              type: "reviewer",
              nativeSubagentId: "provider-parent",
              startedAt: "2026-07-22T17:00:01.000Z",
            },
            {
              id: "agent-child",
              parentId: "agent-parent",
              childSessionId: "child-child",
              name: "Child",
              type: "researcher",
              nativeSubagentId: "provider-child",
              startedAt: "2026-07-22T17:00:02.000Z",
            },
          ],
        }),
        "claude"
      );
      const rows = await db.prisma.client.$queryRawUnsafe<
        {
          external_invocation_id: string;
          external_source_id: string | null;
          child_session_id: string | null;
          agent_id: string | null;
          parent_agent_id: string | null;
          evidence_pointer: unknown;
        }[]
      >(
        `SELECT external_invocation_id, external_source_id, child_session_id,
                agent_id, parent_agent_id, evidence_pointer
           FROM agent_component_invocations
          WHERE session_id = $1 AND component_kind = 'subagent'
          ORDER BY sequence`,
        sessionId
      );
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.external_source_id, "provider-parent");
      assert.equal(rows[0]?.child_session_id, "child-parent");
      assert.equal(
        jsonObject(rows[0]?.evidence_pointer).transcriptFileId,
        "agent-parent"
      );
      assert.equal(rows[1]?.external_source_id, "provider-child");
      assert.equal(rows[1]?.child_session_id, "child-child");
      assert.equal(rows[1]?.parent_agent_id, rows[0]?.agent_id);
      assert.equal(
        jsonObject(rows[1]?.evidence_pointer).parentExternalInvocationId,
        "subagent:agent-parent"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("isolated invocation failure is incomplete and leaves the prior aggregate untouched", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-isolated-fail-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-isolated-fail";
      const first = makeSession({
        sessionId,
        startedAt: NOW,
        endedAt: "2026-07-22T17:05:00.000Z",
        toolUses: [{ name: "Read", kind: "builtin", timestamp: NOW }],
      });
      await db.importer.importSession(first, "claude");
      await db.run(
        `CREATE TRIGGER fail_invocation_insert
         BEFORE INSERT ON agent_component_invocations
         BEGIN SELECT RAISE(ABORT, 'forced invocation failure'); END`
      );

      const second = makeSession({
        ...first,
        toolUses: [
          ...first.toolUses,
          {
            name: "Write",
            kind: "builtin",
            timestamp: "2026-07-22T17:00:01.000Z",
          },
        ],
      });
      const result = await db.importer.importSession(second, "claude");
      assert.equal(result.incomplete, true);
      assert.equal(await invocationCount(db, sessionId), 1);
      const usage = await db.prisma.client.$queryRawUnsafe<
        { component_key: string; invocations: number }[]
      >(
        `SELECT component_key, invocations
           FROM agent_component_session_usage
          WHERE session_id = $1 ORDER BY component_key`,
        sessionId
      );
      assert.deepEqual(usage, [{ component_key: "Read", invocations: 1 }]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
