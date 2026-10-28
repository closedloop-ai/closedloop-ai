/**
 * ISS-11867 replay, against real Postgres: `cloneDataFromPublic` into a schema
 * whose tables carry the two plpgsql trigger shapes that resolve names through
 * the clone session's `search_path` (`public`), not the target schema.
 *
 * - A trigger calling a function on its own row type, as ISS-11212's
 *   `github_comment_thread_projections_iss11212_anchor_bridge` did until
 *   20261006120300 dropped it. Fired by the clone, it failed every preview
 *   clone with "function … does not exist".
 * - A trigger writing another table by an unqualified name, as ISS-8674's
 *   `desktop_commands_queued_count_sync` does. Fired by the clone, it writes
 *   `public`'s table instead of the preview's.
 *
 * Each case builds the same DDL in `public` and in the preview schema, the way a
 * migration replay does, in its own database. Skips when DATABASE_URL is unset.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneDataFromPublic } from "../../scripts/clone-schema";
import { createSslClient, quoteIdentifier } from "../../scripts/db-utils";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);
const PREVIEW_SCHEMA = `preview_iss11867_${RUN_ID}`;

const ROW_TYPE_TRIGGER_DDL = `
CREATE TABLE "items" ("id" int PRIMARY KEY, "label" text NOT NULL);
CREATE FUNCTION "item_tag"(i "items", suffix text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT i."label" || suffix $$;
CREATE FUNCTION "items_tag_bridge"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "item_tag"(NEW, '!'::text);
  RETURN NULL;
END $$;
CREATE TRIGGER "items_tag" AFTER INSERT ON "items"
FOR EACH ROW EXECUTE FUNCTION "items_tag_bridge"();
`;

const COUNTER_TRIGGER_DDL = `
CREATE TABLE "counters" ("id" int PRIMARY KEY, "n" int NOT NULL DEFAULT 0);
CREATE TABLE "commands" (
  "id" int PRIMARY KEY,
  "counter_id" int NOT NULL REFERENCES "counters" ("id")
);
CREATE FUNCTION "count_command"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "counters" SET "n" = "n" + 1 WHERE "id" = NEW."counter_id";
  RETURN NULL;
END $$;
CREATE TRIGGER "commands_count" AFTER INSERT ON "commands"
FOR EACH ROW EXECUTE FUNCTION "count_command"();
ALTER TABLE "commands" ENABLE ALWAYS TRIGGER "commands_count";
CREATE TRIGGER "commands_count_off" AFTER INSERT ON "commands"
FOR EACH ROW EXECUTE FUNCTION "count_command"();
ALTER TABLE "commands" DISABLE TRIGGER "commands_count_off";
-- Postgres refuses ALTER TABLE ... DISABLE TRIGGER on a view, so the clone must
-- leave this one out of the triggers it turns off.
CREATE VIEW "command_ids" AS SELECT "id" FROM "commands";
CREATE TRIGGER "command_ids_insert" INSTEAD OF INSERT ON "command_ids"
FOR EACH ROW EXECUTE FUNCTION "count_command"();
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
  "ISS-11867: the preview clone does not fire the target's user triggers",
  () => {
    let database: string;

    beforeEach(async () => {
      database = `iss11867_${RUN_ID}_${randomUUID().slice(0, 8)}`;
      await withClient(requireUrl(), (client) =>
        client.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
      );
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await withClient(requireUrl(), (client) =>
        client.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`
        )
      );
    });

    /** Runs `ddl` in `public` and in the preview schema, then `seed` in `public`. */
    async function buildSchemas(ddl: string, seed: string): Promise<void> {
      await withClient(databaseUrl(database), async (client) => {
        await client.query(ddl);
        await client.query(seed);
        await client.query(`CREATE SCHEMA ${quoteIdentifier(PREVIEW_SCHEMA)}`);
        await client.query(
          `SET search_path TO ${quoteIdentifier(PREVIEW_SCHEMA)}`
        );
        await client.query(ddl);
      });
    }

    function triggerMode(trigger: string): Promise<string | undefined> {
      return withClient(databaseUrl(database), async (client) => {
        const { rows } = await client.query(
          `SELECT t.tgenabled AS mode FROM pg_catalog.pg_trigger t
             JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
            WHERE c.relnamespace = to_regnamespace($1) AND t.tgname = $2`,
          [PREVIEW_SCHEMA, trigger]
        );
        return rows[0]?.mode;
      });
    }

    function clone() {
      return cloneDataFromPublic(databaseUrl(database), PREVIEW_SCHEMA, {
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
    }

    it("clones a table whose trigger calls a function on its own row type", async () => {
      await buildSchemas(
        ROW_TYPE_TRIGGER_DDL,
        `INSERT INTO "items" VALUES (1, 'a')`
      );

      await expect(clone()).resolves.toBeUndefined();

      const items = await withClient(databaseUrl(database), async (client) => {
        const { rows } = await client.query(
          `SELECT "label" FROM ${quoteIdentifier(PREVIEW_SCHEMA)}."items"`
        );
        return rows.map((row: { label: string }) => row.label);
      });
      expect(items).toEqual(["a"]);
      expect(await triggerMode("items_tag")).toBe("O");
    });

    it("leaves public's table alone when the target's trigger writes by an unqualified name", async () => {
      await buildSchemas(
        COUNTER_TRIGGER_DDL,
        `INSERT INTO "counters" VALUES (1, 0); INSERT INTO "commands" VALUES (1, 1)`
      );

      await expect(clone()).resolves.toBeUndefined();

      const [publicCount, previewCount, previewCommands] = await withClient(
        databaseUrl(database),
        async (client) => {
          const preview = quoteIdentifier(PREVIEW_SCHEMA);
          const count = async (sql: string) =>
            (await client.query(sql)).rows[0]?.n;
          return [
            await count(`SELECT "n" FROM "public"."counters" WHERE "id" = 1`),
            await count(`SELECT "n" FROM ${preview}."counters" WHERE "id" = 1`),
            await count(`SELECT count(*)::int AS n FROM ${preview}."commands"`),
          ];
        }
      );
      // `public` counted its own command once at seed time; the clone adds none.
      expect(publicCount).toBe(1);
      expect(previewCount).toBe(1);
      expect(previewCommands).toBe(1);
      expect(await triggerMode("commands_count")).toBe("A");
      // A trigger disabled before the clone stays disabled, and is not touched.
      expect(await triggerMode("commands_count_off")).toBe("D");
    });
  }
);
