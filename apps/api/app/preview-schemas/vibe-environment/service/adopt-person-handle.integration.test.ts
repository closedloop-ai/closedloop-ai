/**
 * ISS-12135 (bug 64), against real Postgres: after finalize hands the seed's
 * signed-in person to the person, the handle, home directory and machines
 * the seed gave that row name no seeded person, and still attribute the
 * row's pull requests, review replies, branches and sessions to it. Each case
 * runs in its own throwaway database. Skips when DATABASE_URL is unset.
 */

import { randomUUID } from "node:crypto";
import {
  rewriteVibeCorpusText,
  VIBE_SEED_MACHINE_NAME,
} from "@repo/api/src/vibe-seed-corpus";
import { LOCAL_TRUSTED_USER_ID } from "@repo/auth/auth-mode";
import {
  createSslClient,
  quoteIdentifier,
} from "@repo/database/scripts/db-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { avatarAdoptionDdl } from "@/__tests__/support/preview-schemas/avatar-adoption.test-fixtures";
import {
  ACME_BASE_SEED,
  ACME_FEATURE_BRANCH,
} from "../../../../scripts/vibe-seed/core/base-seed-github";
import {
  VIBE_SEED_OWNER,
  VIBE_SEED_SIGNED_IN_PERSON,
  VIBE_SEED_TEAMMATES,
} from "../../../../scripts/vibe-seed/core/seed-people";
import { adoptSeededPerson, type PersonProfile } from "./adopt-person";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);
const SCHEMA = `preview_iss12135_handle_${RUN_ID}`;
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
  "github_username" text,
  "clerk_updated_at" timestamptz,
  "updated_at" timestamptz NOT NULL,
  UNIQUE ("organization_id", "email")
);
CREATE TABLE ${S}."custom_fields" ("id" uuid PRIMARY KEY, "organization_id" uuid NOT NULL, "field_type" ${S}."CustomFieldType" NOT NULL);
CREATE TABLE ${S}."custom_field_values" (
  "id" uuid PRIMARY KEY,
  "custom_field_id" uuid NOT NULL REFERENCES ${S}."custom_fields" ("id"),
  "organization_id" uuid NOT NULL,
  "people_value_ids" text[] NOT NULL DEFAULT '{}',
  "display_value" text
);
CREATE TABLE ${S}."pull_request_detail" ("id" uuid PRIMARY KEY, "head_ref_name" text, "author_login" text);
${avatarAdoptionDdl(S)}
CREATE TABLE ${S}."github_pr_reviews" ("id" uuid PRIMARY KEY, "pull_request_id" uuid NOT NULL, "author_login" text NOT NULL);
CREATE TABLE ${S}."compute_targets" ("id" uuid PRIMARY KEY, "user_id" uuid NOT NULL REFERENCES ${S}."users" ("id"), "machine_name" text NOT NULL);
CREATE TABLE ${S}."session_detail" ("id" uuid PRIMARY KEY, "compute_target_id" uuid NOT NULL, "cwd" text);
`;

const PERSON_CLERK_ORG = "org_2abcPerson";
const ACME = "0199a000-0000-7000-8000-000000000001";
const SIGNED_IN = "0199a000-0000-7000-8000-000000000011";
const TEAMMATE = "0199a000-0000-7000-8000-000000000012";
const PULL_REQUEST = "0199a000-0000-7000-8000-000000000021";
const REVIEW = "0199a000-0000-7000-8000-000000000022";
const REPLY = "0199a000-0000-7000-8000-000000000023";
const LAPTOP = "0199a000-0000-7000-8000-000000000031";
const STUDIO = "0199a000-0000-7000-8000-000000000032";
const CORPUS_SESSION = "0199a000-0000-7000-8000-000000000041";
const BASE_SESSION = "0199a000-0000-7000-8000-000000000042";
const REVIEWER = VIBE_SEED_TEAMMATES[0];
/** A corpus session the seed hands to the signed-in person, as it rewrites it. */
const CORPUS_CWD = rewriteVibeCorpusText(
  "/Users/kerensa.whitlock/conductor/workspaces/closedloop-ai/atlanta"
);

const PERSON: PersonProfile = {
  clerkUserId: "user_2abcPerson",
  email: "andy@closedloop.example",
  firstName: "Andy",
  lastName: "Person",
  avatarUrl: null,
  phoneNumber: null,
};

/** Every seeded person's name, lowercased, as a handle or path would carry it. */
const SEEDED_NAMES = [
  VIBE_SEED_SIGNED_IN_PERSON,
  VIBE_SEED_OWNER,
  ...VIBE_SEED_TEAMMATES,
].flatMap((person) => [
  person.firstName.toLowerCase(),
  person.lastName.toLowerCase(),
]);

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
  "ISS-12135: the adopted signed-in person's handle, home and machines",
  () => {
    let database: string;
    const url = () => databaseUrl(database);

    beforeEach(async () => {
      if (REVIEWER === undefined) {
        throw new Error("the seed has no teammate to review");
      }
      database = `iss12135_handle_${RUN_ID}_${randomUUID().slice(0, 8)}`;
      await withClient(requireUrl(), (client) =>
        client.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
      );
      await withClient(url(), async (client) => {
        await client.query(`CREATE SCHEMA ${S}`);
        await client.query(DDL);
        await client.query(
          `INSERT INTO ${S}."organizations" VALUES ($1, $2, 'Acme Co')`,
          [ACME, PERSON_CLERK_ORG]
        );
        await client.query(
          `INSERT INTO ${S}."users" (id, clerk_id, organization_id, email, first_name, last_name, github_username, updated_at) VALUES
             ($1, $3, $5, $6, $7, $8, $9, now()),
             ($2, $4, $5, $10, $11, $12, $13, now())`,
          [
            SIGNED_IN,
            TEAMMATE,
            LOCAL_TRUSTED_USER_ID,
            REVIEWER.clerkId,
            ACME,
            VIBE_SEED_SIGNED_IN_PERSON.email,
            VIBE_SEED_SIGNED_IN_PERSON.firstName,
            VIBE_SEED_SIGNED_IN_PERSON.lastName,
            VIBE_SEED_SIGNED_IN_PERSON.githubUsername,
            REVIEWER.email,
            REVIEWER.firstName,
            REVIEWER.lastName,
            REVIEWER.githubUsername,
          ]
        );
        await client.query(
          `INSERT INTO ${S}."pull_request_detail" VALUES ($1, $2, $3)`,
          [
            PULL_REQUEST,
            ACME_FEATURE_BRANCH,
            VIBE_SEED_SIGNED_IN_PERSON.githubUsername,
          ]
        );
        await client.query(
          `INSERT INTO ${S}."github_pr_reviews" VALUES ($1, $3, $4), ($2, $3, $5)`,
          [
            REVIEW,
            REPLY,
            PULL_REQUEST,
            REVIEWER.githubUsername,
            VIBE_SEED_SIGNED_IN_PERSON.githubUsername,
          ]
        );
        await client.query(
          `INSERT INTO ${S}."compute_targets" VALUES ($1, $3, $4), ($2, $3, $5)`,
          [
            LAPTOP,
            STUDIO,
            SIGNED_IN,
            VIBE_SEED_MACHINE_NAME,
            ACME_BASE_SEED.machine,
          ]
        );
        await client.query(
          `INSERT INTO ${S}."session_detail" VALUES ($1, $3, $4), ($2, $5, $6)`,
          [
            CORPUS_SESSION,
            BASE_SESSION,
            LAPTOP,
            CORPUS_CWD,
            STUDIO,
            ACME_BASE_SEED.cwd,
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

    async function adoptedIdentity() {
      return await withClient(url(), async (client) => {
        const { rows: users } = await client.query<{
          first_name: string;
          github_username: string;
        }>(
          `SELECT first_name, github_username FROM ${S}."users" WHERE clerk_id = $1`,
          [PERSON.clerkUserId]
        );
        const handle = users[0]?.github_username ?? null;
        const pullRequests = await client.query<{
          head_ref_name: string;
        }>(
          `SELECT head_ref_name FROM ${S}."pull_request_detail" WHERE author_login = $1`,
          [handle]
        );
        const replies = await client.query<{ id: string }>(
          `SELECT r.id FROM ${S}."github_pr_reviews" r
           JOIN ${S}."pull_request_detail" p ON p.id = r.pull_request_id
           WHERE r.author_login = $1 AND p.author_login = $1`,
          [handle]
        );
        const sessions = await client.query<{
          cwd: string;
          machine_name: string;
        }>(
          `SELECT s.cwd, c.machine_name FROM ${S}."session_detail" s
           JOIN ${S}."compute_targets" c ON c.id = s.compute_target_id
           JOIN ${S}."users" u ON u.id = c.user_id
           WHERE u.clerk_id = $1 ORDER BY s.id`,
          [PERSON.clerkUserId]
        );
        return {
          person: users[0],
          handle,
          branches: pullRequests.rows.map((row) => row.head_ref_name),
          replies: replies.rows.map((row) => row.id),
          sessions: sessions.rows,
        };
      });
    }

    it("leaves the person a handle, branches, home directory and machines that name no seeded person", async () => {
      await withClient(url(), (client) =>
        adoptSeededPerson(client, SCHEMA, PERSON_CLERK_ORG, PERSON)
      );

      const adopted = await adoptedIdentity();
      expect(adopted.person?.first_name).toBe(PERSON.firstName);
      const handle = adopted.handle ?? "";
      expect(handle).not.toBe("");
      const shown = [
        handle,
        ...adopted.branches,
        ...adopted.sessions.flatMap((session) => [
          session.cwd,
          session.machine_name,
        ]),
      ];
      expect(shown).toHaveLength(6);
      for (const value of shown) {
        for (const name of SEEDED_NAMES) {
          expect(value.toLowerCase(), value).not.toContain(name);
        }
      }
    });

    it("still attributes the seeded pull request, review reply and sessions to the adopted person", async () => {
      await withClient(url(), (client) =>
        adoptSeededPerson(client, SCHEMA, PERSON_CLERK_ORG, PERSON)
      );

      const adopted = await adoptedIdentity();
      expect(adopted.branches).toEqual([ACME_FEATURE_BRANCH]);
      expect(adopted.replies).toEqual([REPLY]);
      expect(adopted.sessions).toEqual([
        {
          cwd: `/Users/${adopted.handle}/conductor/workspaces/acme-web/atlanta`,
          machine_name: VIBE_SEED_MACHINE_NAME,
        },
        { cwd: ACME_BASE_SEED.cwd, machine_name: ACME_BASE_SEED.machine },
      ]);
    });
  }
);
