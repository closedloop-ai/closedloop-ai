/**
 * ISS-12135 (A1), against real Postgres: finalizing a seeded vibe environment
 * names its seeded org after the signed-in person as "<primary email> Co",
 * keeping the seed's slug, and leaves the seeded teammates and every other org
 * alone. Each case runs in its own throwaway database. Skips when DATABASE_URL
 * is unset.
 */

import { randomUUID } from "node:crypto";
import {
  LOCAL_TRUSTED_ORG_ID,
  LOCAL_TRUSTED_USER_ID,
} from "@repo/auth/auth-mode";
import {
  createSslClient,
  quoteIdentifier,
} from "@repo/database/scripts/db-utils";
import {
  formatVibeEnvironmentMarker,
  VibeEnvironmentMode,
  VibeEnvironmentState,
  writeSchemaComment,
} from "@repo/database/scripts/vibe-environment";
import { stageVibeSeedRows } from "@repo/database/scripts/vibe-environment-restore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { avatarAdoptionDdl } from "@/__tests__/support/preview-schemas/avatar-adoption.test-fixtures";
import { VIBE_SEED_ORGANIZATION } from "@/scripts/vibe-seed/core/seed-identity";
import {
  VibeEnvironmentFailureReason,
  VibeEnvironmentOrgChoice,
} from "./constants";
import { finalizeVibeEnvironment } from "./service";

const mocks = vi.hoisted(() => ({
  resolveTarget: vi.fn(),
  resolvePersonClerkIdentity: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("./service/target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service/target")>()),
  resolveTarget: mocks.resolveTarget,
}));

vi.mock("./service/person-identity", () => ({
  resolvePersonClerkIdentity: mocks.resolvePersonClerkIdentity,
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: { getUser: mocks.getUser },
}));

vi.mock("@repo/aws/transcript-storage", () => ({
  headTranscriptObject: vi.fn(),
  presignTranscriptPutObject: vi.fn(),
}));

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);
const SCHEMA = `preview_iss12135_${RUN_ID}`;
const S = quoteIdentifier(SCHEMA);

const DDL = `
CREATE TYPE ${S}."CustomFieldType" AS ENUM ('TEXT', 'PEOPLE');
CREATE TABLE ${S}."organizations" (
  "id" uuid PRIMARY KEY,
  "clerk_id" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "slug" text NOT NULL UNIQUE
);
CREATE TABLE ${S}."users" (
  "id" uuid PRIMARY KEY,
  "clerk_id" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES ${S}."organizations" ("id"),
  "email" text NOT NULL,
  "first_name" text,
  "last_name" text,
  "avatar_url" text,
  "phone_number" text,
  "clerk_updated_at" timestamptz,
  "updated_at" timestamptz NOT NULL,
  UNIQUE ("organization_id", "email"),
  UNIQUE ("clerk_id", "organization_id")
);
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
CREATE TABLE ${S}."session_transcript" (
  "id" uuid PRIMARY KEY,
  "object_storage_key" text NOT NULL,
  "upload_status" text NOT NULL,
  "stored_etag" text
);
${avatarAdoptionDdl(S)}
`;

const BRANCH = "vibe/org-name";
const PERSON_CLERK_ORG = "org_2abcPerson";
const PERSON_CLERK_USER = "user_2abcPerson";
const PERSON_EMAIL = "ottilie@closedloop.example";
const SEEDED_ORG = "0199a000-0000-7000-8000-000000000001";
const OTHER_ORG = "0199a000-0000-7000-8000-000000000002";
const SIGNED_IN = "0199a000-0000-7000-8000-000000000011";
const TEAMMATE = "0199a000-0000-7000-8000-000000000012";

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
  "ISS-12135: finalize names the seeded org after the signed-in person",
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
        await writeSchemaComment(
          client,
          SCHEMA,
          formatVibeEnvironmentMarker({
            mode: VibeEnvironmentMode.Seeded,
            state: VibeEnvironmentState.Pending,
          })
        );
        await stageVibeSeedRows(
          client,
          SCHEMA,
          "organizations",
          JSON.stringify([
            {
              id: SEEDED_ORG,
              clerk_id: LOCAL_TRUSTED_ORG_ID,
              ...VIBE_SEED_ORGANIZATION,
            },
            {
              id: OTHER_ORG,
              clerk_id: "org_someone_else",
              name: "Other",
              slug: "other",
            },
          ])
        );
        await stageVibeSeedRows(
          client,
          SCHEMA,
          "users",
          JSON.stringify([
            {
              id: SIGNED_IN,
              clerk_id: LOCAL_TRUSTED_USER_ID,
              organization_id: SEEDED_ORG,
              email: "jordan.avery@acmeco.example",
              first_name: "Jordan",
              last_name: "Avery",
              updated_at: "2026-10-01T00:00:00Z",
            },
            {
              id: TEAMMATE,
              clerk_id: "user_vibe_seed_priya_raman",
              organization_id: SEEDED_ORG,
              email: "priya.raman@acmeco.example",
              first_name: "Priya",
              last_name: "Raman",
              updated_at: "2026-10-01T00:00:00Z",
            },
          ])
        );
      });
      mocks.resolveTarget.mockResolvedValue({
        ok: true,
        value: { schema: SCHEMA, databaseUrl: url() },
      });
      mocks.resolvePersonClerkIdentity.mockResolvedValue({
        clerkUserId: PERSON_CLERK_USER,
        clerkOrgId: PERSON_CLERK_ORG,
        clerkOrgName: "Ottilie's workspace",
        isOrgAdmin: true,
        chosenBy: VibeEnvironmentOrgChoice.OnlyAdminOrg,
      });
      mocks.getUser.mockResolvedValue({
        id: PERSON_CLERK_USER,
        email: PERSON_EMAIL,
        firstName: "Ottilie",
        lastName: "Person",
        imageUrl: null,
        phoneNumber: null,
      });
    });

    afterEach(async () => {
      vi.clearAllMocks();
      await withClient(requireUrl(), (client) =>
        client.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`
        )
      );
    });

    async function organizations() {
      const { rows } = await withClient(url(), (client) =>
        client.query<{
          id: string;
          clerk_id: string;
          name: string;
          slug: string;
        }>(
          `SELECT id, clerk_id, name, slug FROM ${S}."organizations" ORDER BY id`
        )
      );
      return rows;
    }

    it("renames the seeded org to the person's Clerk primary email plus Co, keeps its slug, and leaves the teammates and every other org alone", async () => {
      const result = await finalizeVibeEnvironment(BRANCH, {
        personEmail: PERSON_EMAIL,
      });

      expect(result).toMatchObject({
        ok: true,
        boundOrg: { clerkOrgId: PERSON_CLERK_ORG, name: "Ottilie's workspace" },
        adoptedPerson: { userId: SIGNED_IN, email: PERSON_EMAIL },
      });
      expect(mocks.getUser).toHaveBeenCalledWith(PERSON_CLERK_USER);
      expect(await organizations()).toEqual([
        {
          id: SEEDED_ORG,
          clerk_id: PERSON_CLERK_ORG,
          name: "ottilie@closedloop.example Co",
          slug: VIBE_SEED_ORGANIZATION.slug,
        },
        {
          id: OTHER_ORG,
          clerk_id: "org_someone_else",
          name: "Other",
          slug: "other",
        },
      ]);
      const { rows: teammates } = await withClient(url(), (client) =>
        client.query(
          `SELECT clerk_id, email, first_name, last_name FROM ${S}."users" WHERE id = $1`,
          [TEAMMATE]
        )
      );
      expect(teammates).toEqual([
        {
          clerk_id: "user_vibe_seed_priya_raman",
          email: "priya.raman@acmeco.example",
          first_name: "Priya",
          last_name: "Raman",
        },
      ]);
    });

    it("names nothing when the load is refused, because the rename rolls back with it", async () => {
      mocks.getUser.mockResolvedValue({
        id: PERSON_CLERK_USER,
        email: "priya.raman@acmeco.example",
        firstName: "Ottilie",
        lastName: "Person",
        imageUrl: null,
        phoneNumber: null,
      });

      const result = await finalizeVibeEnvironment(BRANCH, {
        personEmail: PERSON_EMAIL,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: VibeEnvironmentFailureReason.Refused,
      });
      expect(await organizations()).toEqual([]);
    });
  }
);
