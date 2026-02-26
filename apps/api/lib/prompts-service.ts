/**
 * Prompts registry service — upserts prompt snapshots into the database.
 *
 * Uses Prisma ORM with UUIDv7 generated in app code (codebase convention).
 * Race-safe: latest-content idempotency. P2002 version races are logged and
 * propagated — no retry (see upsertPromptVersion).
 */

import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import type { TransactionClient } from "@repo/database";
import { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { v7 as uuidv7 } from "uuid";

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
 * - Version collision: create with computed next_version. P2002 is logged and
 *   propagated; caller may retry at a higher level.
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
      await upsertPromptVersion(client, organizationId, prompt);
    }
  };

  if (tx) {
    await run(tx);
    return;
  }

  await withDb.tx(run);
}

/**
 * P2002 retry cannot reuse the same TransactionClient because any error aborts
 * the PostgreSQL session. We log and rethrow instead.
 *
 * TODO: For outer-tx callers: either accept that a version race will cause the
 * outer transaction to fail and let the caller retry at a higher level, or do
 * the prompt upsert outside the outer transaction in its own independent
 * withDb.tx call so aborts are isolated.
 */
async function upsertPromptVersion(
  client: TransactionClient,
  organizationId: string,
  prompt: PromptsSnapshot["prompts"][number]
): Promise<void> {
  try {
    await upsertPromptVersionCore(client, organizationId, prompt);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      log.warn(
        "[prompts-service] P2002 unique constraint — version race (concurrent upsert); error propagates",
        { organizationId, name: prompt.name, error }
      );
    }
    throw error;
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
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) {
    return false;
  }
  for (const v of leftSet) {
    if (!rightSet.has(v)) {
      return false;
    }
  }
  return true;
}
