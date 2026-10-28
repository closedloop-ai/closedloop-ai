import { z } from "zod";
import { createSslClient } from "./db-utils";
import { readSchemaComment, writeSchemaComment } from "./vibe-environment";

export const PreviewBuildState = {
  Incomplete: "incomplete",
} as const;

const previewBuildCommentSchema = z
  .object({
    closedloopPreviewBuild: z.unknown().optional(),
  })
  .passthrough();
const incompletePreviewBuildSchema = z.object({
  closedloopPreviewBuild: z.object({
    state: z.literal(PreviewBuildState.Incomplete),
  }),
});

/** Separate from the explicit seeded/blank marker; this marks an unfinished public clone. */
export function formatIncompletePreviewBuild(): string {
  return JSON.stringify({
    closedloopPreviewBuild: { state: PreviewBuildState.Incomplete },
  });
}

/** Legacy comments omit this additive key. Unknown values of our key remain incomplete. */
export function hasIncompletePreviewBuild(comment: string | null): boolean {
  if (!comment) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(comment);
  } catch {
    return false;
  }
  const result = previewBuildCommentSchema.safeParse(parsed);
  return result.success && Object.hasOwn(result.data, "closedloopPreviewBuild");
}

/** Reads durable build state using the migration connection, never the app pool. */
export async function readIncompletePreviewBuild(
  databaseUrl: string,
  schema: string
): Promise<boolean> {
  const client = createSslClient(databaseUrl);
  await client.connect();
  try {
    return hasIncompletePreviewBuild(await readSchemaComment(client, schema));
  } finally {
    await client.end();
  }
}

/** Clear only our successfully completed marker, preserving unrelated comment fields. */
export async function clearIncompletePreviewBuild(
  databaseUrl: string,
  schema: string
): Promise<void> {
  const client = createSslClient(databaseUrl);
  await client.connect();
  try {
    const comment = await readSchemaComment(client, schema);
    if (!(comment && hasIncompletePreviewBuild(comment))) {
      return;
    }
    const parsed: unknown = JSON.parse(comment);
    if (!incompletePreviewBuildSchema.safeParse(parsed).success) {
      return;
    }
    const result = previewBuildCommentSchema.parse(parsed);
    const { closedloopPreviewBuild: _completed, ...remaining } = result;
    await writeSchemaComment(
      client,
      schema,
      Object.keys(remaining).length === 0 ? null : JSON.stringify(remaining)
    );
  } finally {
    await client.end();
  }
}
