/**
 * Prompts registry service — upserts prompt snapshots into the database.
 *
 * NOTE: Relies on search_path being set by the connection pool (configured in
 * packages/database/index.ts). The raw SQL references prompt_registry and the
 * "PromptType" enum without schema qualification.
 */

import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import { Prisma, withDb } from "@repo/database";

/**
 * Upsert all prompts from a snapshot into the prompt_registry table.
 *
 * Each prompt is inserted atomically using INSERT ... SELECT with an inline
 * COALESCE version subquery. ON CONFLICT (organization_id, sha) DO NOTHING
 * ensures idempotency — re-ingesting the same content is a no-op.
 *
 * The sha column is computed by the database from the content column, so it
 * is intentionally excluded from the INSERT column list.
 */
export async function upsertFromSnapshot(
  organizationId: string,
  snapshot: PromptsSnapshot | null
): Promise<void> {
  if (!snapshot || snapshot.prompts.length === 0) {
    return;
  }

  await withDb.tx(async (tx) => {
    for (const prompt of snapshot.prompts) {
      const { promptType, name, description, model, tools, filePath, content } =
        prompt;

      const prismaPromptType: string = promptType;

      await tx.$queryRaw(Prisma.sql`
        INSERT INTO prompt_registry (id, organization_id, prompt_type, name, description, model, tools, file_path, content, version)
        SELECT
          uuid_generate_v7(),
          ${organizationId},
          ${prismaPromptType}::"PromptType",
          ${name},
          ${description},
          ${model},
          ${tools}::text[],
          ${filePath},
          ${content},
          COALESCE((SELECT MAX(version) FROM prompt_registry WHERE organization_id = ${organizationId} AND name = ${name} AND prompt_type = ${prismaPromptType}::"PromptType"), 0) + 1
        ON CONFLICT (organization_id, sha) DO NOTHING
      `);
    }
  });
}
