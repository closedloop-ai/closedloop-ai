import { createHash } from "node:crypto";
import type { PrismaClient } from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";
import { SeedTransactionMode, type SeedTransactionStrategy } from "./profiles";

/**
 * Seed-specific namespace UUID (v4-format, fixed) used as the namespace for
 * all deterministic UUID v5 derivations. Keeping this constant ensures the
 * same logical seed key always maps to the same UUID across runs.
 */
const SEED_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/**
 * Produces a deterministic UUID v5-style string from a fixed namespace and a
 * caller-supplied key. Uses SHA-1 (the v5 hash) via node:crypto and formats
 * the first 16 bytes into the canonical 8-4-4-4-12 UUID layout with the
 * version (5) and variant bits set per RFC 4122.
 *
 * The same `key` always yields the same UUID for the seed namespace, making
 * this suitable for idempotent upserts on the `id` column.
 *
 * @param key - A unique string that identifies this seed entity (e.g. "org:project:my-project").
 */
export function deterministicUuid(key: string): string {
  // Concatenate namespace + key and hash with SHA-1
  const namespaceHex = SEED_NAMESPACE.replace(/-/g, "");
  const namespaceBytes = Buffer.from(namespaceHex, "hex");
  const keyBytes = Buffer.from(key, "utf8");

  const hash = createHash("sha1")
    .update(namespaceBytes)
    .update(keyBytes)
    .digest();

  // Set version bits (0101 = 5) in octet 6
  // biome-ignore lint/suspicious/noBitwiseOperators: UUID v5 generation requires bitwise operations (RFC 4122)
  hash[6] = (hash[6] & 0x0f) | 0x50;
  // Set variant bits (10xx) in octet 8
  // biome-ignore lint/suspicious/noBitwiseOperators: UUID v5 generation requires bitwise operations (RFC 4122)
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const hex = hash.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Prefix used by all seed log messages so they are easy to grep in CI output.
 */
const LOG_PREFIX = "[seed]";

/**
 * Logs a message to stdout with the standard `[seed]` prefix.
 */
export function seedLog(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

/**
 * Logs an error message to stderr with the standard `[seed]` prefix.
 */
export function seedError(message: string): void {
  console.error(`${LOG_PREFIX} ERROR: ${message}`);
}

/**
 * Tracks per-model upsert counters across the lifetime of a seed run.
 * Keys are model names (e.g. "Project"); values accumulate upserted counts.
 */
export type UpsertCounts = Record<string, { upserted: number }>;

/**
 * Creates a fresh, empty `UpsertCounts` accumulator.
 */
export function createUpsertCounts(): UpsertCounts {
  return {};
}

/**
 * Prints a summary table of all upsert counts to stdout.
 *
 * @param counts - The accumulated counts from one or more `upsertRow` calls.
 */
export function logUpsertSummary(counts: UpsertCounts): void {
  const models = Object.keys(counts).sort();
  if (models.length === 0) {
    seedLog("No rows upserted.");
    return;
  }

  seedLog("Upsert summary:");
  for (const model of models) {
    const { upserted } = counts[model];
    seedLog(`  ${model}: ${upserted} upserted`);
  }
}

/**
 * Arguments passed to `upsertRow`.
 */
export type UpsertRowArgs<TResult> = {
  /** Human-readable model name used in log output (e.g. "Project"). */
  model: string;
  /** Unique identifier used in log output for this row. */
  id: string;
  /** A function that performs the Prisma upsert and returns the saved record. */
  upsert: () => Promise<TResult>;
  /** Accumulator updated in-place with the result of this upsert. */
  counts: UpsertCounts;
};

export async function forEachSeedBatch<TItem>({
  items,
  batchSize,
  label,
  runBatch,
  run,
}: {
  items: readonly TItem[];
  batchSize: number;
  label: string;
  runBatch?: (
    run: (batchClient: TransactionClient) => Promise<void>
  ) => Promise<void>;
  run: (
    item: TItem,
    index: number,
    batchClient?: TransactionClient
  ) => Promise<void>;
}): Promise<void> {
  const normalizedBatchSize = Math.max(1, Math.floor(batchSize));
  for (
    let batchStart = 0;
    batchStart < items.length;
    batchStart += normalizedBatchSize
  ) {
    const batch = items.slice(batchStart, batchStart + normalizedBatchSize);
    seedLog(
      `Processing ${label} batch ${Math.floor(batchStart / normalizedBatchSize) + 1} (${batch.length} rows).`
    );
    const executeBatch = async (batchClient?: TransactionClient) => {
      for (let offset = 0; offset < batch.length; offset++) {
        await run(batch[offset], batchStart + offset, batchClient);
      }
    };
    if (runBatch) {
      await runBatch(executeBatch);
    } else {
      await executeBatch();
    }
  }
}

export function createSeedBatchTransactionRunner(
  prisma: TransactionClient,
  strategy: SeedTransactionStrategy
):
  | ((run: (batchClient: TransactionClient) => Promise<void>) => Promise<void>)
  | undefined {
  if (
    strategy.mode !== SeedTransactionMode.Batched ||
    !("$transaction" in prisma)
  ) {
    return undefined;
  }
  const transactionClient = prisma as PrismaClient;
  return (run) =>
    transactionClient.$transaction((tx) => run(tx), {
      timeout: strategy.timeoutMs,
      maxWait: strategy.maxWaitMs,
    });
}

/**
 * Executes a single Prisma upsert, updates the per-model count accumulator,
 * and logs the outcome to stdout.
 *
 * Usage example:
 * ```ts
 * const counts = createUpsertCounts();
 * const project = await upsertRow({
 *   model: "Project",
 *   id: projectId,
 *   upsert: () =>
 *     prisma.project.upsert({
 *       where: { id: projectId },
 *       create: { id: projectId, name: "Demo Project", ... },
 *       update: { name: "Demo Project" },
 *     }),
 *   counts,
 * });
 * ```
 *
 * @returns The value returned by the `upsert` function.
 */
export async function upsertRow<TResult>({
  model,
  id,
  upsert,
  counts,
}: UpsertRowArgs<TResult>): Promise<TResult> {
  const result = await upsert();

  // Initialise the model bucket if this is the first operation for it.
  if (!counts[model]) {
    counts[model] = { upserted: 0 };
  }

  counts[model].upserted++;
  seedLog(`  upserted ${model} id=${id}`);

  return result;
}
