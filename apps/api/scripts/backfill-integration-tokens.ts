/**
 * Backfill script: encrypt plaintext Slack integration tokens using AWS KMS.
 *
 * Reads all SlackIntegration rows where accessTokenEncrypted is NULL and writes
 * the encrypted value to that field, in batches to avoid memory issues. Slack's
 * `access_token` is still NOT NULL and has no refresh token, so only
 * accessTokenEncrypted is set.
 *
 * ISS-11096 removed the Google and Linear halves and dropped their plaintext
 * columns; production held no plaintext in either table when they went.
 *
 * Usage:
 *   cd apps/api
 *   KMS_KEY_ARN=<arn> DATABASE_URL=<url> npx tsx scripts/backfill-integration-tokens.ts
 *
 * Dry-run mode (logs what would be done without writing):
 *   DRY_RUN=1 KMS_KEY_ARN=<arn> DATABASE_URL=<url> npx tsx scripts/backfill-integration-tokens.ts
 */
import { pathToFileURL } from "node:url";
import { withDb } from "@repo/database";
import { encryptIntegrationToken } from "@/lib/integration-encryption";

const BATCH_SIZE = 50;

export type BackfillRow = {
  id: string;
  accessToken: string;
};

export type BackfillConfig<T extends BackfillRow> = {
  label: string;
  count: () => Promise<number>;
  /**
   * The next page of rows needing backfill, ordered by `id`, starting strictly
   * after `afterId`. The cursor is what makes the walk terminate: a row this
   * run does NOT write — it lost its compare-and-set, its encrypt threw, or
   * this is a dry run — stays inside the filter, so a cursorless re-read of
   * "the first unprocessed batch" would hand it straight back forever.
   */
  findBatch: (afterId: string | null) => Promise<T[]>;
  /**
   * Compare-and-set on the exact plaintext this batch read, resolving to the
   * number of rows written. An id-only update would fence nothing: a live
   * connect or refresh landing between `findBatch` and here has already stored
   * its own ciphertext for a NEWER token, and writing this batch's ciphertext
   * over it would put the superseded credential back. Reads prefer ciphertext
   * over plaintext, so every later read would then decrypt a dead token.
   * A resolved 0 means the row lost that race.
   */
  update: (row: T, data: { accessTokenEncrypted: string }) => Promise<number>;
};

async function encryptRow<T extends BackfillRow>(
  config: BackfillConfig<T>,
  row: T,
  dryRun: boolean
): Promise<boolean> {
  const accessTokenEncrypted = await encryptIntegrationToken(row.accessToken);

  if (dryRun) {
    return true;
  }

  const written = await config.update(row, { accessTokenEncrypted });

  return written > 0;
}

export async function backfillIntegration<T extends BackfillRow>(
  config: BackfillConfig<T>,
  dryRun: boolean
): Promise<void> {
  const total = await config.count();

  if (total === 0) {
    console.log(`${config.label}: no rows need backfill, skipping.`);
    return;
  }

  const suffix = dryRun ? " (DRY RUN)" : "";
  console.log(`${config.label}: ${total} rows need backfill.${suffix}`);

  let processed = 0;
  let failures = 0;
  let raced = 0;

  // Walk the id order once. Every pass starts strictly after the last row seen,
  // so the cursor advances whether or not the row was written and the loop
  // always terminates — including a dry run, which writes nothing and would
  // otherwise re-read the same first batch until killed. A row skipped this run
  // stays in the filter and the next run picks it up.
  let afterId: string | null = null;
  let rows = await config.findBatch(afterId);

  while (rows.length > 0) {
    for (const row of rows) {
      try {
        if (await encryptRow(config, row, dryRun)) {
          processed++;
        } else {
          raced++;
        }
      } catch (error) {
        console.error(
          `${config.label}: failed to encrypt row ${row.id}:`,
          error
        );
        failures++;
      }
    }

    console.log(
      `${config.label}: encrypted ${processed}/${total} rows${suffix}`
    );

    afterId = rows.at(-1)?.id ?? null;
    rows = afterId === null ? [] : await config.findBatch(afterId);
  }

  if (raced > 0) {
    // Not a failure: the row was rewritten by a live connect or refresh, which
    // stores ciphertext on its own normal path.
    console.log(
      `${config.label}: ${raced} rows changed under the backfill and were left alone.`
    );
  }

  console.log(
    `${config.label}: backfill complete. Processed ${processed}/${total}, ${raced} raced, ${failures} failures.`
  );

  if (failures > 0) {
    throw new Error(
      `Failed to encrypt ${failures} of ${processed + failures} rows`
    );
  }
}

export async function backfillSlackIntegrations(
  dryRun: boolean
): Promise<void> {
  await backfillIntegration(
    {
      label: "SlackIntegration",
      count: () =>
        withDb((db) =>
          db.slackIntegration.count({
            where: { accessTokenEncrypted: null },
          })
        ),
      findBatch: (afterId) =>
        withDb((db) =>
          db.slackIntegration.findMany({
            where: { accessTokenEncrypted: null, ...afterRow(afterId) },
            select: {
              id: true,
              accessToken: true,
            },
            take: BATCH_SIZE,
            orderBy: { id: "asc" },
          })
        ),
      update: (row, data) =>
        withDb((db) =>
          db.slackIntegration.updateMany({
            where: {
              id: row.id,
              accessToken: row.accessToken,
              accessTokenEncrypted: null,
            },
            data,
          })
        ).then((result) => result.count),
    },
    dryRun
  );
}

async function main(): Promise<void> {
  const dryRun = Boolean(process.env.DRY_RUN);

  console.log(
    `Starting integration token backfill...${dryRun ? " (DRY RUN — no writes)" : ""}`
  );

  if (!process.env.KMS_KEY_ARN) {
    console.error("Error: KMS_KEY_ARN environment variable is required.");
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error("Error: DATABASE_URL environment variable is required.");
    process.exit(1);
  }

  try {
    await backfillSlackIntegrations(dryRun);
    console.log("Backfill complete.");
  } catch (error) {
    console.error("Backfill failed:", error);
    process.exit(1);
  }
}

// Only run when invoked as a script. Without this the module cannot be
// imported by a test: `main()` would execute on import and `process.exit(1)` on
// the absent KMS_KEY_ARN.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}

/**
 * The cursor clause for a batch, empty on the first pass. Pairs with the
 * `orderBy: { id: "asc" }` every `findBatch` already carries.
 */
function afterRow(afterId: string | null) {
  return afterId === null ? {} : { id: { gt: afterId } };
}
