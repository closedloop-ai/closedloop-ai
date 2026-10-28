/**
 * ISS-12872 real-Postgres proof for `relinkActiveForComputeTarget`.
 *
 * The first case pins WHICH rows the relink links, one row per rule in its
 * WHERE clause, so a change that only meant to make the statement cheaper
 * cannot quietly change what it does. The case-variant row is the one a
 * cheaper statement is most likely to break: its folded key matches the
 * inventory row exactly, so only the exact `component_key` equality keeps it
 * unlinked.
 *
 * The second case pins the access path that made the statement cheap: the
 * probe from each inventory row into `idx_aci_kind_key_normalized_unattributed`
 * must seek on kind AND folded key. The indexes leading with `generation_id`
 * are dropped (in a rolled-back fixture transaction) because they give the
 * planner a second, session-driven path into the table, and the production
 * plan for the heaviest targets is the inventory-driven one. The same
 * transaction also sets `enable_seqscan` and `enable_bitmapscan` off, which
 * leaves the planner little choice but a plain index scan. So this case proves
 * the new predicate is a usable seek condition on that index; it does not prove
 * the planner would choose that path unforced, and it is not a plan-choice
 * guard. Keep both settings off: `UNATTRIBUTED_PROBE` reads a plain
 * `Index Scan` node on that index, and a plan that reaches the table by a
 * sequential or bitmap scan has no such node.
 *
 * Self-skips when DATABASE_URL is unset. Run explicitly:
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app \
 *     pnpm --filter api exec vitest run \
 *     __tests__/integration/component-invocations-relink-realdb.test.ts \
 *     --config vitest.config.integration.mts
 */
import { randomUUID } from "node:crypto";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import { analyzeTables } from "@repo/database/__tests__/test-helpers/planner-fixture";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  matching,
  observeStatements,
} from "@/__tests__/support/db-statement-observer";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  type FixtureRawClient,
  withRolledBackFixtureTransaction,
} from "@/__tests__/utils/fixture-db";
import { agentComponentInvocationsService } from "@/app/agent-sessions/service/component-invocations";

type Db = Parameters<Parameters<typeof withDb>[0]>[0];

const hasDatabase = Boolean(keys().DATABASE_URL);

const SKILL_KEY = "code-review";
const SUBAGENT_KEY = "planner";
const DUPLICATED_COMMAND_KEY = "/deploy";
const Status = AgentComponentInvocationAttributionStatus;

/** The relink statement, picked out of everything the service issued. */
const RELINK_STATEMENT = /UPDATE agent_component_invocations AS invocation/;
/** The probe from an inventory row into the unattributed-invocation index. */
const UNATTRIBUTED_PROBE =
  /Index Scan using idx_aci_kind_key_normalized_unattributed on agent_component_invocations invocation[^\n]*\n\s*Index Cond: ([^\n]*)/;

/**
 * The heaviest production target's shape, read 2026-10-21 17:14Z: 2,038
 * subagent inventory rows on the target, against 13,280 unattributed subagent
 * invocations spread over 851 distinct keys.
 */
const PLANNER_INVENTORY_ROWS = 2038;
const PLANNER_UNATTRIBUTED_ROWS = 13_280;
const PLANNER_UNATTRIBUTED_KEYS = 851;
const PLANNED_TABLES = [
  "agent_components",
  "agent_component_invocations",
  "agent_component_invocation_generations",
  "session_detail",
  "artifacts",
] as const;

describe.skipIf(!hasDatabase)(
  "ISS-12872 relinkActiveForComputeTarget against real Postgres",
  () => {
    it("links exactly the rows the exact-key contract names", async () => {
      await autoRollbackTransaction(async () => {
        const fixture = await withDb(seedRelinkFixture);

        const relinked =
          await agentComponentInvocationsService.relinkActiveForComputeTarget({
            organizationId: fixture.organizationId,
            computeTargetId: fixture.computeTargetId,
          });

        expect(relinked).toBe(3);
        const rows = await withDb((db) =>
          db.agentComponentInvocation.findMany({
            where: { id: { in: Object.values(fixture.invocationIds) } },
            select: {
              id: true,
              agentComponentId: true,
              attributionStatus: true,
              updatedAt: true,
            },
          })
        );
        const byCase = new Map(rows.map((row) => [row.id, row]));
        const outcome = (name: keyof typeof fixture.invocationIds) => {
          const row = byCase.get(fixture.invocationIds[name]);
          return {
            agentComponentId: row?.agentComponentId,
            attributionStatus: row?.attributionStatus,
            touched: row?.updatedAt.getTime() !== SEEDED_AT.getTime(),
          };
        };

        expect(outcome("unmatchedWithDefinition")).toEqual({
          agentComponentId: fixture.componentIds.skill,
          attributionStatus: Status.Matched,
          touched: true,
        });
        expect(outcome("unmatchedWithoutDefinition")).toEqual({
          agentComponentId: fixture.componentIds.subagent,
          attributionStatus: Status.Unmatched,
          touched: true,
        });
        expect(outcome("unresolved")).toEqual({
          agentComponentId: fixture.componentIds.skill,
          attributionStatus: Status.Unresolved,
          touched: true,
        });
        const untouched = (attributionStatus: string) => ({
          agentComponentId: null,
          attributionStatus,
          touched: false,
        });
        expect(outcome("ambiguousStatus")).toEqual(untouched(Status.Ambiguous));
        expect(outcome("caseVariantKey")).toEqual(untouched(Status.Unmatched));
        expect(outcome("duplicatedInventoryKey")).toEqual(
          untouched(Status.Unmatched)
        );
        expect(outcome("inactiveGeneration")).toEqual(
          untouched(Status.Unmatched)
        );
        expect(outcome("incompleteGeneration")).toEqual(
          untouched(Status.Unmatched)
        );
        expect(outcome("otherKindSameKey")).toEqual(
          untouched(Status.Unmatched)
        );
        expect(outcome("otherComputeTarget")).toEqual(
          untouched(Status.Unmatched)
        );
        expect(outcome("otherOrganization")).toEqual(
          untouched(Status.Unmatched)
        );
        expect(outcome("keyNotInInventory")).toEqual(
          untouched(Status.Unmatched)
        );
        expect(outcome("alreadyLinked")).toEqual({
          agentComponentId: fixture.componentIds.otherTarget,
          attributionStatus: Status.Unmatched,
          touched: false,
        });
      });
    });

    it("seeks the unattributed index on kind and folded key", async () => {
      const ids = {
        organizationId: randomUUID(),
        userId: randomUUID(),
        computeTargetId: randomUUID(),
        otherComputeTargetId: randomUUID(),
        sessionId: randomUUID(),
        generationId: randomUUID(),
        partId: randomUUID(),
      };
      // Only the statement text and its bound values are needed here; the
      // corpus it is planned against is seeded below, on the fixture connection.
      const { statements } = await observeStatements(() =>
        agentComponentInvocationsService.relinkActiveForComputeTarget({
          organizationId: ids.organizationId,
          computeTargetId: ids.computeTargetId,
        })
      );
      const [relink] = matching(statements, RELINK_STATEMENT);
      if (!relink) {
        throw new Error("relinkActiveForComputeTarget issued no relink UPDATE");
      }

      const plan = await withRolledBackFixtureTransaction(
        "the ISS-12872 relink probe plan",
        async (client) => {
          await seedPlannerCorpus(client, ids);
          await analyzeTables(client, PLANNED_TABLES);
          const generationLeading = await client.$queryRawUnsafe<
            { indexname: string }[]
          >(
            `SELECT indexname FROM pg_indexes
              WHERE tablename = 'agent_component_invocations'
                AND indexdef LIKE '%(generation_id%'`
          );
          expect(generationLeading.length).toBeGreaterThan(0);
          for (const { indexname } of generationLeading) {
            await client.$executeRawUnsafe(`DROP INDEX "${indexname}"`);
          }
          await client.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
          await client.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
          const rows = await client.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
            `EXPLAIN ${relink.sql}`,
            ...relink.values
          );
          return rows.map((row) => row["QUERY PLAN"]).join("\n");
        }
      );

      const indexCond = UNATTRIBUTED_PROBE.exec(plan)?.[1];
      expect(indexCond, plan).toContain(
        "component_kind = component.component_kind"
      );
      expect(indexCond, plan).toContain(
        "component_key_normalized = lower(component.component_key)"
      );
    });
  }
);

const SEEDED_AT = new Date("2026-10-20T12:00:00.000Z");

/**
 * One organization and compute target under test, plus a second target in the
 * same organization and a second organization, each holding a row the relink
 * must leave alone.
 */
async function seedRelinkFixture(db: Db) {
  const organizationId = await createTestOrganization();
  const otherOrganizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const computeTargetId = await createTarget(db, organizationId, user.id);
  const otherTargetId = await createTarget(db, organizationId, user.id);

  const component = (
    computeTarget: string,
    componentKind: string,
    componentKey: string
  ) =>
    db.agentComponent
      .create({
        data: {
          organizationId,
          computeTargetId: computeTarget,
          componentKind,
          componentKey,
          externalComponentId: randomUUID(),
        },
        select: { id: true },
      })
      .then((row) => row.id);
  const componentIds = {
    skill: await component(
      computeTargetId,
      AgentComponentKind.Skill,
      SKILL_KEY
    ),
    subagent: await component(
      computeTargetId,
      AgentComponentKind.Subagent,
      SUBAGENT_KEY
    ),
    otherTarget: await component(
      otherTargetId,
      AgentComponentKind.Skill,
      SKILL_KEY
    ),
  };
  // Two inventory rows for one key: ambiguous inventory is never guessed.
  await component(
    computeTargetId,
    AgentComponentKind.Command,
    DUPLICATED_COMMAND_KEY
  );
  await component(
    computeTargetId,
    AgentComponentKind.Command,
    DUPLICATED_COMMAND_KEY
  );

  const definitionVersionId = await db.definitionVersion
    .create({
      data: {
        organizationId,
        componentKind: AgentComponentKind.Skill,
        definitionHash: randomUUID(),
        normalizerContractVersion: 1,
        content: "ISS-12872 fixture",
      },
      select: { id: true },
    })
    .then((row) => row.id);

  const active = await createGeneration(db, {
    organizationId,
    computeTargetId,
    active: true,
  });
  const inactive = await createGeneration(db, {
    organizationId,
    computeTargetId,
    active: false,
  });
  const activeIncomplete = await createGeneration(db, {
    organizationId,
    computeTargetId,
    active: true,
    completed: false,
  });
  const onOtherTarget = await createGeneration(db, {
    organizationId,
    computeTargetId: otherTargetId,
    active: true,
  });
  const inOtherOrganization = await createGeneration(db, {
    organizationId: otherOrganizationId,
    computeTargetId,
    active: true,
  });
  const invocation = async (
    generation: GenerationRef,
    row: {
      kind: string;
      key: string;
      status: string;
      definitionVersionId?: string;
      agentComponentId?: string;
    }
  ) => {
    const created = await db.agentComponentInvocation.create({
      data: {
        generationId: generation.generationId,
        partId: generation.partId,
        externalInvocationId: randomUUID(),
        sourceSessionId: "iss12872-source",
        componentKind: row.kind,
        componentKey: row.key,
        relationship: AgentComponentInvocationRelationship.Direct,
        sequence: 0,
        anchor: { kind: AgentComponentInvocationAnchorKind.Session },
        attributionStatus: row.status,
        evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
        definitionVersionId: row.definitionVersionId,
        agentComponentId: row.agentComponentId,
        updatedAt: SEEDED_AT,
      },
      select: { id: true },
    });
    return created.id;
  };
  const skill = { kind: AgentComponentKind.Skill, key: SKILL_KEY };
  const unmatchedSkill = { ...skill, status: Status.Unmatched };

  const invocationIds = {
    unmatchedWithDefinition: await invocation(active, {
      ...unmatchedSkill,
      definitionVersionId,
    }),
    unmatchedWithoutDefinition: await invocation(active, {
      kind: AgentComponentKind.Subagent,
      key: SUBAGENT_KEY,
      status: Status.Unmatched,
    }),
    unresolved: await invocation(active, {
      ...skill,
      status: Status.Unresolved,
    }),
    ambiguousStatus: await invocation(active, {
      ...skill,
      status: Status.Ambiguous,
      definitionVersionId,
    }),
    caseVariantKey: await invocation(active, {
      ...unmatchedSkill,
      key: SKILL_KEY.toUpperCase(),
      definitionVersionId,
    }),
    duplicatedInventoryKey: await invocation(active, {
      kind: AgentComponentKind.Command,
      key: DUPLICATED_COMMAND_KEY,
      status: Status.Unmatched,
    }),
    inactiveGeneration: await invocation(inactive, unmatchedSkill),
    incompleteGeneration: await invocation(activeIncomplete, unmatchedSkill),
    otherKindSameKey: await invocation(active, {
      ...unmatchedSkill,
      kind: AgentComponentKind.Command,
    }),
    otherComputeTarget: await invocation(onOtherTarget, unmatchedSkill),
    otherOrganization: await invocation(inOtherOrganization, unmatchedSkill),
    keyNotInInventory: await invocation(active, {
      ...unmatchedSkill,
      key: "not-in-inventory",
    }),
    alreadyLinked: await invocation(active, {
      ...unmatchedSkill,
      agentComponentId: componentIds.otherTarget,
    }),
  };

  return { organizationId, computeTargetId, componentIds, invocationIds };
}

type GenerationRef = { generationId: string; partId: string };

async function createTarget(
  db: Db,
  organizationId: string,
  userId: string
): Promise<string> {
  const target = await db.computeTarget.create({
    data: {
      organizationId,
      userId,
      machineName: `iss12872-${randomUUID().slice(0, 8)}`,
      platform: "darwin",
    },
    select: { id: true },
  });
  return target.id;
}

/** A session on `computeTargetId` in `organizationId`, holding one generation. */
async function createGeneration(
  db: Db,
  input: {
    organizationId: string;
    computeTargetId: string;
    active: boolean;
    completed?: boolean;
  }
): Promise<GenerationRef> {
  const session = await db.artifact.create({
    data: {
      organizationId: input.organizationId,
      type: ArtifactType.SESSION,
      name: "ISS-12872 session",
      status: SESSION_STATUS.ACTIVE,
    },
    select: { id: true },
  });
  await db.sessionDetail.create({
    data: {
      artifactId: session.id,
      computeTargetId: input.computeTargetId,
      externalSessionId: randomUUID(),
      harness: "claude",
      sessionStartedAt: SEEDED_AT,
      sessionUpdatedAt: SEEDED_AT,
      lastActivityAt: SEEDED_AT,
    },
    select: { artifactId: true },
  });
  const generation = await db.agentComponentInvocationGeneration.create({
    data: {
      agentSessionId: session.id,
      externalGenerationId: randomUUID(),
      sourceUpdatedAt: SEEDED_AT,
      dataRevision: 1,
      sourceSequence: 1,
      expectedPartCount: 1,
      activeAt: input.active ? SEEDED_AT : null,
      completedAt: input.completed === false ? null : SEEDED_AT,
    },
    select: { id: true },
  });
  const part = await db.agentComponentInvocationPart.create({
    data: {
      generationId: generation.id,
      partIndex: 0,
      partHash: randomUUID(),
      itemCount: 1,
      payloadBytes: 1,
    },
    select: { id: true },
  });
  return { generationId: generation.id, partId: part.id };
}

type PlannerCorpusIds = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
  otherComputeTargetId: string;
  sessionId: string;
  generationId: string;
  partId: string;
};

/**
 * The target's inventory, and the unattributed invocations of the same kind
 * sitting on another target's session, so none of them is relinkable here (as
 * in production, where none of the 16,015 unattributed rows read 2026-10-21
 * was). Seeded on the fixture connection inside its rolled-back transaction.
 */
async function seedPlannerCorpus(
  client: FixtureRawClient,
  ids: PlannerCorpusIds
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO organizations (id, clerk_id, name, slug, updated_at)
     VALUES ($1::uuid, 'iss12872-' || $1, 'ISS-12872 planner', 'iss12872-' || $1, now())`,
    ids.organizationId
  );
  await client.$executeRawUnsafe(
    `INSERT INTO users (id, clerk_id, organization_id, email, updated_at)
     VALUES ($1::uuid, 'iss12872-' || $1, $2::uuid, 'iss12872-' || $1 || '@example.test', now())`,
    ids.userId,
    ids.organizationId
  );
  await client.$executeRawUnsafe(
    `INSERT INTO compute_targets (id, organization_id, user_id, machine_name, platform, updated_at)
     VALUES ($1::uuid, $3::uuid, $4::uuid, 'iss12872', 'darwin', now()),
            ($2::uuid, $3::uuid, $4::uuid, 'iss12872-other', 'darwin', now())`,
    ids.computeTargetId,
    ids.otherComputeTargetId,
    ids.organizationId,
    ids.userId
  );
  await client.$executeRawUnsafe(
    `INSERT INTO agent_components (id, organization_id, compute_target_id, component_kind, component_key, external_component_id, updated_at)
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3, 'key-' || i, 'iss12872-' || i, now()
     FROM generate_series(1, $4::int) AS i`,
    ids.organizationId,
    ids.computeTargetId,
    AgentComponentKind.Subagent,
    PLANNER_INVENTORY_ROWS
  );
  await client.$executeRawUnsafe(
    `INSERT INTO artifacts (id, organization_id, type, name, status, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::"ArtifactType", 'ISS-12872 planner', $4, now())`,
    ids.sessionId,
    ids.organizationId,
    ArtifactType.SESSION,
    SESSION_STATUS.ACTIVE
  );
  await client.$executeRawUnsafe(
    `INSERT INTO session_detail (artifact_id, compute_target_id, external_session_id, session_started_at, session_updated_at, updated_at, last_activity_at)
     VALUES ($1::uuid, $2::uuid, 'iss12872-' || $1, now(), now(), now(), now())`,
    ids.sessionId,
    ids.otherComputeTargetId
  );
  await client.$executeRawUnsafe(
    `INSERT INTO agent_component_invocation_generations (id, agent_session_id, external_generation_id, source_updated_at, data_revision, source_sequence, expected_part_count, active_at, completed_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'iss12872', now(), 1, 1, 1, now(), now(), now())`,
    ids.generationId,
    ids.sessionId
  );
  await client.$executeRawUnsafe(
    `INSERT INTO agent_component_invocation_parts (id, generation_id, part_index, part_hash, item_count, payload_bytes)
     VALUES ($1::uuid, $2::uuid, 0, 'iss12872', $3::int, 1)`,
    ids.partId,
    ids.generationId,
    PLANNER_UNATTRIBUTED_ROWS
  );
  await client.$executeRawUnsafe(
    `INSERT INTO agent_component_invocations (id, generation_id, part_id, external_invocation_id, source_session_id, component_kind, component_key, relationship, sequence, anchor, attribution_status, evidence_class, updated_at)
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'iss12872-' || i, 'iss12872', $3, 'key-' || (i % $5::int), $6, i, '{}'::jsonb, $7, $8, now()
     FROM generate_series(1, $4::int) AS i`,
    ids.generationId,
    ids.partId,
    AgentComponentKind.Subagent,
    PLANNER_UNATTRIBUTED_ROWS,
    PLANNER_UNATTRIBUTED_KEYS,
    AgentComponentInvocationRelationship.Direct,
    Status.Unresolved,
    AgentComponentInvocationEvidenceClass.TranscriptSnapshot
  );
}
