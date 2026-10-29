import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeAgentComponentInvocationKey } from "@repo/api/src/types/agent-component-invocation";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../../scripts/seed/__tests__/fixtures/ephemeral-db";
import {
  INDEX_COND_LABEL,
  requireNonEmptyPlan,
  requireScanNode,
} from "../test-helpers/explain-plan";
import { settleAll } from "../test-helpers/settle-all";

/**
 * ISS-6757 — the persisted `component_key_normalized` projection (migrations
 * 20260820140000 / 220100) and the partial index built on it (20260820140200),
 * which together make `invocationReadWhere`'s fallback arm
 * (apps/api/app/agent-components/service/invocation-read.ts) sargable.
 *
 * This suite runs against a real Postgres that has had `prisma migrate deploy`
 * applied, so the trigger, the backfill statement and the index under test are
 * the ones the migrations actually create. The trigger and the data migration
 * are UNMANAGED by Prisma — its DSL can declare neither — and while the index
 * itself is declared in `schema.prisma` since ISS-7476, every failure mode here
 * is still SILENT rather than loud: the read would return fewer invocations than
 * exist, not an error.
 *
 * Four things are asserted, none of which a mock can judge:
 *
 *  1. the trigger really owns the column, on INSERT and on an UPDATE that
 *     re-points `component_key`;
 *  2. `normalizeAgentComponentInvocationKey` — the READ half of the folding
 *     contract, written in TypeScript — agrees with the WRITE half, written in
 *     SQL as `lower()`, over a key set that includes the shapes real component
 *     keys take;
 *  3. the planner really uses the index for the read's fallback arm instead of
 *     scanning every unattributed invocation in the table;
 *  4. the index is PURELY a plan change — the same predicate returns identical
 *     rows with it present and with it dropped — while the ILIKE it replaces
 *     was NOT purely a plan concern: it treated `_` in a key as a wildcard.
 *
 * Rows are written under throwaway organizations and removed in `afterAll`.
 */

const INVOCATIONS_TABLE = "agent_component_invocations";
const INDEX_NAME = "idx_aci_kind_key_normalized_unattributed";
const TRIGGER_NAME = "trg_aci_fold_component_key";
const BACKFILL_MIGRATION =
  "20260820140100_iss6757_backfill_invocation_component_key_normalized";

const ORG_ID = randomUUID();

/**
 * Eleven decoy organizations alongside the one under test, each holding the
 * same component keys. The count is not decorative. This table carries NO
 * `organization_id` column — the org scope arrives through the
 * generation -> session -> artifact join — so the fallback arm's pre-index scan
 * spans every tenant's rows. A single-org fixture cannot show that, and a plan
 * that dropped the org join would return 12x the rows and fail the equivalence
 * cases outright rather than silently.
 */
const DECOY_ORG_IDS: readonly string[] = Array.from({ length: 11 }, () =>
  randomUUID()
);
const ALL_ORG_IDS: readonly string[] = [ORG_ID, ...DECOY_ORG_IDS];
const COMPUTE_TARGET_IDS: readonly string[] = ALL_ORG_IDS.map(() =>
  randomUUID()
);

/** Sessions per organization, and invocations per session's one generation. */
const SESSIONS_PER_ORG = 12;
const INVOCATIONS_PER_GENERATION = 250;

/**
 * The subagent key under test, stored in the provider's raw case exactly as the
 * collector records it (`content-hash-identity.ts` documents `Explore` as the
 * real shape). The read requests it through the normalized slug, so the two
 * cases only meet through the folding contract.
 */
const SUBAGENT_KIND = "subagent";
const STORED_SUBAGENT_KEY = "Explore";
const REQUESTED_SUBAGENT_KEY = "explore";
/** One in this many seeded invocations carries STORED_SUBAGENT_KEY. */
const SUBAGENT_KEY_EVERY = 25;
const EXPECTED_MATCHES_PER_ORG =
  INVOCATIONS_PER_GENERATION / SUBAGENT_KEY_EVERY;

/**
 * A folded value that is deliberately NOT `lower(component_key)`, planted so the
 * backfill's `IS NULL` guard has something it can actually be caught skipping.
 */
const PRESERVED_SENTINEL = "sentinel-not-the-fold";

/** The pre-index plan node this change exists to eliminate. */
const SEQ_SCAN_RE = /Seq Scan on agent_component_invocations/;

/**
 * An MCP key, stored verbatim. `_` is an ILIKE wildcard, so before this change
 * `component_key ILIKE 'mcp__closedloop__search'` also matched the decoy below
 * — a different component folded into this one's invocation page.
 */
const MCP_KIND = "mcp";
const MCP_KEY = "mcp__closedloop__search";
const MCP_ILIKE_DECOY_KEY = "mcpXXclosedloopXXsearch";

/**
 * Keys whose JS fold and Postgres fold DISAGREE (measured on `en_US.utf8`):
 * `İ` U+0130 folds to `i` in Postgres and `i` + U+0307 in JS, and a word-final
 * `Σ` folds to `σ` in Postgres and `ς` in JS. The requested key is already
 * JS-folded upstream by `normalizeComponentKey`, so the ILIKE predicate this
 * change replaces missed these too — the case below is what proves that, and
 * therefore that the equality is not a regression on them.
 */
const FOLD_DIVERGENT_KEYS: readonly string[] = ["İstanbul", "ΣΟΦΟΣ"];

/**
 * The folding contract's cases. Each is stored verbatim and must come back
 * folded to exactly what `normalizeAgentComponentInvocationKey` produces.
 */
const FOLDING_CASES: readonly string[] = [
  "Explore",
  "BASH",
  "mcp__closedloop__search",
  "deploy-to-prod",
  "Skill/Deploy",
  "Ünïcode-Käy",
];

type InvocationRow = { id: string; component_key: string };

type IndexComparison = {
  withIndex: InvocationRow[];
  withoutIndex: InvocationRow[];
};

describe.skipIf(!process.env.DATABASE_URL)(
  "agent_component_invocations component_key_normalized (integration)",
  () => {
    let ctx: EphemeralDbContext;

    beforeAll(async () => {
      ctx = await setupEphemeralDb();
      await seedInvocations(ctx);
    }, 180_000);

    afterAll(async () => {
      if (!ctx) {
        return;
      }
      // `setupEphemeralDb` opens a PrismaClient and a pg.Pool against the
      // SHARED database, so a failing DELETE must not leak either for the rest
      // of the run. `settleAll` runs every step and surfaces all failures
      // instead of replacing the cause with the teardown's error.
      await settleAll(
        [
          () =>
            ctx.prisma.$executeRawUnsafe(
              'DELETE FROM "artifacts" WHERE "organization_id" = ANY($1::uuid[])',
              [...ALL_ORG_IDS]
            ),
          () =>
            ctx.prisma.$executeRawUnsafe(
              'DELETE FROM "compute_targets" WHERE "id" = ANY($1::uuid[])',
              [...COMPUTE_TARGET_IDS]
            ),
          () =>
            ctx.prisma.$executeRawUnsafe(
              'DELETE FROM "organizations" WHERE "id" = ANY($1::uuid[])',
              [...ALL_ORG_IDS]
            ),
          () => teardownEphemeralDb(ctx),
        ],
        "iss6757 invocation index suite teardown failed"
      );
    }, 180_000);

    it("migration 20260820140000 installed the fold trigger on the invocation table", async () => {
      const rows = await ctx.prisma.$queryRawUnsafe<
        { tgname: string; definition: string }[]
      >(
        `SELECT t.tgname, pg_get_triggerdef(t.oid) AS definition
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
          WHERE c.relname = $1 AND t.tgname = $2 AND NOT t.tgisinternal`,
        INVOCATIONS_TABLE,
        TRIGGER_NAME
      );

      expect(rows).toHaveLength(1);
      const definition = rows[0].definition;
      // BEFORE, so the folded value lands in the same tuple. Listing the two
      // key columns keeps the `relinkActiveForComputeTarget` repair — which
      // names neither — off the trigger's cost, while still catching a
      // statement that writes the DERIVED column directly.
      expect(definition).toContain(
        "BEFORE INSERT OR UPDATE OF component_key, component_key_normalized"
      );
      expect(definition).toContain("FOR EACH ROW");
    });

    it("migration 20260820140200 built a PARTIAL two-column index in the arm's order", async () => {
      const rows = await ctx.prisma.$queryRawUnsafe<{ indexdef: string }[]>(
        "SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2",
        INVOCATIONS_TABLE,
        INDEX_NAME
      );

      expect(rows).toHaveLength(1);
      const def = rows[0].indexdef;
      // Column order is load-bearing: component_kind is the arm's
      // always-present equality and must lead.
      expect(def).toContain("(component_kind, component_key_normalized)");
      // Partial on the arm's own predicate; dropping it indexes rows this arm
      // can never return.
      expect(def).toContain("WHERE (agent_component_id IS NULL)");
      expect(def).not.toContain("UNIQUE");
    });

    it("folds every stored key to exactly what the read side computes", async () => {
      // The contract that keeps the SQL write half (`lower()`, in the trigger)
      // and the TypeScript read half (`normalizeAgentComponentInvocationKey`)
      // from drifting. A divergence here does not raise — it makes a
      // component's invocations vanish from its detail page — so it is proved
      // against a real database rather than reasoned about.
      const stored = await readStoredFolding(ctx);

      expect(stored).toEqual(
        FOLDING_CASES.map((key) => ({
          component_key: key,
          component_key_normalized: normalizeAgentComponentInvocationKey(key),
        }))
      );
    });

    it("was already missing the two keys whose JS and Postgres folds disagree", async () => {
      // Not a defence of the gap — a proof of its provenance. If the OLD
      // predicate had matched these, the equality would be a regression and
      // this case would fail rather than quietly recording a known limitation.
      const matchedByIlike = await ilikeMatchesJsFold(ctx, FOLD_DIVERGENT_KEYS);

      expect(matchedByIlike).toEqual([false, false]);
    });

    it("re-folds when an UPDATE re-points component_key", async () => {
      // The ISS-4923 skill-shadowed phantom re-point was a raw-SQL UPDATE of
      // `component_key` until ISS-12781 wrote it at insert; any such UPDATE
      // still must re-fold. Without `UPDATE OF component_key` on the trigger the derived
      // column would keep the pre-repoint value and the row would answer to the
      // wrong key forever.
      const { before, after } = await repointOneKey(ctx, "Repointed-Key");

      expect(before).toBe(normalizeAgentComponentInvocationKey("Original-Key"));
      expect(after).toBe(normalizeAgentComponentInvocationKey("Repointed-Key"));
    });

    it("re-folds when a writer sets component_key_normalized directly", async () => {
      // Prisma exposes the derived column as writable (whitlockk), so "the trigger
      // owns the projection" only holds if a statement that names it is folded
      // too. A persisted bad or NULL value is silent: the equality read simply
      // stops returning the row. Both corruptions are attempted here and both
      // must come back as `lower(component_key)`.
      const { corrupted, nulled } = await corruptNormalizedKey(ctx);

      expect(corrupted).toBe(normalizeAgentComponentInvocationKey("Owned-Key"));
      expect(nulled).toBe(normalizeAgentComponentInvocationKey("Owned-Key"));
    });

    it("backfills a row the trigger never saw, and only that row", async () => {
      // Executes the data migration's own statement, read from its file, so
      // this proves the shipped SQL rather than a copy of it. The row is
      // inserted with the trigger disabled to reproduce a pre-migration row.
      const { beforeBackfill, backfilled, preserved } =
        await runBackfillOnLegacyRow(ctx);

      // The fixture is only honest if the row really started unfolded — with
      // the trigger left on, the backfill would have nothing to prove.
      expect(beforeBackfill).toBeNull();
      expect(backfilled).toBe(
        normalizeAgentComponentInvocationKey("Legacy-Key")
      );
      // The `WHERE component_key_normalized IS NULL` guard, witnessed: deleting
      // it turns the migration into a whole-table rewrite on every re-run, and
      // this sentinel is what goes red when that happens.
      expect(preserved).toBe(PRESERVED_SENTINEL);
    });

    it("plans the fallback arm through the index instead of scanning every tenant's unattributed rows", async () => {
      const plan = await explainFallbackArm(ctx);

      // Scoped to the node that reads THIS index, not to the invocation scan:
      // the planner combines it with `idx_aci_generation_sequence` under a
      // BitmapAnd here, so `Index Cond:` on the heap scan would be ambiguous
      // between the two. Read locally rather than through
      // `requireIndexPredicate`, which selects by RELATION (` on <table>`) and
      // so would throw on an equally-good `Index Scan using <index> on <table>`
      // plan — a false red on a correct plan. Absent index, absent node, absent
      // Index Cond all still throw.
      const indexCond = requireIndexCondForIndex(plan, INDEX_NAME);
      // BOTH columns must reach the Index Cond. Before this change the arm's
      // only sargable predicate was `agent_component_id IS NULL`, and the key
      // match was a post-scan Filter.
      expect(indexCond).toContain("component_kind");
      expect(indexCond).toContain("component_key_normalized");
      // The regression this replaces, stated directly: the pre-index plan was
      // `Parallel Seq Scan on agent_component_invocations` discarding the whole
      // table, so no sequential scan of it may survive.
      expect(requireScanNode(plan, INVOCATIONS_TABLE)).not.toMatch(SEQ_SCAN_RE);
    });

    it("returns an identical result set with and without the index", async () => {
      const { withIndex, withoutIndex } = await compareWithAndWithoutIndex(ctx);

      expect(withIndex).toHaveLength(
        SESSIONS_PER_ORG * EXPECTED_MATCHES_PER_ORG
      );
      // Every row is the requested component, in its stored raw case — the
      // folding is what bridges them, and it must not have widened the match.
      expect(
        withIndex.every((row) => row.component_key === STORED_SUBAGENT_KEY)
      ).toBe(true);
      expect(withIndex).toEqual(withoutIndex);
    });

    it("stops matching the `_`-wildcard neighbours the ILIKE predicate folded in", async () => {
      // Not a plan change: a deliberate narrowing. `_` is a single-character
      // ILIKE wildcard, so the old predicate returned a DIFFERENT component's
      // invocations on an MCP detail page. The exact key still matches in any
      // case, so nothing correct is lost.
      const [oldPredicate, newPredicate] = await Promise.all([
        matchesForIlikePredicate(ctx, MCP_KEY),
        matchesForNormalizedPredicate(ctx, MCP_KEY),
      ]);

      expect(oldPredicate).toContain(MCP_KEY);
      expect(oldPredicate).toContain(MCP_ILIKE_DECOY_KEY);
      expect(newPredicate).toEqual([MCP_KEY]);
    });
  }
);

/**
 * The fallback arm exactly as Prisma emits it for the orphan-only detail read
 * (`buildOrphanOnlyDetail` passes an EMPTY `inventoryIds`, so the `OR` collapses
 * to this one arm — detail-read-orphan.ts:145). Captured from the driver rather
 * than paraphrased, so the plan being measured is the plan production gets.
 */
const FALLBACK_ARM_SQL = `SELECT "public"."agent_component_invocations"."id"::text AS id,
       "public"."agent_component_invocations"."component_key"
  FROM "public"."agent_component_invocations"
  LEFT JOIN "public"."agent_component_invocation_generations" AS "j0"
    ON ("j0"."id") = ("public"."agent_component_invocations"."generation_id")
  LEFT JOIN "public"."session_detail" AS "j1"
    ON ("j1"."artifact_id") = ("j0"."agent_session_id")
  LEFT JOIN "public"."artifacts" AS "j2"
    ON ("j2"."id") = ("j1"."artifact_id")
 WHERE (("j0"."active_at" IS NOT NULL AND "j0"."completed_at" IS NOT NULL
         AND ("j2"."organization_id" = $1::uuid AND ("j2"."id" IS NOT NULL)
              AND ("j1"."artifact_id" IS NOT NULL))
         AND ("j0"."id" IS NOT NULL))
        AND ("public"."agent_component_invocations"."agent_component_id" IS NULL
             AND "public"."agent_component_invocations"."component_kind" = $2
             AND "public"."agent_component_invocations"."component_key_normalized" = $3))`;

/** The same arm ordered, so the with/without-index comparison is a deep equality. */
const FALLBACK_ARM_SQL_ORDERED = `${FALLBACK_ARM_SQL} ORDER BY id`;

/** The old and new key predicates, isolated from the join for the narrowing case. */
const KEY_PREDICATE_SQL = `SELECT DISTINCT component_key
  FROM agent_component_invocations
 WHERE agent_component_id IS NULL AND component_kind = $1`;

async function seedInvocations(ctx: EphemeralDbContext): Promise<void> {
  for (const [index, orgId] of ALL_ORG_IDS.entries()) {
    await ctx.prisma.organization.create({
      data: {
        id: orgId,
        clerkId: `iss6757-${orgId}`,
        name: `iss6757-${orgId}`,
        slug: `iss6757-${orgId}`,
      },
      select: { id: true },
    });
    await ctx.prisma.computeTarget.create({
      data: {
        id: COMPUTE_TARGET_IDS[index],
        organizationId: orgId,
        userId: ctx.userId,
        machineName: `iss6757-${COMPUTE_TARGET_IDS[index]}`,
        platform: "darwin",
      },
      select: { id: true },
    });
    await seedOrgInvocations(ctx, orgId, COMPUTE_TARGET_IDS[index]);
  }

  await ctx.prisma.$executeRawUnsafe(`ANALYZE ${INVOCATIONS_TABLE}`);
}

async function seedOrgInvocations(
  ctx: EphemeralDbContext,
  orgId: string,
  computeTargetId: string
): Promise<void> {
  // One statement per organization rather than per row: the planner's scan
  // choice depends on the table's absolute size, so the fixture has to be big
  // enough to be worth an index at all, and a per-row insert loop would make
  // that prohibitively slow.
  await ctx.prisma.$executeRawUnsafe(
    `WITH sessions AS (
       INSERT INTO artifacts (id, organization_id, "type", name, status, created_at, updated_at)
       SELECT gen_random_uuid(), $1::uuid, 'SESSION', 'iss6757-' || s::text, 'ACTIVE', now(), now()
       FROM generate_series(1, $3::int) AS s
       RETURNING id
     ), details AS (
       INSERT INTO session_detail
         (artifact_id, compute_target_id, external_session_id, session_started_at,
          session_updated_at, last_activity_at, created_at, updated_at)
       SELECT id, $2::uuid, 'iss6757-' || id::text, now(), now(), now(), now(), now()
       FROM sessions
       RETURNING artifact_id
     ), generations AS (
       INSERT INTO agent_component_invocation_generations
         (id, agent_session_id, external_generation_id, source_updated_at, data_revision,
          source_sequence, expected_part_count, active_at, completed_at, created_at, updated_at)
       SELECT gen_random_uuid(), artifact_id, 'iss6757-gen-' || artifact_id::text,
              now(), 1, 1, 1, now(), now(), now(), now()
       FROM details
       RETURNING id
     ), parts AS (
       INSERT INTO agent_component_invocation_parts
         (id, generation_id, part_index, part_hash, item_count, payload_bytes)
       SELECT gen_random_uuid(), id, 0, 'iss6757-part-' || id::text, $4::int, 4096
       FROM generations
       RETURNING id, generation_id
     )
     INSERT INTO agent_component_invocations
       (id, generation_id, part_id, external_invocation_id, source_session_id,
        component_kind, component_key, relationship, invoked_at, sequence, anchor,
        attribution_status, evidence_class, agent_component_id, created_at, updated_at)
     SELECT gen_random_uuid(), parts.generation_id, parts.id,
            'iss6757-inv-' || parts.id::text || '-' || i::text,
            'iss6757-session-' || parts.generation_id::text,
            CASE
              WHEN i % $5::int = 0 THEN $6
              WHEN i = 1 THEN $8
              WHEN i = 2 THEN $9
              ELSE 'tool'
            END,
            CASE
              WHEN i % $5::int = 0 THEN $7
              WHEN i = 1 THEN $10
              WHEN i = 2 THEN $11
              ELSE 'Component' || (i % 200)::text
            END,
            'direct', now() - (i::text || ' minutes')::interval, i,
            '{"kind":"session"}'::jsonb, 'unmatched', 'strong', NULL, now(), now()
     FROM parts, generate_series(1, $4::int) AS i`,
    orgId,
    computeTargetId,
    SESSIONS_PER_ORG,
    INVOCATIONS_PER_GENERATION,
    SUBAGENT_KEY_EVERY,
    SUBAGENT_KIND,
    STORED_SUBAGENT_KEY,
    MCP_KIND,
    MCP_KIND,
    MCP_KEY,
    MCP_ILIKE_DECOY_KEY
  );
}

async function readStoredFolding(
  ctx: EphemeralDbContext
): Promise<{ component_key: string; component_key_normalized: string }[]> {
  return await withRollback(ctx, async (tx) => {
    const anchor = await oneSeededRow(tx);
    const rows: { component_key: string; component_key_normalized: string }[] =
      [];
    for (const [index, key] of FOLDING_CASES.entries()) {
      rows.push(await insertProbeRow(tx, anchor, `fold-${index}`, key));
    }
    return rows;
  });
}

async function repointOneKey(
  ctx: EphemeralDbContext,
  nextKey: string
): Promise<{ before: string; after: string }> {
  return await withRollback(ctx, async (tx) => {
    const anchor = await oneSeededRow(tx);
    const probe = await insertProbeRow(tx, anchor, "repoint", "Original-Key");
    const updated = await tx.$queryRawUnsafe<
      { component_key_normalized: string }[]
    >(
      `UPDATE agent_component_invocations
          SET component_key = COALESCE($2, component_key), updated_at = now()
        WHERE external_invocation_id = $1
      RETURNING component_key_normalized`,
      `iss6757-probe-repoint-${anchor.generation_id}`,
      nextKey
    );
    return {
      before: probe.component_key_normalized,
      after: updated[0].component_key_normalized,
    };
  });
}

async function corruptNormalizedKey(
  ctx: EphemeralDbContext
): Promise<{ corrupted: string; nulled: string }> {
  return await withRollback(ctx, async (tx) => {
    const anchor = await oneSeededRow(tx);
    await insertProbeRow(tx, anchor, "owned", "Owned-Key");
    const externalId = `iss6757-probe-owned-${anchor.generation_id}`;
    const overwrite = async (value: string | null) => {
      const rows = await tx.$queryRawUnsafe<
        { component_key_normalized: string }[]
      >(
        `UPDATE agent_component_invocations
            SET component_key_normalized = $2
          WHERE external_invocation_id = $1
        RETURNING component_key_normalized`,
        externalId,
        value
      );
      return rows[0].component_key_normalized;
    };
    return {
      corrupted: await overwrite("not-the-fold"),
      nulled: await overwrite(null),
    };
  });
}

async function runBackfillOnLegacyRow(ctx: EphemeralDbContext): Promise<{
  beforeBackfill: string | null;
  backfilled: string;
  preserved: string;
}> {
  const backfillSql = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "prisma",
      "migrations",
      BACKFILL_MIGRATION,
      "migration.sql"
    ),
    "utf8"
  );

  return await withRollback(ctx, async (tx) => {
    const anchor = await oneSeededRow(tx);
    // Reproduce a row written before the trigger existed.
    await tx.$executeRawUnsafe(
      `ALTER TABLE agent_component_invocations DISABLE TRIGGER ${TRIGGER_NAME}`
    );
    const legacy = await insertProbeRow(tx, anchor, "legacy", "Legacy-Key");
    // A second row already carrying a value, and one that is deliberately NOT
    // `lower(component_key)`. `lower()` is idempotent, so a row already folded
    // correctly would read the same whether the `IS NULL` guard ran or not —
    // it cannot witness the guard. This row can: the guard is the only thing
    // standing between it and being rewritten.
    await insertProbeRow(tx, anchor, "preserved", "Preserved-Key");
    await tx.$executeRawUnsafe(
      `UPDATE agent_component_invocations SET component_key_normalized = $2
        WHERE external_invocation_id = $1`,
      `iss6757-probe-preserved-${anchor.generation_id}`,
      PRESERVED_SENTINEL
    );
    await tx.$executeRawUnsafe(
      `ALTER TABLE agent_component_invocations ENABLE TRIGGER ${TRIGGER_NAME}`
    );

    await tx.$executeRawUnsafe(backfillSql);

    const rows = await tx.$queryRawUnsafe<
      { external_invocation_id: string; component_key_normalized: string }[]
    >(
      `SELECT external_invocation_id, component_key_normalized
         FROM agent_component_invocations
        WHERE external_invocation_id = ANY($1::text[])`,
      [
        `iss6757-probe-legacy-${anchor.generation_id}`,
        `iss6757-probe-preserved-${anchor.generation_id}`,
      ]
    );
    return {
      beforeBackfill: legacy.component_key_normalized,
      backfilled: requireProbe(
        rows,
        `iss6757-probe-legacy-${anchor.generation_id}`
      ),
      preserved: requireProbe(
        rows,
        `iss6757-probe-preserved-${anchor.generation_id}`
      ),
    };
  });
}

/** The one probe row's folded value, or an error naming the row that is absent. */
function requireProbe(
  rows: readonly {
    external_invocation_id: string;
    component_key_normalized: string;
  }[],
  externalInvocationId: string
): string {
  const row = rows.find(
    (candidate) => candidate.external_invocation_id === externalInvocationId
  );
  if (!row) {
    throw new Error(
      `iss6757: the backfill probe row ${externalInvocationId} was not read back`
    );
  }
  return row.component_key_normalized;
}

/**
 * The `Index Cond:` on the one plan node that reads `indexName`.
 *
 * PostgreSQL spells that node two ways depending on the access path it picks —
 * `Bitmap Index Scan on <index>` and `Index Scan using <index> on <table>` —
 * and both are correct outcomes for this query, so the node is selected by the
 * index name appearing in its header rather than by node kind. Fails closed on
 * absent, ambiguous, and Index-Cond-less, for the same reason the shared
 * `explain-plan` readers do: this is an existence claim about a pushed-down
 * predicate, and an unevaluated one must not read as satisfied.
 */
function requireIndexCondForIndex(plan: string, indexName: string): string {
  const lines = plan.split("\n");
  const headers = lines
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line, index }) =>
        (index === 0 || line.trimStart().startsWith("->")) && line.trim() !== ""
    )
    .map(({ index }) => index);
  const matched = headers.filter((index) => lines[index].includes(indexName));
  if (matched.length !== 1) {
    throw new Error(
      `Expected exactly one plan node reading "${indexName}", found ${matched.length}. An absent node means the predicate never reached the index; more than one is ambiguous. Neither may pass.\nPlan:\n${plan}`
    );
  }
  const start = matched[0];
  const end = headers.find((index) => index > start) ?? lines.length;
  const conds = lines
    .slice(start, end)
    .filter((line) => line.includes(INDEX_COND_LABEL));
  if (conds.length !== 1) {
    throw new Error(
      `The node reading "${indexName}" exposes ${conds.length} "${INDEX_COND_LABEL}" lines, so there is no single pushed-down predicate to assert on.\nPlan:\n${plan}`
    );
  }
  return conds[0];
}

/**
 * Whether `<stored key> ILIKE <JS fold of that key>` — the predicate this change
 * replaces, driven with the value the read actually passed it — matched at all.
 */
async function ilikeMatchesJsFold(
  ctx: EphemeralDbContext,
  keys: readonly string[]
): Promise<boolean[]> {
  const rows = await ctx.prisma.$queryRawUnsafe<{ matched: boolean }[]>(
    `SELECT k.stored ILIKE k.requested AS matched
       FROM unnest($1::text[], $2::text[]) AS k(stored, requested)`,
    [...keys],
    keys.map((key) => normalizeAgentComponentInvocationKey(key))
  );
  return rows.map((row) => row.matched);
}

async function explainFallbackArm(ctx: EphemeralDbContext): Promise<string> {
  const rows = await ctx.prisma.$queryRawUnsafe<Record<string, string>[]>(
    `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${FALLBACK_ARM_SQL}`,
    ORG_ID,
    SUBAGENT_KIND,
    normalizeAgentComponentInvocationKey(REQUESTED_SUBAGENT_KEY)
  );
  return requireNonEmptyPlan(
    rows.map((row) => Object.values(row)[0]).join("\n"),
    `EXPLAIN of the invocation-read fallback arm for kind=${SUBAGENT_KIND} key=${REQUESTED_SUBAGENT_KEY}`
  );
}

/**
 * Run the fallback arm twice inside one transaction — once as the migrated
 * database plans it, then again with the index dropped — and roll back so the
 * index survives. `DROP INDEX` is transactional in PostgreSQL, which is what
 * makes a true before/after comparison possible inside a test.
 */
async function compareWithAndWithoutIndex(
  ctx: EphemeralDbContext
): Promise<IndexComparison> {
  const args = [
    ORG_ID,
    SUBAGENT_KIND,
    normalizeAgentComponentInvocationKey(REQUESTED_SUBAGENT_KEY),
  ];
  return await withRollback(ctx, async (tx) => {
    const withIndex = await tx.$queryRawUnsafe<InvocationRow[]>(
      FALLBACK_ARM_SQL_ORDERED,
      ...args
    );
    // Errors here if the migration never built the index, which is the point.
    await tx.$executeRawUnsafe(`DROP INDEX "${INDEX_NAME}"`);
    const withoutIndex = await tx.$queryRawUnsafe<InvocationRow[]>(
      FALLBACK_ARM_SQL_ORDERED,
      ...args
    );
    return { withIndex, withoutIndex };
  });
}

async function matchesForIlikePredicate(
  ctx: EphemeralDbContext,
  key: string
): Promise<string[]> {
  const rows = await ctx.prisma.$queryRawUnsafe<{ component_key: string }[]>(
    `${KEY_PREDICATE_SQL} AND component_key ILIKE $2 ORDER BY component_key`,
    MCP_KIND,
    key
  );
  return rows.map((row) => row.component_key);
}

async function matchesForNormalizedPredicate(
  ctx: EphemeralDbContext,
  key: string
): Promise<string[]> {
  const rows = await ctx.prisma.$queryRawUnsafe<{ component_key: string }[]>(
    `${KEY_PREDICATE_SQL} AND component_key_normalized = $2 ORDER BY component_key`,
    MCP_KIND,
    normalizeAgentComponentInvocationKey(key)
  );
  return rows.map((row) => row.component_key);
}

type SeededAnchor = {
  generation_id: string;
  part_id: string;
  component_key_normalized: string;
};

/** One seeded invocation, used as the FK anchor for the probe rows. */
async function oneSeededRow(tx: TransactionalClient): Promise<SeededAnchor> {
  const rows = await tx.$queryRawUnsafe<SeededAnchor[]>(
    `SELECT generation_id::text AS generation_id, part_id::text AS part_id,
            component_key_normalized
       FROM agent_component_invocations
      WHERE component_key = $1
      LIMIT 1`,
    STORED_SUBAGENT_KEY
  );
  if (rows.length === 0) {
    throw new Error(
      `iss6757: the fixture seeded no invocation carrying component_key ${STORED_SUBAGENT_KEY}`
    );
  }
  return rows[0];
}

async function insertProbeRow(
  tx: TransactionalClient,
  anchor: SeededAnchor,
  label: string,
  key: string
): Promise<{ component_key: string; component_key_normalized: string }> {
  const rows = await tx.$queryRawUnsafe<
    { component_key: string; component_key_normalized: string }[]
  >(
    `INSERT INTO agent_component_invocations
       (id, generation_id, part_id, external_invocation_id, source_session_id,
        component_kind, component_key, relationship, invoked_at, sequence, anchor,
        attribution_status, evidence_class, agent_component_id, created_at, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'iss6757-probe',
             $4, $5, 'direct', now(), 0, '{"kind":"session"}'::jsonb,
             'unmatched', 'strong', NULL, now(), now())
     RETURNING component_key, component_key_normalized`,
    anchor.generation_id,
    anchor.part_id,
    `iss6757-probe-${label}-${anchor.generation_id}`,
    SUBAGENT_KIND,
    key
  );
  return rows[0];
}

/**
 * Run `body` in a transaction that is always rolled back, so probe rows and
 * schema pokes (a dropped index, a disabled trigger) never outlive the case.
 */
async function withRollback<T>(
  ctx: EphemeralDbContext,
  body: (tx: TransactionalClient) => Promise<T>
): Promise<T> {
  let result: { value: T } | null = null;
  try {
    await ctx.prisma.$transaction(
      async (tx) => {
        result = { value: await body(tx) };
        throw new RollbackSignal();
      },
      { timeout: 60_000 }
    );
  } catch (error) {
    // Anything other than our own sentinel is a real failure — most usefully
    // the `DROP INDEX` or the trigger poke erroring because the migration never
    // created the object.
    if (!(error instanceof RollbackSignal)) {
      throw error;
    }
  }
  if (result === null) {
    throw new Error(
      "iss6757: the rollback transaction never captured a result, so the case cannot be evaluated"
    );
  }
  return (result as { value: T }).value;
}

/** Sentinel used to roll back the probe transactions. */
class RollbackSignal extends Error {
  constructor() {
    super("iss6757: intentional rollback");
    this.name = "RollbackSignal";
  }
}

type TransactionalClient = Parameters<
  Parameters<EphemeralDbContext["prisma"]["$transaction"]>[0]
>[0];
