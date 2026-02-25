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

type ExistingPromptRow = { id: string };
type LatestVersionRow = { version: number };

/**
 * Upsert all prompts from a snapshot into the prompt_registry table.
 *
 * This flow intentionally avoids DB-generated SHA/version behavior in favor of
 * explicit, application-managed logic:
 * 1) Compute SHA in app code.
 * 2) In one transaction, check (organization_id, name, sha).
 * 3) No-op when unchanged; otherwise insert with latestVersion + 1.
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
      const existingPrompt = await tx.$queryRaw<ExistingPromptRow[]>(Prisma.sql`
        SELECT id
        FROM prompt_registry
        WHERE organization_id = ${organizationId}
          AND name = ${name}
          AND sha = ${sha}
        LIMIT 1
      `);

      if (existingPrompt.length > 0) {
        continue;
      }

      const latestVersionRows = await tx.$queryRaw<
        LatestVersionRow[]
      >(Prisma.sql`
        SELECT version
        FROM prompt_registry
        WHERE organization_id = ${organizationId}
          AND name = ${name}
        ORDER BY version DESC
        LIMIT 1
      `);
      const nextVersion = (latestVersionRows[0]?.version ?? 0) + 1;

      await tx.$queryRaw(Prisma.sql`
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
        VALUES (
          uuid_generate_v7(),
          ${organizationId},
          ${prismaPromptType}::"PromptType",
          ${name},
          ${description},
          ${model},
          ${tools}::text[],
          ${filePath},
          ${content},
          ${sha},
          ${nextVersion}
        )
      `);
    }
  });
}
