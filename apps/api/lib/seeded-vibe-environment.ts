import "server-only";

import {
  parseVibeEnvironmentMarker,
  VibeEnvironmentMode,
} from "@repo/database/scripts/vibe-environment";
import {
  readRuntimeSchemaComment,
  runtimePreviewSchema,
} from "./s3-keyspace-prefix";

/**
 * ISS-12135: whether this API runtime serves a vibe preview the vibe workflow
 * SEEDED, read from the marker that workflow writes on the preview schema
 * (ISS-12056). Only a preview runtime ever asks the database; stage,
 * production and every non-preview runtime answer `false` without a read, and
 * so does a blank vibe preview or a preview with no marker.
 *
 * A failed read rejects rather than answering `false`, so a caller cannot
 * mistake "could not tell" for "not seeded".
 */
export async function isSeededVibeEnvironmentRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readSchemaComment: (
    schema: string
  ) => Promise<string | null> = readRuntimeSchemaComment
): Promise<boolean> {
  const schema = runtimePreviewSchema(env);
  if (schema === null) {
    return false;
  }
  const marker = parseVibeEnvironmentMarker(await readSchemaComment(schema));
  return marker?.mode === VibeEnvironmentMode.Seeded;
}
