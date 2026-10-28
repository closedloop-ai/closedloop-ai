import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSslClient, quoteIdentifier } from "../../scripts/db-utils";
import { uuidV7 } from "../../scripts/search-backfill-values";

export type ScratchClient = ReturnType<typeof createSslClient>;

function migrationSql(directory: string): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "prisma",
      "migrations",
      directory,
      "migration.sql"
    ),
    "utf8"
  );
}

/** The projection migration: columns, triggers, refresh and backfill. */
export const PROJECTION_MIGRATION_SQL = migrationSql(
  "20261022022500_prd726_project_hierarchy_projection"
);

const ACYCLIC_BRANCH = "  IF NOT is_acyclic THEN";
const REFRESH_FUNCTION =
  /CREATE FUNCTION refresh_project_hierarchy_projection\(.*?\n\$\$;\n/s;

/**
 * The same migration with its linear path switched off, so every project goes
 * through the ordered walk: the reference the linear projection must equal.
 */
export const WALK_ONLY_PROJECTION_MIGRATION_SQL = forceOrderedWalk(
  PROJECTION_MIGRATION_SQL
);

/** Only the migration's refresh function, to swap it in over the walk-only one. */
export const PROJECTION_REFRESH_FUNCTION_SQL = refreshFunction(
  PROJECTION_MIGRATION_SQL
);

function forceOrderedWalk(sql: string): string {
  if (sql.split(ACYCLIC_BRANCH).length !== 2) {
    throw new Error("The projection migration no longer has one linear branch");
  }
  return sql.replace(ACYCLIC_BRANCH, "  IF true THEN");
}

function refreshFunction(sql: string): string {
  const match = REFRESH_FUNCTION.exec(sql);
  if (!match) {
    throw new Error("The projection migration has no refresh function");
  }
  return match[0].replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
}

const MINIMAL_SCHEMA = `
  CREATE TYPE "LinkType" AS ENUM ('PRODUCES', 'RELATES_TO');
  CREATE TYPE "ArtifactType" AS ENUM ('DOCUMENT');
  CREATE TABLE projects (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL
  );
  CREATE TABLE artifacts (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid REFERENCES projects(id),
    type "ArtifactType" NOT NULL,
    subtype text,
    name text,
    sort_order integer,
    created_at timestamptz NOT NULL
  );
  CREATE TABLE artifact_links (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    source_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    target_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    link_type "LinkType" NOT NULL,
    sort_order integer,
    metadata jsonb,
    created_at timestamptz NOT NULL
  );
`;

/**
 * Runs `body` against a throwaway database holding only the tables and columns
 * the PRD-726 projection migrations read, so each case applies them itself.
 */
export async function withScratchDatabase(
  databaseUrl: string,
  body: (scratch: ScratchClient) => Promise<void>
): Promise<void> {
  const database = `prd726_hierarchy_${uuidV7().replaceAll("-", "")}`;
  const scratchUrl = new URL(databaseUrl);
  scratchUrl.pathname = `/${database}`;
  const administrator = createSslClient(databaseUrl);
  await administrator.connect();
  try {
    await administrator.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    const scratch = createSslClient(scratchUrl.toString());
    await scratch.connect();
    try {
      await scratch.query(MINIMAL_SCHEMA);
      await body(scratch);
    } finally {
      await scratch.end();
    }
  } finally {
    await administrator.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`
    );
    await administrator.end();
  }
}

export async function insertProject(
  scratch: ScratchClient,
  organizationId: string
): Promise<string> {
  const projectId = uuidV7();
  await scratch.query(
    "INSERT INTO projects (id, organization_id) VALUES ($1, $2)",
    [projectId, organizationId]
  );
  return projectId;
}

export async function projectedParents(
  scratch: ScratchClient,
  projectId: string
): Promise<Record<string, string | null>> {
  const projected = await scratch.query<{
    canonical_parent_id: string | null;
    id: string;
  }>("SELECT id, canonical_parent_id FROM artifacts WHERE project_id = $1", [
    projectId,
  ]);
  return Object.fromEntries(
    projected.rows.map((row) => [row.id, row.canonical_parent_id])
  );
}

export type ProjectionSnapshot = {
  artifacts: Array<{
    canonical_child_count: string;
    canonical_parent_id: string | null;
    hierarchy_rank: number | null;
    id: string;
  }>;
  versions: { hierarchy_mutation_version: string; hierarchy_version: string };
};

/** Every stored projection value for one project, in a stable order. */
export async function projectionSnapshot(
  scratch: ScratchClient,
  projectId: string
): Promise<ProjectionSnapshot> {
  const artifacts = await scratch.query<ProjectionSnapshot["artifacts"][0]>(
    `SELECT id, canonical_parent_id, hierarchy_rank,
            canonical_child_count::text AS canonical_child_count
       FROM artifacts WHERE project_id = $1 ORDER BY id`,
    [projectId]
  );
  const versions = await scratch.query<ProjectionSnapshot["versions"]>(
    `SELECT hierarchy_version, hierarchy_mutation_version
       FROM projects WHERE id = $1`,
    [projectId]
  );
  return { artifacts: artifacts.rows, versions: versions.rows[0] };
}
