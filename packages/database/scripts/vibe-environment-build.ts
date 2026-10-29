import type { MigrationPipelineDeps } from "./migration-pipeline";
import { isPreviewSchema } from "./preview-schema";
import {
  initialVibeEnvironmentMarker,
  type VibeEnvironmentMarker,
  type VibeEnvironmentMode,
  vibeEnvironmentNeedsRebuild,
} from "./vibe-environment";

export type VibeEnvironmentBuildDeps = Pick<
  MigrationPipelineDeps,
  | "dropSchema"
  | "ensureSchemaExists"
  | "readVibeEnvironmentMarker"
  | "writeVibeEnvironmentMarker"
>;

export type SchemaForBuild = {
  /** The schema was created by this run, so it is empty. */
  isNew: boolean;
  /** The schema's vibe environment marker after this step; `null` for any other schema. */
  vibeEnvironment: VibeEnvironmentMarker | null;
  /** A vibe environment dispatch dropped the schema it found and built it anew. */
  rebuilt: boolean;
};

/**
 * ISS-12056: the pipeline's ensure step, run under the preview build lock so it
 * cannot interleave with a normal deploy of the same branch.
 *
 * Without `requested` it is the ensure every deploy has always run, plus a read
 * of the marker so a vibe environment is never cloned from `public`.
 *
 * With `requested` (only the vibe environment workflow sends it) the schema is
 * dropped first unless it is already a ready vibe environment of that mode, so a
 * schema a normal deploy cloned from `public`, or one left with a partial seed,
 * never survives into the session. The marker is written right after the
 * schema is created, before any migration runs.
 */
export async function ensureSchemaForBuild(
  deps: VibeEnvironmentBuildDeps,
  databaseUrl: string,
  schema: string | null,
  requested: VibeEnvironmentMode | undefined
): Promise<SchemaForBuild> {
  if (requested === undefined) {
    const isNew = await deps.ensureSchemaExists(databaseUrl, schema);
    const vibeEnvironment = isPreviewSchema(schema)
      ? await deps.readVibeEnvironmentMarker(databaseUrl, schema)
      : null;
    return { isNew, vibeEnvironment, rebuilt: false };
  }
  if (!(schema && isPreviewSchema(schema))) {
    throw new Error(
      `Refusing to build a vibe environment in ${schema ?? "public"}: only branch preview schemas can be one (ISS-12056)`
    );
  }
  const current = await deps.readVibeEnvironmentMarker(databaseUrl, schema);
  const rebuilt = vibeEnvironmentNeedsRebuild(current, requested);
  if (rebuilt) {
    console.log(
      `↪ Rebuilding ${schema} empty as a ${requested} vibe environment (ISS-12056)`
    );
    await deps.dropSchema(databaseUrl, schema);
  }
  const isNew = await deps.ensureSchemaExists(databaseUrl, schema);
  if (!rebuilt) {
    return { isNew, vibeEnvironment: current, rebuilt };
  }
  const marker = initialVibeEnvironmentMarker(requested);
  await deps.writeVibeEnvironmentMarker(databaseUrl, schema, marker);
  return { isNew, vibeEnvironment: marker, rebuilt };
}
