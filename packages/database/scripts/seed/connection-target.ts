import {
  formatSearchPath,
  normalizeExplicitSchemaName,
  resolveSchemaName,
} from "../../schema-utils";

/**
 * Resolves which schema a seed run will write into, and how that name is
 * quoted for the connection's `search_path`.
 *
 * Extracted from `createSeedPrisma` in `scripts/seed.ts` so it can be
 * unit-tested without constructing a pg Pool or a PrismaClient — the same
 * reason `non-empty-org-guard.ts` was extracted from the same file. `seed.ts`
 * remains the CLI entry point and still owns pool/client construction.
 *
 * The resolution order is deliberate and load-bearing:
 *
 *  1. An explicit `?schema=` on the DSN, normalized the same way `PGSCHEMA` is
 *     (via `normalizeExplicitSchemaName`) so a mixed-case or special-character
 *     value cannot produce a quoted `search_path` identifier that mismatches
 *     the lowercased schema and trips the schema guard as a false positive.
 *  2. Otherwise the environment (`PGSCHEMA`, or a Vercel preview branch).
 *
 * Step 1 falls through on an EMPTY result — note `||`, not `??`. A DSN carrying
 * a blank or all-separator `?schema=` normalizes to `""`, and treating that as
 * a resolved value would leave `targetSchema` empty, disabling both the
 * `search_path` and the schema guard, and routing every seed write into
 * `public`.
 */
export type SeedConnectionTarget = {
  /** The DSN's `sslmode`, read before it is stripped. `null` when absent. */
  sslmode: string | null;
  /** The schema the run must write into, or `null` for the default. */
  targetSchema: string | null;
  /** `targetSchema` quoted for `-c search_path=`, or `null` when unset. */
  searchPath: string | null;
};

type SeedSchemaEnv = {
  pgSchema?: string | null | undefined;
  vercelEnv?: string | null | undefined;
  vercelGitCommitRef?: string | null | undefined;
};

/**
 * Reads and then STRIPS `sslmode` and `schema` from `url`, mutating it in
 * place. Both are re-applied by the caller through explicit pool config rather
 * than left on the connection string, where they would conflict with the
 * driver adapter.
 */
export function resolveSeedConnectionTarget(
  url: URL,
  env: SeedSchemaEnv
): SeedConnectionTarget {
  const sslmode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");

  const rawUrlSchema = url.searchParams.get("schema");
  const targetSchema =
    (rawUrlSchema ? normalizeExplicitSchemaName(rawUrlSchema) : "") ||
    resolveSchemaName({
      pgSchema: env.pgSchema,
      vercelEnv: env.vercelEnv,
      vercelGitCommitRef: env.vercelGitCommitRef,
    });
  url.searchParams.delete("schema");

  const searchPath =
    targetSchema && targetSchema.length > 0
      ? formatSearchPath(targetSchema)
      : null;

  return { sslmode, targetSchema, searchPath };
}
