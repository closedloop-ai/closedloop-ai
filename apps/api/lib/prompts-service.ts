/**
 * Prompts registry service — upserts prompt snapshots into the database.
 *
 * Uses Prisma ORM with UUIDv7 generated in app code (codebase convention).
 * Race-safe: latest-content idempotency with bounded retries that avoid
 * transaction-aborting unique violations during version races.
 */

import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import type { TransactionClient } from "@repo/database";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { v7 as uuidv7 } from "uuid";

const PROMPT_UPSERT_MAX_ATTEMPTS = 3;
const PROMPT_UPSERT_RETRY_DELAY_MS = 500;

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
 * - Idempotency: skip insert when any existing row for (org, name) already has
 *   identical content/model/tools.
 * - Version collision: write with createMany(skipDuplicates) and retry up to 3
 *   times in-process, avoiding unique-violation aborts in outer transactions.
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

async function upsertPromptVersion(
  client: TransactionClient,
  organizationId: string,
  prompt: PromptsSnapshot["prompts"][number]
): Promise<void> {
  for (let attempt = 1; attempt <= PROMPT_UPSERT_MAX_ATTEMPTS; attempt += 1) {
    const wroteVersion = await upsertPromptVersionCore(
      client,
      organizationId,
      prompt
    );

    if (wroteVersion) {
      return;
    }

    if (attempt < PROMPT_UPSERT_MAX_ATTEMPTS) {
      await delay(PROMPT_UPSERT_RETRY_DELAY_MS);
    }
  }

  // Non-fatal race exhaustion: keep outer transaction healthy.
  log.warn(
    "[prompts-service] version race retries exhausted; prompt upsert skipped",
    {
      organizationId,
      name: prompt.name,
      attempts: PROMPT_UPSERT_MAX_ATTEMPTS,
    }
  );
}

/**
 * Performs one optimistic "CAS-style create" attempt for prompt versioning.
 *
 * Why this function exists:
 * - This service can run inside a caller-owned transaction.
 * - A classic unique-violation path (e.g. create -> P2002) is risky in that
 *   context because DB errors can poison/abort the outer transaction.
 * - We therefore model contention as a non-throwing result and retry in
 *   `upsertPromptVersion`, keeping the transaction usable.
 *
 * Algorithm (single attempt):
 * 1) Idempotency pre-check:
 *    - Query rows with same `(organizationId, name, content, model)`.
 *    - Compare tools as sets (order-insensitive).
 *    - If any equal payload exists, return `true` (nothing to write).
 *
 * 2) Read current head version:
 *    - Fetch latest version for `(organizationId, name)`.
 *    - Candidate next version is `latest + 1` (or `1` if none).
 *
 * 3) CAS-style append write:
 *    - Insert candidate row with `createMany({ skipDuplicates: true })`.
 *    - Unique key `(organizationId, name, version)` arbitrates races.
 *    - If another transaction already inserted that same version first:
 *      `count === 0` (no exception thrown).
 *
 * Return contract:
 * - `true`: write succeeded or prompt already existed with same payload.
 * - `false`: benign race/lost attempt (`count === 0`), caller should retry.
 *
 * Why this prevents transaction failures:
 * - Contention is handled through `count` checks instead of DB exceptions.
 * - Avoiding unique-constraint exceptions prevents aborting outer tx state.
 *
 * Concurrency notes:
 * - This is CAS-style behavior for an append-only history table, not a
 *   strict compare-and-set update on a mutable "head" row.
 * - Bounded retries in caller handle transient version races.
 */
async function upsertPromptVersionCore(
  client: TransactionClient,
  organizationId: string,
  prompt: PromptsSnapshot["prompts"][number]
): Promise<boolean> {
  const existingWithSameContent = await client.prompt.findMany({
    where: {
      organizationId,
      name: prompt.name,
      content: prompt.content,
      model: prompt.model,
    },
    orderBy: {
      version: "desc",
    },
    select: {
      tools: true,
    },
  });

  if (
    existingWithSameContent.some((row) =>
      haveSameTools(row.tools, prompt.tools)
    )
  ) {
    return true;
  }

  const latest = await client.prompt.findFirst({
    where: {
      organizationId,
      name: prompt.name,
    },
    orderBy: {
      version: "desc",
    },
    select: { version: true },
  });

  const writeResult = await client.prompt.createMany({
    data: [
      {
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
    ],
    skipDuplicates: true,
  });

  return writeResult.count > 0;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
