import { describe, expect, it } from "vitest";
import { uuidV7 } from "../../scripts/search-backfill-values";
import {
  insertProject,
  PROJECTION_MIGRATION_SQL,
  projectedParents,
  type ScratchClient,
  withScratchDatabase,
} from "../support/prd726-hierarchy-scratch-database";

const databaseUrl = process.env.DATABASE_URL;

async function projectedChildCount(
  scratch: ScratchClient,
  artifactId: string
): Promise<string> {
  const row = await scratch.query<{ count: string }>(
    "SELECT canonical_child_count::text AS count FROM artifacts WHERE id = $1",
    [artifactId]
  );
  return row.rows[0].count;
}

async function hierarchyVersion(
  scratch: ScratchClient,
  projectId: string
): Promise<string> {
  const row = await scratch.query<{ hierarchy_version: string }>(
    "SELECT hierarchy_version FROM projects WHERE id = $1",
    [projectId]
  );
  return row.rows[0].hierarchy_version;
}

describe.skipIf(!databaseUrl)("PRD-726 hierarchy projection migration", () => {
  it("backfills canonical parents without deleting a pre-migration cycle", async () => {
    await withScratchDatabase(databaseUrl ?? "", async (scratch) => {
      const organizationId = uuidV7();
      const projectId = await insertProject(scratch, organizationId);
      const [aId, bId, cId] = [uuidV7(), uuidV7(), uuidV7()];
      for (const [index, id] of [aId, bId, cId].entries()) {
        await scratch.query(
          `INSERT INTO artifacts
              (id, organization_id, project_id, type, created_at)
             VALUES ($1, $2, $3, 'DOCUMENT', $4)`,
          [id, organizationId, projectId, new Date(1000 * index)]
        );
      }
      for (const [index, [sourceId, targetId]] of [
        [aId, bId],
        [bId, cId],
        [cId, aId],
      ].entries()) {
        await scratch.query(
          `INSERT INTO artifact_links
              (id, organization_id, source_id, target_id, link_type, created_at)
             VALUES ($1, $2, $3, $4, 'PRODUCES', $5)`,
          [uuidV7(), organizationId, sourceId, targetId, new Date(1000 * index)]
        );
      }

      const expectedParents = { [aId]: null, [bId]: aId, [cId]: bId };
      await scratch.query(PROJECTION_MIGRATION_SQL);
      expect(await projectedParents(scratch, projectId)).toEqual(
        expectedParents
      );
      const legacyEdges = await scratch.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM artifact_links
           WHERE organization_id = $1 AND link_type = 'PRODUCES'`,
        [organizationId]
      );
      expect(legacyEdges.rows[0].count).toBe("3");
      const unresolved = await scratch.query<{
        source_id: string;
        target_id: string;
      }>(
        `SELECT link.source_id, link.target_id
           FROM artifact_links link
           JOIN artifacts target ON target.id = link.target_id
           WHERE link.organization_id = $1
             AND link.link_type = 'PRODUCES'
             AND target.canonical_parent_id IS DISTINCT FROM link.source_id`,
        [organizationId]
      );
      expect(unresolved.rows).toEqual([{ source_id: cId, target_id: aId }]);
      await expect(
        scratch.query(
          `INSERT INTO artifact_links
              (id, organization_id, source_id, target_id, link_type, created_at)
             VALUES ($1, $2, $3, $3, 'PRODUCES', now())`,
          [uuidV7(), organizationId, aId]
        )
      ).rejects.toMatchObject({
        constraint: "artifact_links_produces_acyclic",
      });
    });
  }, 120_000);

  it("keeps the projection current through bulk statements", async () => {
    await withScratchDatabase(databaseUrl ?? "", async (scratch) => {
      await scratch.query(PROJECTION_MIGRATION_SQL);
      const organizationId = uuidV7();
      const projectId = await insertProject(scratch, organizationId);
      const otherProjectId = await insertProject(scratch, organizationId);
      const ids = Array.from({ length: 40 }, () => uuidV7());
      await scratch.query(
        `INSERT INTO artifacts
            (id, organization_id, project_id, type, sort_order, created_at)
           SELECT id, $2, $3, 'DOCUMENT', ordinality::int, now()
           FROM unnest($1::uuid[]) WITH ORDINALITY AS input(id, ordinality)`,
        [ids, organizationId, projectId]
      );
      await scratch.query(
        `INSERT INTO artifact_links
            (id, organization_id, source_id, target_id, link_type, created_at)
           SELECT gen_random_uuid(), $2, $3, target_id, 'PRODUCES', now()
           FROM unnest($1::uuid[]) AS input(target_id)`,
        [ids.slice(1), organizationId, ids[0]]
      );

      const parents = await projectedParents(scratch, projectId);
      expect(parents[ids[0]]).toBeNull();
      expect(ids.slice(1).map((id) => parents[id])).toEqual(
        ids.slice(1).map(() => ids[0])
      );
      expect(await projectedChildCount(scratch, ids[0])).toBe("39");

      const versionBeforeRename = await hierarchyVersion(scratch, projectId);
      await scratch.query(
        "UPDATE artifacts SET name = 'renamed' WHERE project_id = $1",
        [projectId]
      );
      expect(await hierarchyVersion(scratch, projectId)).toBe(
        versionBeforeRename
      );

      await scratch.query(
        "UPDATE artifacts SET project_id = $1 WHERE id = ANY($2::uuid[])",
        [otherProjectId, ids.slice(30)]
      );
      expect(await projectedChildCount(scratch, ids[0])).toBe("29");
      const moved = await projectedParents(scratch, otherProjectId);
      expect(ids.slice(30).map((id) => moved[id])).toEqual(
        ids.slice(30).map(() => null)
      );

      await scratch.query("DELETE FROM artifacts WHERE id = $1", [ids[0]]);
      const promoted = await projectedParents(scratch, projectId);
      expect(ids.slice(1, 30).map((id) => promoted[id])).toEqual(
        ids.slice(1, 30).map(() => null)
      );
    });
  }, 120_000);

  it("refreshes per statement and pins custom plans", async () => {
    await withScratchDatabase(databaseUrl ?? "", async (scratch) => {
      await scratch.query(PROJECTION_MIGRATION_SQL);
      const triggers = await scratch.query<{
        row_level: boolean;
        tgname: string;
      }>(
        `SELECT tgname, (tgtype & 1) = 1 AS row_level FROM pg_trigger
           WHERE NOT tgisinternal
             AND tgrelid IN ('artifacts'::regclass, 'artifact_links'::regclass)
           ORDER BY tgname`
      );
      expect(triggers.rows).toEqual([
        {
          row_level: false,
          tgname: "artifact_links_refresh_project_hierarchy_delete",
        },
        {
          row_level: false,
          tgname: "artifact_links_refresh_project_hierarchy_insert",
        },
        {
          row_level: false,
          tgname: "artifact_links_refresh_project_hierarchy_update",
        },
        { row_level: true, tgname: "artifact_links_reject_produces_cycle" },
        {
          row_level: false,
          tgname: "artifacts_refresh_project_hierarchy_delete",
        },
        {
          row_level: false,
          tgname: "artifacts_refresh_project_hierarchy_insert",
        },
        {
          row_level: false,
          tgname: "artifacts_refresh_project_hierarchy_update",
        },
      ]);
      const functions = await scratch.query<{
        proconfig: string[] | null;
        proname: string;
      }>(
        `SELECT proname, proconfig FROM pg_proc
           WHERE proname = 'refresh_project_hierarchy_projection'`
      );
      expect(functions.rows).toEqual([
        {
          proconfig: ["plan_cache_mode=force_custom_plan"],
          proname: "refresh_project_hierarchy_projection",
        },
      ]);
    });
  }, 120_000);
});
