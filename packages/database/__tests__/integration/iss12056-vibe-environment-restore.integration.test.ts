/**
 * ISS-12056, against real Postgres: seeded rows staged in batches through the
 * preview API land in a vibe environment's preview schema in one transaction,
 * whatever order the batches arrived in, and nothing outside that schema is
 * touched. Each case runs in its own throwaway database. Skips when
 * DATABASE_URL is unset.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSslClient, quoteIdentifier } from "../../scripts/db-utils";
import {
  restoreStagedVibeSeedRows,
  stageVibeSeedRows,
  VIBE_SEED_STAGING_TABLE,
} from "../../scripts/vibe-environment-restore";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);
const PREVIEW_SCHEMA = `preview_iss12056_${RUN_ID}`;

const DDL = `
CREATE TYPE "Role" AS ENUM ('OWNER', 'MEMBER');
CREATE TABLE "organizations" ("id" uuid PRIMARY KEY, "name" text NOT NULL);
CREATE TABLE "users" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL REFERENCES "organizations" ("id"),
  "role" "Role" NOT NULL DEFAULT 'MEMBER',
  "tags" text[] NOT NULL DEFAULT '{}',
  "byte_size" bigint
);
CREATE TABLE "events" ("id" serial PRIMARY KEY, "user_id" uuid REFERENCES "users" ("id"), "kind" text NOT NULL);
CREATE TABLE "search" ("id" int PRIMARY KEY, "body" text NOT NULL, "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "body")) STORED);
CREATE TABLE "_prisma_migrations" ("id" text PRIMARY KEY);
`;

const ORG = "0199a000-0000-7000-8000-000000000001";
const USER = "0199a000-0000-7000-8000-000000000002";

function requireUrl(): string {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required for this integration test");
  }
  return DATABASE_URL;
}

function databaseUrl(database: string): string {
  const url = new URL(requireUrl());
  url.pathname = `/${database}`;
  url.search = "";
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

const quiet = { log: vi.fn(), warn: vi.fn() };

describe.skipIf(!DATABASE_URL)(
  "ISS-12056: restoring a seeded vibe environment into its preview schema",
  () => {
    let database: string;

    beforeEach(async () => {
      database = `iss12056_${RUN_ID}_${randomUUID().slice(0, 8)}`;
      await withClient(requireUrl(), (client) =>
        client.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
      );
      await withClient(databaseUrl(database), async (client) => {
        await client.query(DDL);
        await client.query(`CREATE SCHEMA ${quoteIdentifier(PREVIEW_SCHEMA)}`);
        await client.query(
          `SET search_path TO ${quoteIdentifier(PREVIEW_SCHEMA)}`
        );
        await client.query(DDL);
      });
    });

    afterEach(async () => {
      await withClient(requireUrl(), (client) =>
        client.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`
        )
      );
    });

    function stage(table: string, rows: unknown[]) {
      return withClient(databaseUrl(database), (client) =>
        stageVibeSeedRows(client, PREVIEW_SCHEMA, table, JSON.stringify(rows))
      );
    }

    function restore(
      inTransaction: () => Promise<void> = () => Promise.resolve()
    ) {
      return withClient(databaseUrl(database), (client) =>
        restoreStagedVibeSeedRows(client, PREVIEW_SCHEMA, quiet, inTransaction)
      );
    }

    it("loads child batches staged before their parents, with enums, arrays and big integers intact", async () => {
      await stage("events", [{ id: 41, user_id: USER, kind: "opened" }]);
      // Raw text, as the seed database emits it: a JavaScript number cannot
      // hold this value, so it must reach Postgres without being parsed.
      await withClient(databaseUrl(database), (client) =>
        stageVibeSeedRows(
          client,
          PREVIEW_SCHEMA,
          "users",
          `[{"id":"${USER}","organization_id":"${ORG}","role":"OWNER","tags":["lead","design"],"byte_size":9007199254740993}]`
        )
      );
      await stage("organizations", [{ id: ORG, name: "Acme Co" }]);
      await stage("search", [{ id: 1, body: "bulk select", tsv: "ignored" }]);
      const inTransaction = vi.fn(() => Promise.resolve());

      await expect(restore(inTransaction)).resolves.toEqual({
        tables: 4,
        rows: 4,
      });
      expect(inTransaction).toHaveBeenCalledTimes(1);

      const state = await withClient(databaseUrl(database), async (client) => {
        const schema = quoteIdentifier(PREVIEW_SCHEMA);
        const user = await client.query(
          `SELECT role::text AS role, tags, byte_size::text AS size FROM ${schema}."users"`
        );
        const search = await client.query(
          `SELECT tsv::text AS tsv FROM ${schema}."search"`
        );
        const nextEvent = await client.query(
          `INSERT INTO ${schema}."events" (kind) VALUES ('next') RETURNING id`
        );
        const staging = await client.query("SELECT to_regclass($1) AS rel", [
          `${schema}.${quoteIdentifier(VIBE_SEED_STAGING_TABLE)}`,
        ]);
        const publicOrgs = await client.query(
          `SELECT count(*)::int AS n FROM "public"."organizations"`
        );
        return {
          user: user.rows[0],
          tsv: search.rows[0]?.tsv,
          nextEventId: nextEvent.rows[0]?.id,
          staging: staging.rows[0]?.rel,
          publicOrgs: publicOrgs.rows[0]?.n,
        };
      });
      expect(state.user).toEqual({
        role: "OWNER",
        tags: ["lead", "design"],
        size: "9007199254740993",
      });
      expect(state.tsv).toBe("'bulk':1 'select':2");
      expect(state.nextEventId).toBe(42);
      expect(state.staging).toBeNull();
      expect(state.publicOrgs).toBe(0);
    });

    it("stages an exact retry once while retaining a different batch for the same table", async () => {
      const otherOrg = randomUUID();
      const firstBatch = [{ id: ORG, name: "Acme Co" }];
      expect(await stage("organizations", firstBatch)).toEqual({ staged: 1 });
      expect(await stage("organizations", firstBatch)).toEqual({ staged: 1 });
      expect(
        await stage("organizations", [{ id: otherOrg, name: "Another Org" }])
      ).toEqual({ staged: 1 });

      const staged = await withClient(databaseUrl(database), (client) =>
        client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${quoteIdentifier(PREVIEW_SCHEMA)}.${quoteIdentifier(VIBE_SEED_STAGING_TABLE)}`
        )
      );
      expect(staged.rows[0]?.count).toBe(2);
      await expect(restore()).resolves.toEqual({ tables: 1, rows: 2 });
    });

    it("rolls back everything when a staged row breaks a foreign key", async () => {
      await stage("users", [{ id: USER, organization_id: ORG }]);
      await stage("organizations", [{ id: randomUUID(), name: "Other" }]);

      await expect(restore()).rejects.toThrow();

      const remaining = await withClient(databaseUrl(database), (client) =>
        client.query(
          `SELECT (SELECT count(*)::int FROM ${quoteIdentifier(PREVIEW_SCHEMA)}."organizations") AS orgs,
                  (SELECT count(*)::int FROM ${quoteIdentifier(PREVIEW_SCHEMA)}.${quoteIdentifier(VIBE_SEED_STAGING_TABLE)}) AS staged`
        )
      );
      expect(remaining.rows[0]).toEqual({ orgs: 0, staged: 2 });
    });

    it("refuses a staged column the preview schema does not have", async () => {
      await stage("organizations", [{ id: ORG, name: "Acme Co", plan: "pro" }]);

      await expect(restore()).rejects.toThrow(
        "organizations has no column(s) plan"
      );
    });

    it.each([
      ["a table the schema does not have", "billing", "has no table billing"],
      ["the migrations table", "_prisma_migrations", "is never seeded"],
      ["the staging table", VIBE_SEED_STAGING_TABLE, "is never seeded"],
    ])("refuses to stage %s", async (_label, table, message) => {
      await expect(stage(table, [{ id: "x" }])).rejects.toThrow(message);
    });

    it("refuses rows that are not a JSON array of objects", async () => {
      await expect(
        withClient(databaseUrl(database), (client) =>
          stageVibeSeedRows(client, PREVIEW_SCHEMA, "organizations", "[1, 2]")
        )
      ).rejects.toThrow("must be a JSON array of objects");
    });

    it("refuses public before any statement runs", async () => {
      const query = vi.fn();
      await expect(
        stageVibeSeedRows({ query }, "public", "organizations", "[]")
      ).rejects.toThrow("only branch preview schemas");
      expect(query).not.toHaveBeenCalled();
    });
  }
);
