import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../../scripts/seed/__tests__/fixtures/ephemeral-db";
import {
  requireIndexPredicate,
  requireScanNode,
} from "../test-helpers/explain-plan";
import { settleAll } from "../test-helpers/settle-all";

/**
 * ISS-8496 — every referential action reachable from `DELETE FROM projects`
 * must be able to seek an index.
 *
 * WHY THE ASSERTION IS A CATALOG INVARIANT AND NOT A TIMING BOUND. The defect is
 * a slow delete, but the repo bans timing assertions
 * (scripts/lint/rules/no-timing-assertions.ts) and a wall-clock threshold on a
 * shared integration database would be flaky in both directions. The mechanism
 * underneath the slowness is exact and catalog-visible: Postgres runs a
 * referential action constrained on the FOREIGN KEY COLUMN ALONE, with no
 * `organization_id` to supply, so an index can serve it only if that column
 * LEADS the index. Asserting the invariant tests the cause rather than a
 * symptom, and it fails for any FK that loses its index by any route.
 *
 * THIS IS A REGRESSION TEST, NOT A PROXY: it goes red on the pre-ISS-8496 schema
 * with ten violations (artifacts.project_id, artifact_activity_events,
 * comment_threads, artifact_links.target_id, delivery_point_artifacts,
 * delivery_points.branch_artifact_id,
 * monitored_session_activity_quarantine.session_artifact_id,
 * delivery_points.pull_request_detail_id,
 * github_comment_thread_projections.branch_artifact_id and
 * agent_component_invocations.part_id).
 *
 * THE CASCADE IS WALKED, NOT LISTED. The last three above are more than one hop
 * past `artifacts`, and an earlier revision of this file held a literal
 * ["projects", "artifacts"] parent list that could not see them at all. What the
 * delete reaches is a property of the schema's ON DELETE CASCADE edges, so the
 * query derives it (see {@link foreignKeysWithServingIndex}); a hand-written
 * list is only ever as deep as its last editor.
 *
 * AND IT GUARDS THE ROUTE THE ORIGINAL INDEX WAS LOST BY, which no
 * "does index X exist" assertion would. `artifacts(project_id)` was never
 * deleted: it was created in 20260203204426, RENAMED to
 * `documents_project_id_idx` in 20260421120000 when the legacy table vacated the
 * `artifacts` name, and dropped with that table when the new parent reclaimed
 * the name in 20260422180000. A grep for the `CREATE INDEX` still finds it. Only
 * the catalog knows it is gone, and only an invariant over ALL of them notices
 * when the next table does the same thing.
 */

/**
 * The one table the delete statement names. Everything else on the cascade is
 * DERIVED from the catalog by {@link foreignKeysWithServingIndex}, not listed
 * here.
 *
 * It used to be a hand-written `["projects", "artifacts"]`, which stopped the
 * invariant two levels deep and is why `delivery_points(pull_request_detail_id)`
 * shipped unserved: deleting a project cascades into `artifacts`, `artifacts`
 * cascades into `pull_request_detail`, and only THEN does that SET NULL fire.
 * A list of parents can only ever be as deep as whoever last edited it; the
 * recursive walk is as deep as the schema.
 */
const CASCADE_ROOT = "projects";

/**
 * The count of FK constraints this invariant covered when it was written
 * (48 tables in the transitive ON DELETE CASCADE closure of `projects`, 63
 * foreign keys pointing at one of them).
 *
 * A floor, not an equality: new children anywhere on the cascade are expected
 * and each is simply held to the same rule. The floor exists so that a query
 * that silently stopped matching — a renamed table, a `regclass` that no longer
 * resolves, a recursive term that stopped recursing — fails loudly instead of
 * asserting the invariant over an empty set and passing.
 */
const MIN_COVERED_CONSTRAINTS = 63;

/**
 * Rows for the seq-scan-vs-index-scan plan assertion, spread over
 * {@link DECOY_PROJECT_IDS} rather than all parented to the project under test.
 *
 * Selectivity is the whole fixture. Written first with every artifact under the
 * one project, `project_id = $1` selected 100% of the table and Postgres chose a
 * sequential scan — correctly, and with the index in place. That failure was the
 * fixture, not the index. The project under test therefore holds a small share,
 * which is also the shape the operator reported: a project that looks drained in
 * the UI still cascades, and its lookup has to stay cheap.
 */
const SEEDED_ARTIFACTS = 6000;

/**
 * A throwaway child of `artifacts` used by the INVALID-index test, and the
 * half-built unique index it deliberately fails to create.
 *
 * A real table rather than a catalog edit: `UPDATE pg_index SET indisvalid` needs
 * superuser and would prove only that the query reads a column, whereas a failed
 * concurrent unique build leaves exactly the remnant production leaves.
 */
const PROBE_TABLE = "iss8496_invalid_index_probe";
const PROBE_INDEX = "iss8496_invalid_index_probe_artifact_id_idx";

const ORG_ID = randomUUID();
const PROJECT_ID = randomUUID();
const DECOY_PROJECT_IDS: readonly string[] = Array.from({ length: 19 }, () =>
  randomUUID()
);
const ALL_PROJECT_IDS: readonly string[] = [PROJECT_ID, ...DECOY_PROJECT_IDS];

type FkRow = {
  child_table: string;
  lead_col: string;
  conname: string;
  serving_index: string | null;
};

describe.skipIf(!process.env.DATABASE_URL)(
  "project delete cascade FK indexes (integration)",
  () => {
    let ctx: EphemeralDbContext;

    beforeAll(async () => {
      ctx = await setupEphemeralDb();
      await seed(ctx);
    }, 300_000);

    afterAll(async () => {
      if (!ctx) {
        return;
      }
      await settleAll(
        [
          // Before the artifact delete: the probe references `artifacts`, and
          // its own test drops it in a `finally` — this is the second net, for
          // a run killed between the two.
          () => dropProbe(ctx),
          () =>
            ctx.prisma.$executeRawUnsafe(
              'DELETE FROM "artifacts" WHERE "organization_id" = $1::uuid',
              ORG_ID
            ),
          () =>
            ctx.prisma.$executeRawUnsafe(
              'DELETE FROM "projects" WHERE "id" = ANY($1::uuid[])',
              [...ALL_PROJECT_IDS]
            ),
          () =>
            ctx.prisma.$executeRawUnsafe(
              'DELETE FROM "organizations" WHERE "id" = $1::uuid',
              ORG_ID
            ),
          // Same reason the ISS-7804 suite re-analyzes: this fixture's ANALYZE
          // keeps describing a table that no longer holds these rows, and the
          // other planner guards on this shared database cost their plans
          // against exactly those statistics.
          () => ctx.prisma.$executeRawUnsafe("ANALYZE artifacts"),
          () => ctx.prisma.$executeRawUnsafe("ANALYZE comment_threads"),
          () => teardownEphemeralDb(ctx),
        ],
        "ISS-8496 cascade FK index suite teardown failed"
      );
    }, 300_000);

    it("indexes every foreign key that a project delete cascades through", async () => {
      const rows = await foreignKeysWithServingIndex(ctx);

      // Fail closed on a query that stopped matching anything: an empty result
      // would satisfy the `unserved` assertion below while proving nothing.
      expect(rows.length).toBeGreaterThanOrEqual(MIN_COVERED_CONSTRAINTS);

      const unserved = rows.filter((row) => row.serving_index === null);
      expect(
        unserved.map((r) => `${r.child_table}(${r.lead_col}) [${r.conname}]`)
      ).toEqual([]);
    });

    it("serves the artifacts project_id cascade from a project_id-leading index", async () => {
      const rows = await foreignKeysWithServingIndex(ctx);
      const artifactsFk = rows.find(
        (row) =>
          row.child_table === "artifacts" && row.lead_col === "project_id"
      );

      // Named explicitly because this is the constraint the operator's report
      // was about, and because `artifacts` carries two org-leading composites
      // that MENTION project_id — a check that only looked for the column name
      // somewhere in an index definition would have called this served all along.
      expect(artifactsFk).toBeDefined();
      expect(artifactsFk?.serving_index).toBe("artifacts_project_id_idx");
    });

    it("reaches referential actions more than one cascade hop past artifacts", async () => {
      const rows = await foreignKeysWithServingIndex(ctx);
      const byName = (name: string) => rows.find((r) => r.conname === name);

      // These three are the reason the parent list became a recursive walk.
      // NONE of them appears in the set when the closure is the hand-written
      // ["projects", "artifacts"]: each hangs off a table that `artifacts`
      // cascades INTO, so a depth-2 invariant is green while the delete is
      // still sequentially scanning their tables once per parent row.
      //
      //   delivery_points(pull_request_detail_id)
      //     projects -> artifacts -> pull_request_detail -> here (SET NULL)
      //   github_comment_thread_projections(branch_artifact_id)
      //     projects -> artifacts -> branch_detail -> here (CASCADE)
      //   agent_component_invocations(part_id)
      //     projects -> artifacts -> session_detail -> ...
      //       -> agent_component_invocation_parts -> here (CASCADE)
      expect(byName("delivery_points_pull_request_detail_id_fkey")).toEqual(
        expect.objectContaining({
          child_table: "delivery_points",
          lead_col: "pull_request_detail_id",
          serving_index: "delivery_points_pull_request_detail_id_idx",
        })
      );
      expect(
        byName("github_comment_thread_projections_branch_artifact_id_fkey")
      ).toEqual(
        expect.objectContaining({
          child_table: "github_comment_thread_projections",
          lead_col: "branch_artifact_id",
          serving_index:
            "github_comment_thread_projections_branch_artifact_id_idx",
        })
      );
      expect(byName("fk_aci_part")).toEqual(
        expect.objectContaining({
          child_table: "agent_component_invocations",
          lead_col: "part_id",
          serving_index: "agent_component_invocations_part_id_idx",
        })
      );
    });

    it("does not count an INVALID concurrent index as serving a cascade FK", async () => {
      // An index left behind by a cancelled or crashed `CREATE INDEX
      // CONCURRENTLY` is a complete pg_index row that the PLANNER IGNORES. A
      // catalog guard that does not filter `indisvalid` reports the delete path
      // as indexed while every one of these lookups is back on a Seq Scan —
      // which is the single state this whole suite exists to notice.
      //
      // The remnant is produced the way production produces one, not by editing
      // the catalog: a UNIQUE concurrent build over duplicate values fails and
      // leaves its half-built index behind INVALID.
      await dropProbe(ctx);
      try {
        await createInvalidIndexProbe(ctx);

        const state = await ctx.prisma.$queryRawUnsafe<
          { indisvalid: boolean }[]
        >(
          `SELECT i.indisvalid
             FROM pg_index i
            WHERE i.indexrelid = $1::regclass`,
          PROBE_INDEX
        );
        // Fail loudly if the fixture did not actually produce a remnant: an
        // absent or VALID index would make the assertion below pass for the
        // wrong reason.
        expect(state).toEqual([{ indisvalid: false }]);

        const rows = await foreignKeysWithServingIndex(ctx);
        const probeFk = rows.find((r) => r.child_table === PROBE_TABLE);

        // Present (the probe really does hang off the cascade) and unserved
        // (its only leading-column index is the invalid remnant).
        expect(probeFk?.lead_col).toBe("artifact_id");
        expect(probeFk?.serving_index).toBeNull();
      } finally {
        await dropProbe(ctx);
      }
    });

    it("plans the artifacts cascade lookup as an index scan, not a table scan", async () => {
      const plan = await explain(
        ctx,
        'SELECT 1 FROM "artifacts" WHERE "project_id" = $1::uuid FOR KEY SHARE',
        PROJECT_ID
      );
      // The statement is the shape of the referential action Postgres runs for
      // `artifacts_project_id_fkey`. Before this migration the same statement
      // planned as a Seq Scan over the whole table, which is why deleting a
      // project whose artifacts had all been moved away was still slow.
      //
      // The assertion is "the predicate reached an index", not "the node is an
      // Index Scan": at this fixture's selectivity Postgres picks a Bitmap Heap
      // Scan, and at a drained project's it picks a plain Index Scan. Both are
      // the fix working. Pinning one of them would make this suite fail on a
      // healthy plan the moment the row distribution moved.
      expect(requireScanNode(plan, "artifacts")).not.toContain("Seq Scan");
      expect(requireIndexPredicate(plan, "artifacts")).toContain("project_id");
      expect(plan).toContain("artifacts_project_id_idx");
    });
  }
);

/**
 * Every foreign key pointing at a table the project delete can reach, paired
 * with an index whose LEADING key column is the constraint's own leading column
 * — or `null` when no such index exists.
 *
 * THE `deleted` TERM IS THE FIX FOR THE ORIGINAL BLIND SPOT. It is the
 * transitive closure of `ON DELETE CASCADE` (`confdeltype = 'c'`) out of
 * `projects`: those, and only those, are the rows the one DELETE statement
 * actually removes. `UNION` rather than `UNION ALL` terminates the walk on the
 * schema's FK cycles. SET NULL / SET DEFAULT are deliberately NOT followed —
 * they update the child rather than delete it, so nothing propagates past them
 * — but they are still CHECKED, because the outer query takes every inbound FK
 * regardless of action: CASCADE, SET NULL, RESTRICT and NO ACTION all have to
 * FIND the referencing rows before they can do anything with them.
 *
 * `indkey[0]` rather than a text match on `indexdef`: a composite that merely
 * mentions the column reads as a match in text and cannot serve the lookup, and
 * that false pass is the whole defect. Partial indexes are excluded
 * (`indpred IS NULL`) because a referential check must find EVERY referencing
 * row, so an index over a subset of them cannot be used. `indisvalid` is
 * required for the mirror-image reason: a `CREATE INDEX CONCURRENTLY` that was
 * cancelled or crashed leaves a fully-formed `pg_index` row behind that the
 * PLANNER IGNORES, so without this predicate the guard reports an index the
 * delete cannot actually use and stays green over sequential scans.
 *
 * `conkey[1]` is the constraint's first column, reported as `lead_col`. An index
 * serves the FK when its leading column is ANY of the constraint's columns: the
 * referential lookup is an equality on every FK column, so a composite FK such
 * as `pull_request_comment_acquisitions` (organization_id,
 * pull_request_detail_id) is served by a primary key leading with
 * pull_request_detail_id (ISS-11767).
 */
function foreignKeysWithServingIndex(
  ctx: EphemeralDbContext
): Promise<FkRow[]> {
  return ctx.prisma.$queryRawUnsafe<FkRow[]>(
    `WITH RECURSIVE deleted AS (
       SELECT $1::regclass AS reloid
       UNION
       SELECT c.conrelid
         FROM deleted d
         JOIN pg_constraint c
           ON c.confrelid = d.reloid
          AND c.contype = 'f'
          AND c.confdeltype = 'c'
     ),
     fks AS (
       SELECT
         c.conname::text AS conname,
         c.conrelid::regclass::text AS child_table,
         (SELECT a.attname::text
            FROM pg_attribute a
           WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) AS lead_col,
         c.conrelid AS child_oid,
         c.conkey AS fk_attnums
       FROM pg_constraint c
       WHERE c.contype = 'f'
         AND c.confrelid IN (SELECT reloid FROM deleted)
     )
     SELECT
       f.conname,
       f.child_table,
       f.lead_col,
       (SELECT i.indexrelid::regclass::text
          FROM pg_index i
         WHERE i.indrelid = f.child_oid
           AND i.indpred IS NULL
           AND i.indisvalid
           AND i.indkey[0] = ANY (f.fk_attnums)
         ORDER BY i.indexrelid::regclass::text
         LIMIT 1) AS serving_index
     FROM fks f
     ORDER BY f.child_table, f.lead_col`,
    CASCADE_ROOT
  );
}

/**
 * A child table of `artifacts` whose ONLY `artifact_id`-leading index is the
 * INVALID remnant of a failed concurrent unique build.
 *
 * The `CREATE UNIQUE INDEX CONCURRENTLY` is expected to throw: two rows share an
 * `artifact_id`, so the build's second pass hits the uniqueness violation and
 * Postgres leaves the half-built index in place, marked invalid. That throw is
 * the fixture, so it is swallowed here and the resulting catalog state is
 * asserted by the caller rather than inferred from it.
 */
async function createInvalidIndexProbe(ctx: EphemeralDbContext): Promise<void> {
  await ctx.prisma.$executeRawUnsafe(
    `CREATE TABLE "${PROBE_TABLE}" (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       artifact_id uuid NOT NULL
         REFERENCES "artifacts"(id) ON DELETE CASCADE
     )`
  );
  await ctx.prisma.$executeRawUnsafe(
    `INSERT INTO "${PROBE_TABLE}" (artifact_id)
     SELECT id FROM "artifacts" WHERE "project_id" = $1::uuid LIMIT 1`,
    PROJECT_ID
  );
  await ctx.prisma.$executeRawUnsafe(
    `INSERT INTO "${PROBE_TABLE}" (artifact_id)
     SELECT artifact_id FROM "${PROBE_TABLE}" LIMIT 1`
  );
  try {
    await ctx.prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX CONCURRENTLY "${PROBE_INDEX}"
         ON "${PROBE_TABLE}"("artifact_id")`
    );
  } catch {
    // Expected: the duplicate above is what leaves the INVALID remnant behind.
  }
}

/**
 * Removes the probe. Runs BEFORE the probe test as well as after it, so a run
 * killed mid-test cannot leave a permanently-unserved FK behind and redden the
 * whole-cascade invariant on every later run.
 */
function dropProbe(ctx: EphemeralDbContext): Promise<number> {
  return ctx.prisma.$executeRawUnsafe(
    `DROP TABLE IF EXISTS "${PROBE_TABLE}" CASCADE`
  );
}

async function explain(
  ctx: EphemeralDbContext,
  sql: string,
  ...params: unknown[]
): Promise<string> {
  const rows = await ctx.prisma.$queryRawUnsafe<Record<string, string>[]>(
    `EXPLAIN (COSTS OFF) ${sql}`,
    ...params
  );
  return rows.map((r) => Object.values(r)[0]).join("\n");
}

/**
 * Twenty projects sharing {@link SEEDED_ARTIFACTS} rows, the project under test
 * holding one twentieth of them.
 *
 * The closing `ANALYZE` is load-bearing: without fresh statistics the planner
 * costs the lookup against whatever `artifacts` last looked like and can pick a
 * sequential scan however good the index is, which would make the plan assertion
 * a statement about the fixture.
 */
async function seed(ctx: EphemeralDbContext): Promise<void> {
  // `createMany` rather than `create`: this row carries no nested relation write
  // and its result is discarded, so a `create` would ask Postgres for
  // `RETURNING *` for a value nobody reads (`no-discarded-wide-prisma-write`).
  await ctx.prisma.organization.createMany({
    data: [
      {
        id: ORG_ID,
        clerkId: `iss8496-${ORG_ID}`,
        name: `iss8496-${ORG_ID}`,
        slug: `iss8496-${ORG_ID}`,
      },
    ],
  });
  await ctx.prisma.$executeRawUnsafe(
    `INSERT INTO "projects" (id, organization_id, name, slug, created_by_id, updated_at)
     SELECT p, $2::uuid, 'iss8496 ' || p::text, 'iss8496-' || p::text, $3::uuid, now()
     FROM unnest($1::uuid[]) AS p`,
    [...ALL_PROJECT_IDS],
    ORG_ID,
    ctx.userId
  );
  await ctx.prisma.$executeRawUnsafe(
    `INSERT INTO "artifacts"
       (id, organization_id, project_id, type, name, slug, status, created_at, updated_at)
     SELECT gen_random_uuid(), $1::uuid,
            ($2::uuid[])[1 + (g % array_length($2::uuid[], 1))],
            'DOCUMENT'::"ArtifactType",
            'iss8496 ' || g::text, 'iss8496-' || g::text, 'TODO', now(), now()
     FROM generate_series(1, $3::int) AS g`,
    ORG_ID,
    [...ALL_PROJECT_IDS],
    SEEDED_ARTIFACTS
  );
  await ctx.prisma.$executeRawUnsafe("ANALYZE artifacts");
}
