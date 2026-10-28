import {
  DEFAULT_DOC_SYNC_PG_POOL_MAX,
  DEFAULT_DOC_SYNC_PG_PORT,
  DocSyncPgAuth,
  type DocSyncPgConfig,
} from "../../env";

/** Password auth against the Postgres the suites run on, read from the shell. */
export const integrationPg: DocSyncPgConfig | undefined =
  process.env.DOC_SYNC_TEST_PG_HOST &&
  process.env.DOC_SYNC_TEST_PG_USER &&
  process.env.DOC_SYNC_TEST_PG_PASSWORD &&
  process.env.DOC_SYNC_TEST_PG_DATABASE
    ? {
        auth: DocSyncPgAuth.Password,
        host: process.env.DOC_SYNC_TEST_PG_HOST,
        port: process.env.DOC_SYNC_TEST_PG_PORT
          ? Number(process.env.DOC_SYNC_TEST_PG_PORT)
          : DEFAULT_DOC_SYNC_PG_PORT,
        user: process.env.DOC_SYNC_TEST_PG_USER,
        password: process.env.DOC_SYNC_TEST_PG_PASSWORD,
        database: process.env.DOC_SYNC_TEST_PG_DATABASE,
        poolMax: DEFAULT_DOC_SYNC_PG_POOL_MAX,
      }
    : undefined;

export const MISSING_PG_KEYS =
  "DOC_SYNC_TEST_PG_HOST, DOC_SYNC_TEST_PG_USER, DOC_SYNC_TEST_PG_PASSWORD or DOC_SYNC_TEST_PG_DATABASE";
