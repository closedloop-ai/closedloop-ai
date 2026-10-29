/**
 * ISS-12135 (bug 26), against real Postgres: finalize hands the seed's
 * signed-in person to the person and re-derives the PEOPLE sort keys naming
 * them, touching nothing else. Each case runs in its own throwaway database.
 * Skips when DATABASE_URL is unset.
 */

import { randomUUID } from "node:crypto";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { LOCAL_TRUSTED_USER_ID } from "@repo/auth/auth-mode";
import {
  createSslClient,
  quoteIdentifier,
} from "@repo/database/scripts/db-utils";
import { VibeSeedRestoreError } from "@repo/database/scripts/vibe-environment-restore";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { avatarAdoptionDdl } from "@/__tests__/support/preview-schemas/avatar-adoption.test-fixtures";
import { adoptSeededPerson, type PersonProfile } from "./adopt-person";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);
const SCHEMA = `preview_iss12135_${RUN_ID}`;
const S = quoteIdentifier(SCHEMA);

const DDL = `
CREATE TYPE ${S}."CustomFieldType" AS ENUM ('TEXT', 'PEOPLE');
CREATE TABLE ${S}."organizations" ("id" uuid PRIMARY KEY, "clerk_id" text NOT NULL UNIQUE, "name" text NOT NULL);
CREATE TABLE ${S}."users" (
  "id" uuid PRIMARY KEY,
  "clerk_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES ${S}."organizations" ("id"),
  "email" text NOT NULL,
  "first_name" text,
  "last_name" text,
  "avatar_url" text,
  "phone_number" text,
  "role" text NOT NULL DEFAULT 'ENGINEER',
  "github_username" text,
  "clerk_updated_at" timestamptz,
  "updated_at" timestamptz NOT NULL,
  UNIQUE ("organization_id", "email"),
  UNIQUE ("clerk_id", "organization_id")
);
${avatarAdoptionDdl(S)}
CREATE TABLE ${S}."custom_fields" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "field_type" ${S}."CustomFieldType" NOT NULL
);
CREATE TABLE ${S}."custom_field_values" (
  "id" uuid PRIMARY KEY,
  "custom_field_id" uuid NOT NULL REFERENCES ${S}."custom_fields" ("id"),
  "organization_id" uuid NOT NULL,
  "people_value_ids" text[] NOT NULL DEFAULT '{}',
  "display_value" text
);
`;

const PERSON_CLERK_ORG = "org_2abcPerson";
const ACME = "0199a000-0000-7000-8000-000000000001";
const OTHER_ORG = "0199a000-0000-7000-8000-000000000002";
const STAND_IN = "0199a000-0000-7000-8000-000000000011";
const TEAMMATE = "0199a000-0000-7000-8000-000000000012";
const OTHER_STAND_IN = "0199a000-0000-7000-8000-000000000013";
const PEOPLE_FIELD = "0199a000-0000-7000-8000-000000000021";
const TEXT_FIELD = "0199a000-0000-7000-8000-000000000022";
const OTHER_PEOPLE_FIELD = "0199a000-0000-7000-8000-000000000023";
const OWNED_BY_BOTH = "0199a000-0000-7000-8000-000000000031";
const OWNED_BY_TEAMMATE = "0199a000-0000-7000-8000-000000000032";
const TEXT_VALUE = "0199a000-0000-7000-8000-000000000033";
const OTHER_ORG_VALUE = "0199a000-0000-7000-8000-000000000034";

const SEEDED_PORTRAIT = "data:image/svg+xml;base64,c2VlZGVk";
const TEAMMATE_PORTRAIT = "data:image/svg+xml;base64,dGVhbW1hdGU=";

const PERSON: PersonProfile = {
  clerkUserId: "user_2abcPerson",
  email: "andy@closedloop.example",
  firstName: "Andy",
  lastName: "Person",
  avatarUrl: "https://img.clerk.example/andy.png",
  phoneNumber: "+15550100",
};

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
  "ISS-12135: handing the seed's signed-in person to the person at finalize",
  () => {
    let database: string;
    const url = () => databaseUrl(database);

    beforeEach(async () => {
      database = `iss12135_${RUN_ID}_${randomUUID().slice(0, 8)}`;
      await withClient(requireUrl(), (client) =>
        client.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
      );
      await withClient(url(), async (client) => {
        await client.query(`CREATE SCHEMA ${S}`);
        await client.query(DDL);
        await client.query(
          `INSERT INTO ${S}."organizations" VALUES ($1, $2, 'Acme Co'), ($3, 'org_someone_else', 'Other')`,
          [ACME, PERSON_CLERK_ORG, OTHER_ORG]
        );
        await client.query(
          `INSERT INTO ${S}."users" (id, clerk_id, organization_id, email, first_name, last_name, avatar_url, phone_number, role, github_username, updated_at) VALUES
             ($1, $4, $5, 'maya.okafor@acmeco.example', 'Maya', 'Okafor', 'https://seed.example/maya.png', '+15550199', 'TECH_LEAD', 'mayaokafor', now()),
             ($2, 'user_vibe_seed_priya_raman', $5, 'priya.raman@acmeco.example', 'Priya', 'Raman', NULL, NULL, 'PM', 'priyaraman', now()),
             ($3, $4, $6, 'maya.okafor@acmeco.example', 'Maya', 'Okafor', NULL, NULL, 'TECH_LEAD', NULL, now())`,
          [
            STAND_IN,
            TEAMMATE,
            OTHER_STAND_IN,
            LOCAL_TRUSTED_USER_ID,
            ACME,
            OTHER_ORG,
          ]
        );
        for (const table of [
          "github_user_connections",
          "external_comment_authors",
        ]) {
          await client.query(
            `INSERT INTO ${S}.${quoteIdentifier(table)} (organization_id, user_id, avatar_url, updated_at) VALUES
               ($1, $3, $6, now()), ($1, $4, $7, now()), ($2, $5, $6, now())`,
            [
              ACME,
              OTHER_ORG,
              STAND_IN,
              TEAMMATE,
              OTHER_STAND_IN,
              SEEDED_PORTRAIT,
              TEAMMATE_PORTRAIT,
            ]
          );
        }
        await client.query(
          `INSERT INTO ${S}."custom_fields" VALUES ($1, $4, $6), ($2, $4, $7), ($3, $5, $6)`,
          [
            PEOPLE_FIELD,
            TEXT_FIELD,
            OTHER_PEOPLE_FIELD,
            ACME,
            OTHER_ORG,
            CustomFieldType.People,
            CustomFieldType.Text,
          ]
        );
        await client.query(
          `INSERT INTO ${S}."custom_field_values" VALUES
             ($1, $5, $8, ARRAY[$9, $10], 'Maya O., Priya R.'),
             ($2, $5, $8, ARRAY[$10], 'Priya R.'),
             ($3, $6, $8, ARRAY[$9], 'Maya Okafor'),
             ($4, $7, $11, ARRAY[$12], 'Maya O.')`,
          [
            OWNED_BY_BOTH,
            OWNED_BY_TEAMMATE,
            TEXT_VALUE,
            OTHER_ORG_VALUE,
            PEOPLE_FIELD,
            TEXT_FIELD,
            OTHER_PEOPLE_FIELD,
            ACME,
            STAND_IN,
            TEAMMATE,
            OTHER_ORG,
            OTHER_STAND_IN,
          ]
        );
      });
    });

    afterEach(async () => {
      await withClient(requireUrl(), (client) =>
        client.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`
        )
      );
    });

    async function usersById() {
      const { rows } = await withClient(url(), (client) =>
        client.query<Record<string, unknown>>(
          `SELECT id, clerk_id, email, first_name, last_name, avatar_url, phone_number, role, github_username FROM ${S}."users"`
        )
      );
      return new Map(rows.map((row) => [row.id, row]));
    }

    async function displayValues() {
      const { rows } = await withClient(url(), (client) =>
        client.query<{ id: string; display_value: string | null }>(
          `SELECT id, display_value FROM ${S}."custom_field_values"`
        )
      );
      return new Map(rows.map((row) => [row.id, row.display_value]));
    }

    it("gives the bound org's signed-in person the person's Clerk identity and profile, replacing the seed's, and keeps the row's id, role and handle", async () => {
      const adopted = await withClient(url(), (client) =>
        adoptSeededPerson(client, SCHEMA, PERSON_CLERK_ORG, PERSON)
      );
      expect(adopted).toEqual({ userId: STAND_IN });

      const users = await usersById();
      expect(users.get(STAND_IN)).toEqual({
        id: STAND_IN,
        clerk_id: PERSON.clerkUserId,
        email: PERSON.email,
        first_name: "Andy",
        last_name: "Person",
        avatar_url: PERSON.avatarUrl,
        phone_number: PERSON.phoneNumber,
        role: "TECH_LEAD",
        github_username: "mayaokafor",
      });
      expect(users.get(TEAMMATE)?.clerk_id).toBe("user_vibe_seed_priya_raman");
      // The same stand-in id in an org not bound to the person stays put.
      expect(users.get(OTHER_STAND_IN)?.clerk_id).toBe(LOCAL_TRUSTED_USER_ID);
    });

    it("re-derives the PEOPLE sort keys naming the adopted row and leaves every other value alone", async () => {
      await withClient(url(), (client) =>
        adoptSeededPerson(client, SCHEMA, PERSON_CLERK_ORG, PERSON)
      );

      const values = await displayValues();
      expect(values.get(OWNED_BY_BOTH)).toBe("Andy P., Priya R.");
      expect(values.get(OWNED_BY_TEAMMATE)).toBe("Priya R.");
      expect(values.get(TEXT_VALUE)).toBe("Maya Okafor");
      expect(values.get(OTHER_ORG_VALUE)).toBe("Maya O.");
    });

    it("gives the adopted row's GitHub connection and comment author the person's photo, and no one else's", async () => {
      await withClient(url(), (client) =>
        adoptSeededPerson(client, SCHEMA, PERSON_CLERK_ORG, PERSON)
      );

      for (const table of [
        "github_user_connections",
        "external_comment_authors",
      ]) {
        const { rows } = await withClient(url(), (client) =>
          client.query<{ user_id: string; avatar_url: string | null }>(
            `SELECT user_id, avatar_url FROM ${S}.${quoteIdentifier(table)}`
          )
        );
        expect(
          new Map(rows.map((row) => [row.user_id, row.avatar_url])),
          table
        ).toEqual(
          new Map([
            [STAND_IN, PERSON.avatarUrl],
            [TEAMMATE, TEAMMATE_PORTRAIT],
            [OTHER_STAND_IN, SEEDED_PORTRAIT],
          ])
        );
      }
    });

    it("refuses, changing nothing, when a seeded teammate already has the person's email", async () => {
      const clash = { ...PERSON, email: "priya.raman@acmeco.example" };

      await expect(
        withClient(url(), (client) =>
          adoptSeededPerson(client, SCHEMA, PERSON_CLERK_ORG, clash)
        )
      ).rejects.toBeInstanceOf(VibeSeedRestoreError);
      expect((await usersById()).get(STAND_IN)?.clerk_id).toBe(
        LOCAL_TRUSTED_USER_ID
      );
    });

    it("refuses when the bound org holds no signed-in person", async () => {
      await withClient(url(), (client) =>
        client.query(`DELETE FROM ${S}."users" WHERE id = $1`, [STAND_IN])
      );

      await expect(
        withClient(url(), (client) =>
          adoptSeededPerson(client, SCHEMA, PERSON_CLERK_ORG, PERSON)
        )
      ).rejects.toThrow("expected one seeded signed-in person");
    });
  }
);
