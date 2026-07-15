/**
 * Backfill script: encrypt plaintext integration tokens using AWS KMS.
 *
 * Reads all GoogleIntegration, LinearIntegration, and SlackIntegration rows
 * where accessTokenEncrypted is NULL and writes the encrypted values to the
 * encrypted fields. Processes rows in batches to avoid memory issues.
 * (SlackIntegration has no refresh token, so only accessTokenEncrypted is set.)
 *
 * Usage:
 *   cd apps/api
 *   KMS_KEY_ARN=<arn> DATABASE_URL=<url> npx tsx scripts/backfill-integration-tokens.ts
 *
 * Dry-run mode (logs what would be done without writing):
 *   DRY_RUN=1 KMS_KEY_ARN=<arn> DATABASE_URL=<url> npx tsx scripts/backfill-integration-tokens.ts
 */
import { withDb } from "@repo/database";
import { encryptTokenPair } from "@/lib/integration-encryption";

const BATCH_SIZE = 50;

type BackfillRow = {
  id: string;
  accessToken: string;
  refreshToken: string | null;
};

type BackfillConfig<T extends BackfillRow> = {
  label: string;
  count: () => Promise<number>;
  findBatch: () => Promise<T[]>;
  update: (
    id: string,
    data: {
      accessTokenEncrypted: string;
      refreshTokenEncrypted?: string;
    }
  ) => Promise<void>;
};

async function encryptRow<T extends BackfillRow>(
  config: BackfillConfig<T>,
  row: T,
  dryRun: boolean
): Promise<boolean> {
  const { encryptedAccessToken, encryptedRefreshToken } =
    await encryptTokenPair(row.accessToken, row.refreshToken);

  if (dryRun) {
    return true;
  }

  await config.update(row.id, {
    accessTokenEncrypted: encryptedAccessToken,
    ...(encryptedRefreshToken === null
      ? {}
      : { refreshTokenEncrypted: encryptedRefreshToken }),
  });

  return true;
}

async function backfillIntegration<T extends BackfillRow>(
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

  // Updated rows drop out of the `accessTokenEncrypted: null` filter,
  // so always take the first batch of unprocessed rows.
  let rows = await config.findBatch();

  while (rows.length > 0) {
    for (const row of rows) {
      try {
        await encryptRow(config, row, dryRun);
        processed++;
      } catch (error) {
        console.error(
          `${config.label}: failed to encrypt row ${row.id}:`,
          error
        );
        failures++;
      }
    }

    if (processed % 10 === 0 || rows.length < BATCH_SIZE) {
      console.log(
        `${config.label}: encrypted ${processed}/${total} rows${suffix}`
      );
    }

    rows = await config.findBatch();
  }

  console.log(
    `${config.label}: backfill complete. Processed ${processed}/${total}, ${failures} failures.`
  );

  if (failures > 0) {
    throw new Error(
      `Failed to encrypt ${failures} of ${processed + failures} rows`
    );
  }
}

async function backfillGoogleIntegrations(dryRun: boolean): Promise<void> {
  await backfillIntegration(
    {
      label: "GoogleIntegration",
      count: () =>
        withDb((db) =>
          db.googleIntegration.count({
            where: { accessTokenEncrypted: null },
          })
        ),
      findBatch: () =>
        withDb((db) =>
          db.googleIntegration.findMany({
            where: { accessTokenEncrypted: null },
            select: {
              id: true,
              accessToken: true,
              refreshToken: true,
            },
            take: BATCH_SIZE,
            orderBy: { id: "asc" },
          })
        ),
      update: (id, data) =>
        withDb((db) =>
          db.googleIntegration.update({ where: { id }, data })
        ).then(() => undefined),
    },
    dryRun
  );
}

async function backfillLinearIntegrations(dryRun: boolean): Promise<void> {
  await backfillIntegration(
    {
      label: "LinearIntegration",
      count: () =>
        withDb((db) =>
          db.linearIntegration.count({
            where: { accessTokenEncrypted: null },
          })
        ),
      findBatch: () =>
        withDb((db) =>
          db.linearIntegration.findMany({
            where: { accessTokenEncrypted: null },
            select: {
              id: true,
              accessToken: true,
              refreshToken: true,
            },
            take: BATCH_SIZE,
            orderBy: { id: "asc" },
          })
        ),
      update: (id, data) =>
        withDb((db) =>
          db.linearIntegration.update({ where: { id }, data })
        ).then(() => undefined),
    },
    dryRun
  );
}

async function backfillSlackIntegrations(dryRun: boolean): Promise<void> {
  await backfillIntegration(
    {
      label: "SlackIntegration",
      count: () =>
        withDb((db) =>
          db.slackIntegration.count({
            where: { accessTokenEncrypted: null },
          })
        ),
      // SlackIntegration has no refresh token, so refreshToken is always null;
      // encryptTokenPair skips the refresh half when it is null.
      findBatch: () =>
        withDb((db) =>
          db.slackIntegration
            .findMany({
              where: { accessTokenEncrypted: null },
              select: {
                id: true,
                accessToken: true,
              },
              take: BATCH_SIZE,
              orderBy: { id: "asc" },
            })
            .then((rows) => rows.map((row) => ({ ...row, refreshToken: null })))
        ),
      update: (id, data) =>
        withDb((db) =>
          db.slackIntegration.update({
            where: { id },
            // Slack rows have no refresh token; only accessTokenEncrypted is set.
            data: { accessTokenEncrypted: data.accessTokenEncrypted },
          })
        ).then(() => undefined),
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
    await backfillGoogleIntegrations(dryRun);
    await backfillLinearIntegrations(dryRun);
    await backfillSlackIntegrations(dryRun);
    console.log("Backfill complete.");
  } catch (error) {
    console.error("Backfill failed:", error);
    process.exit(1);
  }
}

main();
