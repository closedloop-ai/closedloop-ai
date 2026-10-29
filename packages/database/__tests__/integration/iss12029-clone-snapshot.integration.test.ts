/**
 * ISS-12029 replay, against real Postgres: a parent and child committed to
 * `public` by another connection between two of the clone's table copies, the
 * way stage `integration-tests` writes teams → projects → artifacts while a
 * preview clones. Each table copy must read the same snapshot, or the child
 * lands without its parent and the FK drain fails with 23503.
 *
 * A table rewrite committed after that snapshot reads as empty to it, so a
 * concurrent `ALTER COLUMN TYPE` on a table not yet copied must not leave the
 * preview with that table empty.
 *
 * Skips when DATABASE_URL is unset.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneDataFromPublic } from "../../scripts/clone-schema";
import { createSslClient, quoteIdentifier } from "../../scripts/db-utils";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);
const PREVIEW_SCHEMA = `preview_iss12029_${RUN_ID}`;
const PREVIEW = quoteIdentifier(PREVIEW_SCHEMA);

const DDL = `
CREATE TABLE "parents" ("id" int PRIMARY KEY);
CREATE TABLE "children" (
  "id" int PRIMARY KEY,
  "parent_id" int NOT NULL REFERENCES "parents" ("id")
);
`;

function requireUrl(): string {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required for this integration test");
  }
  return DATABASE_URL;
}

function databaseUrl(database: string): string {
  const url = new URL(requireUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient<T>(
  url: string,
  fn: (client: ReturnType<typeof createSslClient>) => Promise<T>
): Promise<T> {
  const client = createSslClient(url);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe.skipIf(!DATABASE_URL)(
  "ISS-12029: the preview clone reads public at one snapshot",
  () => {
    let database: string;

    beforeEach(async () => {
      database = `iss12029_${RUN_ID}_${randomUUID().slice(0, 8)}`;
      await withClient(requireUrl(), (client) =>
        client.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
      );
      await withClient(databaseUrl(database), async (client) => {
        await client.query(DDL);
        await client.query(
          `INSERT INTO "parents" VALUES (1); INSERT INTO "children" VALUES (1, 1)`
        );
        await client.query(`CREATE SCHEMA ${PREVIEW}`);
        await client.query(`SET search_path TO ${PREVIEW}`);
        await client.query(DDL);
      });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await withClient(requireUrl(), (client) =>
        client.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`
        )
      );
    });

    it("excludes a parent and child committed between two table copies", async () => {
      const url = databaseUrl(database);
      let concurrentWrites = 0;
      const createClient: typeof createSslClient = (target, opts) => {
        const client = createSslClient(target, opts);
        const query = client.query.bind(client);
        vi.spyOn(client, "query").mockImplementation(
          async (sql: string, params?: unknown[]) => {
            const result = await query(sql, params);
            if (sql.startsWith(`INSERT INTO ${PREVIEW}."parents"`)) {
              await withClient(url, (writer) =>
                writer.query(
                  `INSERT INTO "parents" VALUES (2); INSERT INTO "children" VALUES (2, 2)`
                )
              );
              concurrentWrites += 1;
            }
            return result;
          }
        );
        return client;
      };

      await expect(
        cloneDataFromPublic(url, PREVIEW_SCHEMA, {
          createClient,
          logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        })
      ).resolves.toBeUndefined();

      const ids = await withClient(url, async (client) => {
        const read = async (sql: string) =>
          (await client.query(sql)).rows.map((row: { id: number }) => row.id);
        return {
          publicParents: await read(`SELECT "id" FROM "parents" ORDER BY 1`),
          previewParents: await read(
            `SELECT "id" FROM ${PREVIEW}."parents" ORDER BY 1`
          ),
          previewChildren: await read(
            `SELECT "id" FROM ${PREVIEW}."children" ORDER BY 1`
          ),
        };
      });
      expect(concurrentWrites).toBe(1);
      expect(ids.publicParents).toEqual([1, 2]);
      expect(ids.previewParents).toEqual([1]);
      expect(ids.previewChildren).toEqual([1]);
    });

    it("copies the rows of a table a concurrent ALTER rewrites before the clone reaches it", async () => {
      const url = databaseUrl(database);
      const writer = createSslClient(url);
      await writer.connect();
      try {
        const { rows } = await writer.query("SELECT pg_backend_pid() AS pid");
        const writerPid: number = rows[0].pid;
        let rewrite: Promise<unknown> | undefined;
        let rewriteSettled = false;
        const createClient: typeof createSslClient = (target, opts) => {
          const client = createSslClient(target, opts);
          const query = client.query.bind(client);
          vi.spyOn(client, "query").mockImplementation(
            async (sql: string, params?: unknown[]) => {
              const result = await query(sql, params);
              if (sql.startsWith(`INSERT INTO ${PREVIEW}."parents"`)) {
                rewrite = writer
                  .query(`ALTER TABLE "children" ALTER COLUMN "id" TYPE bigint`)
                  .finally(() => {
                    rewriteSettled = true;
                  });
                await Promise.race([
                  rewrite,
                  untilWaitingOnLock(url, writerPid, () => rewriteSettled),
                ]);
              }
              return result;
            }
          );
          return client;
        };

        await expect(
          cloneDataFromPublic(url, PREVIEW_SCHEMA, {
            createClient,
            logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
          })
        ).resolves.toBeUndefined();
        await rewrite;

        const { rows: publicType } = await writer.query(
          `SELECT format_type(atttypid, atttypmod) AS type FROM pg_catalog.pg_attribute
           WHERE attrelid = '"public"."children"'::regclass AND attname = 'id'`
        );
        const { rows: previewChildren } = await writer.query(
          `SELECT "id" FROM ${PREVIEW}."children" ORDER BY 1`
        );
        expect(rewrite).toBeDefined();
        expect(publicType).toEqual([{ type: "bigint" }]);
        expect(previewChildren).toEqual([{ id: 1 }]);
      } finally {
        await writer.end();
      }
    });
  }
);

async function untilWaitingOnLock(
  url: string,
  pid: number,
  settled: () => boolean
): Promise<void> {
  await withClient(url, async (client) => {
    while (!settled()) {
      const { rows } = await client.query(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
        [pid]
      );
      if (rows[0]?.wait_event_type === "Lock") {
        return;
      }
      await sleep(10);
    }
  });
}
