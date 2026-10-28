import { CustomFieldType } from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import { LOCAL_TRUSTED_USER_ID } from "@repo/auth/auth-mode";
import { quoteIdentifier } from "@repo/database/scripts/db-utils";
import { VibeSeedRestoreError } from "@repo/database/scripts/vibe-environment-restore";
import type pg from "pg";
import { formatPeopleSortKey } from "@/app/custom-fields/display-value";
import { type ClerkUser, clerkService } from "@/lib/auth/clerk-service";

/**
 * ISS-12135 (bug 26, decision 1): the seed's signed-in person, the row keyed
 * by the local-trusted Clerk id, is the person's slot. Finalize hands that row
 * to them, so `findOrCreateUser` finds it on their first request and they
 * inherit its seeded work and team memberships instead of arriving as a new,
 * empty user.
 */

export type PersonProfile = {
  clerkUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  phoneNumber: string | null;
};

type Client = Pick<pg.Client, "query">;

/**
 * The person's Clerk profile, read before the restore's transaction opens so
 * no Clerk round trip runs while it holds its locks.
 */
export async function loadPersonProfile(
  clerkUserId: string,
  getUser: (clerkUserId: string) => Promise<ClerkUser> = (id) =>
    clerkService.getUser(id)
): Promise<PersonProfile> {
  const user = await getUser(clerkUserId);
  return {
    clerkUserId,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.imageUrl,
    phoneNumber: user.phoneNumber,
  };
}

/**
 * Inside the restore's transaction, after the org is bound to `clerkOrgId`:
 * rewrites the signed-in person's row to the person's Clerk identity and
 * profile (the fields `findOrCreateUser` writes for a new user), then
 * re-derives the cached PEOPLE sort keys naming that row, as the product's own
 * rename path does (`refreshPeopleDisplayValuesForUser`). The row keeps its id,
 * role and every relation. Exactly one row must move, or the load rolls back.
 */
export async function adoptSeededPerson(
  client: Client,
  schema: string,
  clerkOrgId: string,
  person: PersonProfile
): Promise<{ userId: string }> {
  const s = quoteIdentifier(schema);
  const taken = await client.query(
    `SELECT 1 FROM ${s}."users" u
     JOIN ${s}."organizations" o ON o.id = u.organization_id
     WHERE o.clerk_id = $1 AND u.email = $2 AND u.clerk_id <> $3`,
    [clerkOrgId, person.email, LOCAL_TRUSTED_USER_ID]
  );
  if ((taken.rowCount ?? 0) > 0) {
    throw new VibeSeedRestoreError(
      "another seeded user already has the person's email, so the signed-in person's row cannot take it"
    );
  }
  const { rows, rowCount } = await client.query<{
    id: string;
    organization_id: string;
  }>(
    `UPDATE ${s}."users" u
     SET clerk_id = $1, email = $2, first_name = $3, last_name = $4,
         avatar_url = $5, phone_number = $6,
         clerk_updated_at = NULL, updated_at = now()
     FROM ${s}."organizations" o
     WHERE o.id = u.organization_id AND o.clerk_id = $7 AND u.clerk_id = $8
     RETURNING u.id, u.organization_id`,
    [
      person.clerkUserId,
      person.email,
      person.firstName,
      person.lastName,
      person.avatarUrl,
      person.phoneNumber,
      clerkOrgId,
      LOCAL_TRUSTED_USER_ID,
    ]
  );
  const adopted = rows[0];
  if (rowCount !== 1 || !adopted) {
    throw new VibeSeedRestoreError(
      `expected one seeded signed-in person to hand to the person, found ${rowCount ?? 0}`
    );
  }
  await adoptGitHubAvatars(
    client,
    s,
    adopted.organization_id,
    adopted.id,
    person
  );
  await refreshPeopleSortKeys(client, s, adopted.organization_id, adopted.id);
  return { userId: adopted.id };
}

async function refreshPeopleSortKeys(
  client: Client,
  s: string,
  organizationId: string,
  userId: string
): Promise<void> {
  const { rows: values } = await client.query<{
    id: string;
    people_value_ids: string[];
    display_value: string | null;
  }>(
    `SELECT v.id, v.people_value_ids, v.display_value
     FROM ${s}."custom_field_values" v
     JOIN ${s}."custom_fields" f ON f.id = v.custom_field_id
     WHERE v.organization_id = $1 AND f.organization_id = $1
       AND f.field_type = $2 AND $3 = ANY (v.people_value_ids)`,
    [organizationId, CustomFieldType.People, userId]
  );
  if (values.length === 0) {
    return;
  }
  const ids = [...new Set(values.flatMap((value) => value.people_value_ids))];
  const { rows: users } = await client.query<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    avatar_url: string | null;
  }>(
    `SELECT id, email, first_name, last_name, avatar_url FROM ${s}."users"
     WHERE organization_id = $1 AND id::text = ANY ($2::text[])`,
    [organizationId, ids]
  );
  const byId = new Map<string, BasicUser>(
    users.map((user) => [
      user.id,
      {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        avatarUrl: user.avatar_url,
      },
    ])
  );
  for (const value of values) {
    const key = formatPeopleSortKey(value.people_value_ids, byId);
    if (key !== value.display_value) {
      await client.query(
        `UPDATE ${s}."custom_field_values" SET display_value = $1 WHERE id = $2`,
        [key, value.id]
      );
    }
  }
}

/**
 * The seed gives the signed-in person's GitHub connection and comment author
 * rows its own portrait; Branches and comments read the picture from those
 * rows, so they take the person's Clerk photo too, beside their name.
 */
async function adoptGitHubAvatars(
  client: Client,
  s: string,
  organizationId: string,
  userId: string,
  person: PersonProfile
): Promise<void> {
  await client.query(
    `UPDATE ${s}."github_user_connections" SET avatar_url = $1, updated_at = now()
     WHERE organization_id = $2 AND user_id = $3`,
    [person.avatarUrl, organizationId, userId]
  );
  await client.query(
    `UPDATE ${s}."external_comment_authors" SET avatar_url = $1, updated_at = now()
     WHERE organization_id = $2 AND user_id = $3`,
    [person.avatarUrl, organizationId, userId]
  );
}
