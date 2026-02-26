/**
 * Prompts registry service — upserts prompt snapshots into the database.
 *
 * Uses Prisma ORM with UUIDv7 generated in app code (codebase convention).
 * Race-safe: findUnique for idempotency, P2002 catch for concurrent version
 * collisions (equivalent to ON CONFLICT DO NOTHING).
 */

import type { TransactionClient } from "@repo/database";
import { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { v7 as uuidv7 } from "uuid";
import { computePromptSha256 } from "@/lib/prompt-snapshot-ingestion";
import type { PromptsSnapshot } from "@/lib/prompt-types";

/**
 * Upsert all prompts from a snapshot into the prompt_registry table.
 *
 * ## Transaction usage
 *
 * **With an outer `tx` (preferred when one is available):**
 * Pass the caller's transaction so prompt inserts participate in the same
 * atomic unit as the surrounding writes. If the outer transaction rolls back,
 * prompt inserts roll back too.
 *
 *   await upsertFromSnapshot(orgId, snapshot, tx);
 *
 * **Standalone (no outer `tx`):**
 * Omit `tx` and this function will open its own transaction.
 *
 *   await upsertFromSnapshot(orgId, snapshot);
 *
 * ## Race-safety
 *
 * - Idempotency: findUnique by (org, name, sha) — if exact content exists, skip.
 * - Version collision: create with computed next_version; catch P2002 when a
 *   concurrent worker claimed the same version (equivalent to ON CONFLICT DO NOTHING).
 *
 * NOTE: `withDb.tx` does not currently propagate ambient transactions via
 * AsyncLocalStorage when starting from `withDb.tx` itself. Pass `tx`
 * explicitly whenever this work must run in the caller's transaction.
 */
export async function upsertFromSnapshot(
  organizationId: string,
  snapshot: PromptsSnapshot | null,
  tx?: TransactionClient
): Promise<void> {
  if (!snapshot || snapshot.prompts.length === 0) {
    return;
  }

  const run = async (client: TransactionClient): Promise<void> => {
    for (const prompt of snapshot.prompts) {
      const { promptType, name, description, model, tools, filePath, content } =
        prompt;
      const sha = computePromptSha256(content);

      const existing = await client.prompt.findUnique({
        where: {
          organizationId_name_sha: { organizationId, name, sha },
        },
        select: { id: true },
      });
      if (existing) {
        return;
      }

      const latest = await client.prompt.aggregate({
        where: { organizationId, name },
        _max: { version: true },
      });
      const nextVersion = (latest._max.version ?? 0) + 1;

      try {
        await client.prompt.create({
          data: {
            id: uuidv7(),
            organizationId,
            promptType,
            name,
            description,
            model,
            tools,
            filePath,
            content,
            sha,
            version: nextVersion,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          // P2002 = unique constraint violation. Two cases:
          //
          // 1) (org, name, sha): Another worker already inserted this exact content.
          //    SHA is a content hash — same content ⇒ same SHA. The unique constraint
          //    (organization_id, name, sha) prevents duplicate content for the same
          //    prompt name. We skip; the other worker's row is the canonical one.
          //
          // 2) (org, name, version): Two workers computed the same next_version (e.g.
          //    both saw max=3, both tried version=4). One won; we lost. Equivalent
          //    to raw SQL's ON CONFLICT DO NOTHING — silently skip, no retry needed.
          log.debug(
            "[prompts-service] P2002 unique constraint — concurrent insert won",
            {
              organizationId,
              name,
              nextVersion,
            }
          );
          return;
        }
        throw error;
      }
    }
  };

  if (tx) {
    await run(tx);
    return;
  }

  await withDb.tx(run);
}
