/**
 * Prompts registry service — upserts prompt snapshots into the database.
 *
 * NOTE: Relies on search_path being set by the connection pool (configured in
 * packages/database/index.ts). The raw SQL references prompt_registry and the
 * "PromptType" enum without schema qualification.
 */

import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import { Prisma, withDb } from "@repo/database";
import { computePromptSha256 } from "@/lib/prompt-snapshot-ingestion";

/**
 * Upsert all prompts from a snapshot into the prompt_registry table.
 *
 * This flow intentionally keeps SHA generation in app code while making the
 * insert atomic in SQL to avoid TOCTOU races:
 * 1) Compute SHA in app code.
 * 2) In one statement, compute next version for (organization_id, name).
 * 3) Insert and ignore unique conflicts (same sha or raced version).
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
      const sha = computePromptSha256(content);
      const prismaPromptType: string = promptType;

      // Atomic insert strategy:
      // - CTE computes next version for (organization_id, name) at execution time.
      // - INSERT uses that computed version and the precomputed content SHA.
      // - ON CONFLICT DO NOTHING prevents TOCTOU race failures when concurrent
      //   workers try to insert the same SHA or the same next version.
      // - Prisma unique constraints scope this behavior per organization + name:
      //   (organization_id, name, sha) blocks duplicate content for the same prompt
      //   name, and (organization_id, name, version) guarantees version uniqueness.
      //   The same SHA under a different name in the same organization is allowed.
      await tx.$queryRaw(Prisma.sql`
        WITH latest AS (
          SELECT COALESCE(MAX(version), 0) + 1 AS next_version
          FROM prompt_registry
          WHERE organization_id = ${organizationId}
            AND name = ${name}
        )
        INSERT INTO prompt_registry (
          id,
          organization_id,
          prompt_type,
          name,
          description,
          model,
          tools,
          file_path,
          content,
          sha,
          version
        )
        SELECT
          gen_random_uuid(),
          ${organizationId},
          ${prismaPromptType}::"PromptType",
          ${name},
          ${description},
          ${model},
          ${tools}::text[],
          ${filePath},
          ${content},
          ${sha},
          latest.next_version
        FROM latest
        ON CONFLICT DO NOTHING
      `);
    }
  });
}
