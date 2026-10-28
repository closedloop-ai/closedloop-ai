/**
 * The orphan grace-window bookkeeping in `public.preview_schemas_observations`.
 * A private internal of `app/preview-schemas/service.ts`, split out per the
 * nested-service pattern in `apps/api/AGENTS.md`.
 */

import { Prisma, withDb } from "@repo/database";
import type { CategoryCounters } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";

/**
 * Reads the observation row for a given schema name from
 * `public.preview_schemas_observations`.
 *
 * Returns `{ firstObservedAt }` if a row exists, or `null` if not observed yet.
 * Follows the `readRegistryRow()` pattern in `schema-registry.ts`.
 */
export async function readObservation(
  schemaName: string
): Promise<{ firstObservedAt: Date } | null> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ first_observed_at: string }[]>(Prisma.sql`
      SELECT first_observed_at
      FROM public.preview_schemas_observations
      WHERE schema_name = ${schemaName}
      LIMIT 1
    `)
  );

  if (rows.length === 0) {
    return null;
  }

  return { firstObservedAt: new Date(rows[0].first_observed_at) };
}

/**
 * Reads every orphan's observation row in ONE query.
 *
 * Replaces a per-orphan `readObservation` round trip. The grace-window
 * bookkeeping deliberately runs even after the DROP budget is spent (so the
 * grace clock is never stranded), which made a per-orphan query an unbounded
 * amount of post-budget work on a large orphan backlog — able to carry the
 * function past `maxDuration` on its own (PR #4499 review). Two set-based
 * statements make the whole phase O(1) round trips.
 */
export async function readObservations(
  schemaNames: string[]
): Promise<Map<string, Date>> {
  if (schemaNames.length === 0) {
    return new Map();
  }

  const rows = await withDb((db) =>
    db.$queryRaw<{ schema_name: string; first_observed_at: string }[]>(
      Prisma.sql`
        SELECT schema_name, first_observed_at
        FROM public.preview_schemas_observations
        WHERE schema_name = ANY(${schemaNames})
      `
    )
  );

  return new Map(
    rows.map((r) => [r.schema_name, new Date(r.first_observed_at)])
  );
}

/**
 * Records first-observation for every orphan in ONE statement. INSERT … ON
 * CONFLICT DO NOTHING keeps `first_observed_at` captured exactly once per
 * schema, so re-running is an idempotent no-op.
 */
export async function upsertObservations(schemaNames: string[]): Promise<void> {
  if (schemaNames.length === 0) {
    return;
  }

  await withDb((db) =>
    db.$executeRaw(Prisma.sql`
      INSERT INTO public.preview_schemas_observations (schema_name)
      SELECT unnest(${schemaNames}::text[])
      ON CONFLICT (schema_name) DO NOTHING
    `)
  );
}

/**
 * Deletes observation rows for schemas that now have a real registry row in
 * `public.preview_schemas`. This keeps the observation table tidy — once a
 * schema gains a registry entry (because a preview deploy registered it),
 * it's no longer an orphan candidate and the observation is stale.
 *
 * Also deletes observations for schemas that no longer exist in pg_namespace
 * (already dropped by a previous sweep).
 */
async function cleanupStaleObservations(): Promise<void> {
  await withDb((db) =>
    db.$executeRaw(Prisma.sql`
      DO $$
      BEGIN
        IF to_regclass('public.preview_schemas') IS NOT NULL THEN
          DELETE FROM public.preview_schemas_observations AS observation
          WHERE EXISTS (
            SELECT 1
            FROM public.preview_schemas AS registry
            WHERE registry.schema_name = observation.schema_name
          );
        END IF;

        DELETE FROM public.preview_schemas_observations AS observation
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_namespace AS pg_ns
          WHERE pg_ns.nspname = observation.schema_name
            AND pg_ns.nspname LIKE 'preview_%'
        );
      END $$;
    `)
  );
}

export async function cleanupStaleObservationsSafely(
  counters: CategoryCounters
): Promise<void> {
  try {
    await cleanupStaleObservations();
  } catch (err) {
    log.error("[preview-schema-cleanup] cleanupStaleObservations failed", {
      error: parseError(err),
    });
    counters.registryReadErrored += 1;
  }
}
