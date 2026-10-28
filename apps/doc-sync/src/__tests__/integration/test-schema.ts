import { randomUUID } from "node:crypto";
import pg from "pg";
import type { DocSyncPgConfig } from "../../env";
import { poolConfig, watchPoolErrors } from "../../storage/pool";

export type TestSchema = {
  /** A new pool whose sessions resolve unqualified names in this schema. */
  connect: () => pg.Pool;
  /** Ends every pool `connect` made and drops the schema. */
  drop: () => Promise<void>;
};

/** A fresh schema per test, so suites never see each other's rows or migrations. */
export async function createTestSchema(
  config: DocSyncPgConfig
): Promise<TestSchema> {
  const schema = `doc_sync_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(poolConfig(config));
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pools: pg.Pool[] = [];
  return {
    connect: () => {
      const pool = watchPoolErrors(
        new pg.Pool({
          ...poolConfig(config),
          options: `-c search_path=${schema}`,
        })
      );
      pools.push(pool);
      return pool;
    },
    drop: async () => {
      await Promise.all(
        pools.filter((pool) => !pool.ended).map((pool) => pool.end())
      );
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

/** Polls `check` until it holds, or fails after `timeoutMs`. */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<void> {
  const giveUpAt = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > giveUpAt) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

const WAIT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 50;
