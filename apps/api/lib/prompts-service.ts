/**
 * Prompts registry service — upserts prompt snapshots into the database.
 *
 * Uses Prisma ORM with UUIDv7 generated in app code (codebase convention).
 * Race-safe: latest-content idempotency with P2002 retry for version races.
 */

import type { TransactionClient } from "@repo/database";
import { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { v7 as uuidv7 } from "uuid";
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
 * - Idempotency: compare incoming content, model, and tools with latest
 *   (org, name) version.
 * - Version collision: create with computed next_version; retry on P2002 when a
 *   concurrent worker claimed the same version.
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
      await upsertPromptVersionWithRetry(client, organizationId, prompt);
    }
  };

  if (tx) {
    await run(tx);
    return;
  }

  await withDb.tx(run);
}

const MAX_P2002_RETRIES = 3;

async function upsertPromptVersionWithRetry(
  client: TransactionClient,
  organizationId: string,
  prompt: PromptsSnapshot["prompts"][number]
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_P2002_RETRIES; attempt++) {
    try {
      await upsertPromptVersionCore(client, organizationId, prompt);
      return;
    } catch (error) {
      if (!isUniqueConstraintError(error) || attempt === MAX_P2002_RETRIES) {
        throw error;
      }

      log.debug(
        "[prompts-service] P2002 unique constraint — retrying prompt upsert",
        {
          organizationId,
          name: prompt.name,
          attempt: attempt + 1,
          maxRetries: MAX_P2002_RETRIES,
        }
      );
    }
  }
}

async function upsertPromptVersionCore(
  client: TransactionClient,
  organizationId: string,
  prompt: PromptsSnapshot["prompts"][number]
): Promise<void> {
  const latest = await client.prompt.findFirst({
    where: {
      organizationId,
      name: prompt.name,
    },
    orderBy: {
      version: "desc",
    },
    select: {
      version: true,
      content: true,
      model: true,
      tools: true,
    },
  });

  if (
    latest &&
    latest.content === prompt.content &&
    latest.model === prompt.model &&
    haveSameTools(latest.tools, prompt.tools)
  ) {
    return;
  }

  await client.prompt.create({
    data: {
      id: uuidv7(),
      organizationId,
      promptType: prompt.promptType,
      name: prompt.name,
      description: prompt.description,
      model: prompt.model,
      tools: prompt.tools,
      filePath: prompt.filePath,
      content: prompt.content,
      version: (latest?.version ?? 0) + 1,
    },
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    return true;
  }

  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

function haveSameTools(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}
