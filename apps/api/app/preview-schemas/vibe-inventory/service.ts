import { Prisma, withDb } from "@repo/database";
import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { deriveBranchSchemaName } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { PrototypeBranchPrefix } from "@repo/database/scripts/vibe-environment-retention";
import { VIBE_BRANCH_PREFIX } from "../constants";

export type VibeSchemaPresence = {
  branch: string;
  schemaName: string;
  exists: boolean;
};

export type VibeEnvironmentRow = {
  branch: string;
  schemaName: string;
  /** When the registry first saw the schema, ISO 8601. */
  createdAt: string;
  schemaExists: boolean;
  /** Tables, indexes and TOAST of the schema; `null` once it is dropped. */
  sizeBytes: number | null;
};

type RegistryRow = {
  branch: string;
  schema_name: string;
  created_at: Date | string;
  schema_exists: boolean;
  size_bytes: bigint | number;
};

/**
 * ISS-12216 (PRD-783 FR9): read-only answers for `prototype-pin-alias.yml`,
 * which releases a vibe environment's pins once its schema is gone and lists
 * the live ones weekly.
 */
export const vibeInventoryService = {
  /** Whether the schema `normalizePreviewSchemaName(branch)` names exists now. */
  async readSchemaPresence(branch: string): Promise<VibeSchemaPresence> {
    const schemaName = deriveBranchSchemaName(
      branch,
      normalizePreviewSchemaName
    );
    const rows = await withDb((db) =>
      db.$queryRaw<{ nspname: string }[]>(Prisma.sql`
        SELECT nspname FROM pg_namespace WHERE nspname = ${schemaName}
      `)
    );
    return { branch, schemaName, exists: rows.length > 0 };
  },

  /**
   * Every registry row on a `vibe/`, `prototype/` or `functional-prototype/`
   * branch (ISS-12414), live or dropped: the registry
   * keeps a row after its schema is dropped, which is what lets the inventory
   * find a discarded environment whose pins were left behind.
   */
  async listEnvironments(): Promise<VibeEnvironmentRow[]> {
    const rows = await withDb((db) =>
      db.$queryRaw<RegistryRow[]>(Prisma.sql`
        SELECT r.branch, r.schema_name, r.created_at,
          n.oid IS NOT NULL AS schema_exists,
          COALESCE((
            SELECT SUM(pg_total_relation_size(c.oid))
            FROM pg_class c
            WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'm')
          ), 0)::bigint AS size_bytes
        FROM public.preview_schemas r
        LEFT JOIN pg_namespace n ON n.nspname = r.schema_name
        WHERE r.branch LIKE ANY(${inventoryBranchPatterns}::text[])
        ORDER BY r.created_at, r.schema_name
      `)
    );
    return rows.map((row) => ({
      branch: row.branch,
      schemaName: row.schema_name,
      createdAt: new Date(row.created_at).toISOString(),
      schemaExists: row.schema_exists,
      sizeBytes: row.schema_exists ? Number(row.size_bytes) : null,
    }));
  },
};

/** The branch prefixes whose schemas no automatic path drops (ISS-12214). */
const inventoryBranchPatterns = [
  VIBE_BRANCH_PREFIX,
  ...Object.values(PrototypeBranchPrefix),
].map((prefix) => `${prefix}%`);
