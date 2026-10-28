import { describe, expect, it } from "vitest";
import { uuidV7 } from "../../scripts/search-backfill-values";
import {
  insertProject,
  PROJECTION_REFRESH_FUNCTION_SQL,
  type ProjectionSnapshot,
  projectionSnapshot,
  type ScratchClient,
  WALK_ONLY_PROJECTION_MIGRATION_SQL,
  withScratchDatabase,
} from "../support/prd726-hierarchy-scratch-database";

const databaseUrl = process.env.DATABASE_URL;

const ARTIFACTS_PER_GRAPH = 80;
const EDGE_ATTEMPTS_PER_GRAPH = 240;
const ACYCLIC_SEEDS = [0.11, 0.23, 0.37, 0.41, 0.59, 0.67];
const CYCLIC_SEEDS = [0.13, 0.71];

/**
 * Seeds one project with a deterministic pseudo-random multi-parent graph:
 * shared children, explicit canonical and suppressed edges, a non-boolean
 * canonical flag that must not count, and creation-time ties. `acyclic` keeps
 * every edge pointing from a lower to a higher artifact index; otherwise
 * back-edges and a forced canonical cycle create the legacy cycles only
 * pre-admission data can hold. Seeded before the migrations, as that data was.
 */
async function seedGraph(
  scratch: ScratchClient,
  organizationId: string,
  seed: number,
  acyclic: boolean
): Promise<string> {
  const projectId = await insertProject(scratch, organizationId);
  const ids = Array.from({ length: ARTIFACTS_PER_GRAPH }, () => uuidV7());
  await scratch.query("SELECT setseed($1)", [seed]);
  await scratch.query(
    `INSERT INTO artifacts
        (id, organization_id, project_id, type, sort_order, created_at)
       SELECT id, $2, $3, 'DOCUMENT',
              CASE WHEN random() < 0.2 THEN NULL
                ELSE floor(random() * 30)::int END,
              timestamptz '2026-01-01' + floor(random() * 40) * interval '1 second'
       FROM unnest($1::uuid[]) AS input(id)`,
    [ids, organizationId, projectId]
  );
  await scratch.query(
    `INSERT INTO artifact_links
        (id, organization_id, source_id, target_id, link_type, sort_order,
         metadata, created_at)
       SELECT gen_random_uuid(), $2, ($1::uuid[])[s], ($1::uuid[])[t],
              'PRODUCES',
              CASE WHEN roll < 0.2 THEN NULL ELSE floor(roll * 100)::int END,
              CASE
                WHEN roll < 0.15 THEN '{"hierarchy":{"canonical":true}}'::jsonb
                WHEN roll < 0.25 THEN '{"hierarchy":{"suppressed":true}}'::jsonb
                WHEN roll < 0.30 THEN '{"hierarchy":{"canonical":"true"}}'::jsonb
              END,
              timestamptz '2026-01-01' + floor(roll * 40) * interval '1 second'
       FROM (
         SELECT DISTINCT ON (s, t) s, t, random() AS roll
         FROM (
           SELECT floor(random() * $3 + 1)::int AS s,
                  floor(random() * $3 + 1)::int AS t
           FROM generate_series(1, $4)
         ) pairs
         WHERE CASE WHEN $5 THEN s < t ELSE s <> t END
       ) edges`,
    [ids, organizationId, ARTIFACTS_PER_GRAPH, EDGE_ATTEMPTS_PER_GRAPH, acyclic]
  );
  if (!acyclic) {
    // Earliest canonical edges make these three each child's first candidate,
    // so the first candidates close a cycle and the walk must refuse one.
    await scratch.query(
      `INSERT INTO artifact_links
          (id, organization_id, source_id, target_id, link_type, metadata,
           created_at)
         SELECT gen_random_uuid(), $2, ($1::uuid[])[s], ($1::uuid[])[t],
                'PRODUCES', '{"hierarchy":{"canonical":true}}'::jsonb,
                timestamptz '2025-12-31'
         FROM (VALUES (1, 2), (2, 3), (3, 1)) AS cycle(s, t)`,
      [ids, organizationId]
    );
  }
  return projectId;
}

async function sharedChildCount(
  scratch: ScratchClient,
  projectId: string
): Promise<number> {
  const row = await scratch.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM (
       SELECT link.target_id
       FROM artifact_links link
       JOIN artifacts target ON target.id = link.target_id
       WHERE target.project_id = $1 AND link.link_type = 'PRODUCES'
       GROUP BY link.target_id
       HAVING count(*) > 1
     ) shared`,
    [projectId]
  );
  return Number(row.rows[0].count);
}

/** Children whose stored parent is not their first candidate edge. */
async function refusedFirstCandidates(
  scratch: ScratchClient,
  projectId: string
): Promise<number> {
  const row = await scratch.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM (
         SELECT DISTINCT ON (link.target_id)
           link.target_id, link.source_id
         FROM artifact_links link
         JOIN artifacts source ON source.id = link.source_id
         JOIN artifacts target ON target.id = link.target_id
         WHERE source.project_id = $1 AND target.project_id = $1
           AND link.link_type = 'PRODUCES'
           AND link.metadata IS DISTINCT FROM
             '{"hierarchy":{"suppressed":true}}'::jsonb
         ORDER BY link.target_id,
           link.metadata IS NOT DISTINCT FROM
             '{"hierarchy":{"canonical":true}}'::jsonb DESC,
           link.created_at, link.id
       ) first_candidate
       JOIN artifacts child ON child.id = first_candidate.target_id
      WHERE child.canonical_parent_id IS DISTINCT FROM first_candidate.source_id`,
    [projectId]
  );
  return Number(row.rows[0].count);
}

async function refreshAll(
  scratch: ScratchClient,
  projectIds: readonly string[]
): Promise<void> {
  for (const projectId of projectIds) {
    await scratch.query("SELECT refresh_project_hierarchy_projection($1)", [
      projectId,
    ]);
  }
}

describe.skipIf(!databaseUrl)("PRD-726 linear hierarchy projection", () => {
  it("matches the ordered walk on multi-parent and legacy-cycle graphs", async () => {
    await withScratchDatabase(databaseUrl ?? "", async (scratch) => {
      const organizationId = uuidV7();
      const acyclicProjects: string[] = [];
      for (const seed of ACYCLIC_SEEDS) {
        acyclicProjects.push(
          await seedGraph(scratch, organizationId, seed, true)
        );
      }
      const cyclicProjects: string[] = [];
      for (const seed of CYCLIC_SEEDS) {
        cyclicProjects.push(
          await seedGraph(scratch, organizationId, seed, false)
        );
      }
      const projects = [...acyclicProjects, ...cyclicProjects];
      await scratch.query(WALK_ONLY_PROJECTION_MIGRATION_SQL);
      const walked = new Map<string, ProjectionSnapshot>();
      for (const projectId of projects) {
        expect(await sharedChildCount(scratch, projectId)).toBeGreaterThan(0);
        walked.set(projectId, await projectionSnapshot(scratch, projectId));
      }

      await scratch.query(PROJECTION_REFRESH_FUNCTION_SQL);
      await scratch.query(
        `UPDATE artifacts
            SET canonical_parent_id = NULL, hierarchy_rank = -1,
                canonical_child_count = -1
          WHERE project_id = ANY($1::uuid[])`,
        [projects]
      );
      await refreshAll(scratch, projects);

      for (const projectId of projects) {
        expect(await projectionSnapshot(scratch, projectId)).toEqual(
          walked.get(projectId)
        );
      }
      // The cyclic graphs must exercise the fallback: in each, the walk refused
      // some child's first candidate, so the linear pick alone would differ.
      for (const projectId of cyclicProjects) {
        expect(
          await refusedFirstCandidates(scratch, projectId)
        ).toBeGreaterThan(0);
      }
    });
  }, 300_000);
});
