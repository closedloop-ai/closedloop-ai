import type { SchemaCategory } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import {
  isPrototypeEnvironmentBranch,
  isRetainedEnvironmentSchema,
  isVibeEnvironmentBranch,
} from "@repo/database/scripts/vibe-environment-retention";

/**
 * Daveth Oakhurst, 2026-10-07, ISS-12135 (vibe meeting requirement A5): a vibe
 * environment is never torn down automatically. The daily sweep neither drops
 * its schema for inactivity nor in either orphan pass; only an explicit
 * branch cleanup (`dropSchemaForBranch`) removes it. Perrin Upcott,
 * 2026-10-09, ISS-12214: the same holds for `prototype/` and
 * `functional-prototype/` environments.
 */
export function isRetainedEnvironmentBranch(branch: string | null): boolean {
  return (
    isVibeEnvironmentBranch(branch) || isPrototypeEnvironmentBranch(branch)
  );
}

/** TTL and orphan classification share the same manual-retention policy. */
export function keepRetainedEnvironmentOutOfSweep(
  category: SchemaCategory,
  schemaName: string,
  branch: string | null
): SchemaCategory {
  return isRetainedEnvironmentSchema(schemaName, branch) ? "active" : category;
}
