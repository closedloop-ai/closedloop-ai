import { quoteIdentifier } from "@repo/database/scripts/db-utils";
import { VibeSeedRestoreError } from "@repo/database/scripts/vibe-environment-restore";
import type pg from "pg";
import { v7 } from "uuid";
import { DESKTOP_REFRESH_TOKEN_TTL_MS } from "@/app/desktop/session/service";
import { type ClerkUser, clerkService } from "@/lib/auth/clerk-service";
import { ed25519SpkiBase64ToPem } from "@/lib/auth/ed25519-spki-pem";

/**
 * ISS-12056 (decision 5): a Desktop on the person's laptop, signed in to their
 * vibe environment's preview API as THEMSELVES. The laptop prepares the
 * profile and keeps the refresh token and the private key; it sends only the
 * token's SHA-256 (`hashToken`), the Ed25519 public key and the gateway id,
 * none of which can refresh a session on its own (refresh is PoP-signed with
 * the private key). This writes the same DesktopSession and first
 * DesktopRefreshToken `issueDesktopSessionCredentials` writes, in the preview
 * schema only, for the person's own user.
 */

export type DesktopAuthClaim = {
  refreshTokenHash: string;
  publicKeySpki: string;
  gatewayId: string;
};

export type PersonDesktopSession = {
  sessionId: string;
  userId: string;
  /** `false` when this claim already had its session (a repeat dispatch). */
  created: boolean;
};

type Client = Pick<pg.Client, "query">;

export async function mintPersonDesktopSession(
  client: Client,
  schema: string,
  person: { clerkUserId: string; clerkOrgId: string },
  claim: DesktopAuthClaim,
  now: Date,
  getUser: (clerkUserId: string) => Promise<ClerkUser> = (id) =>
    clerkService.getUser(id)
): Promise<PersonDesktopSession> {
  const s = quoteIdentifier(schema);
  const organizationId = await findBoundOrganization(
    client,
    s,
    person.clerkOrgId
  );
  const userId = await ensurePersonUser(
    client,
    s,
    organizationId,
    person.clerkUserId,
    getUser
  );
  const existing = await client.query<{ session_id: string; user_id: string }>(
    `SELECT t.session_id, d.user_id FROM ${s}."desktop_refresh_tokens" t
     JOIN ${s}."desktop_sessions" d ON d.id = t.session_id
     WHERE t.token_hash = $1`,
    [claim.refreshTokenHash]
  );
  const prior = existing.rows[0];
  if (prior) {
    if (prior.user_id !== userId) {
      throw new VibeSeedRestoreError(
        "this Desktop claim already belongs to another user; prepare a fresh Desktop profile"
      );
    }
    return { sessionId: prior.session_id, userId, created: false };
  }
  const boundPublicKey = toPem(claim.publicKeySpki);
  const expiresAt = new Date(now.getTime() + DESKTOP_REFRESH_TOKEN_TTL_MS);
  const sessionId = v7();
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO ${s}."desktop_sessions"
         (id, user_id, organization_id, gateway_id, bound_public_key, metadata, expires_at, last_used_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7, $7)`,
      [
        sessionId,
        userId,
        organizationId,
        claim.gatewayId,
        boundPublicKey,
        expiresAt,
        now,
      ]
    );
    await client.query(
      `INSERT INTO ${s}."desktop_refresh_tokens" (id, session_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [v7(), sessionId, v7(), claim.refreshTokenHash, expiresAt]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      // Keep the insert's own failure.
    });
    throw error;
  }
  return { sessionId, userId, created: true };
}

async function findBoundOrganization(
  client: Client,
  s: string,
  clerkOrgId: string
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM ${s}."organizations" WHERE clerk_id = $1`,
    [clerkOrgId]
  );
  const organization = rows[0];
  if (!organization) {
    throw new VibeSeedRestoreError(
      "no organization in this environment belongs to the person's Clerk org yet; sign in to the environment's app (creating the org in blank mode) and dispatch again"
    );
  }
  return organization.id;
}

/**
 * The person's user in that org: in a seeded environment the seeded row
 * finalize handed them (`adopt-person.ts`, ISS-12135); in a blank one the row
 * `findOrCreateUser` made on their first request, or, when they have not
 * signed in to the web app yet, the same row written from the same Clerk
 * profile.
 */
async function ensurePersonUser(
  client: Client,
  s: string,
  organizationId: string,
  clerkUserId: string,
  getUser: (clerkUserId: string) => Promise<ClerkUser>
): Promise<string> {
  const find = () =>
    client.query<{ id: string }>(
      `SELECT id FROM ${s}."users" WHERE clerk_id = $1 AND organization_id = $2`,
      [clerkUserId, organizationId]
    );
  const found = (await find()).rows[0];
  if (found) {
    return found.id;
  }
  const profile = await getUser(clerkUserId);
  await client.query(
    `INSERT INTO ${s}."users"
       (id, clerk_id, organization_id, email, first_name, last_name, avatar_url, phone_number, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (clerk_id, organization_id) DO NOTHING`,
    [
      v7(),
      clerkUserId,
      organizationId,
      profile.email,
      profile.firstName,
      profile.lastName,
      profile.imageUrl,
      profile.phoneNumber,
    ]
  );
  const created = (await find()).rows[0];
  if (!created) {
    throw new VibeSeedRestoreError("the person's user could not be created");
  }
  return created.id;
}

function toPem(publicKeySpki: string): string {
  try {
    return ed25519SpkiBase64ToPem(publicKeySpki);
  } catch (error) {
    throw new VibeSeedRestoreError(
      `publicKeySpki is not an Ed25519 public key: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * ISS-12135: the Clerk orgs this environment already holds, so a Desktop
 * request without `clerkOrgId` signs in to the org finalize bound even after
 * the person's last active Clerk org has moved on.
 */
export async function listBoundClerkOrgIds(
  client: Client,
  schema: string
): Promise<string[]> {
  const { rows } = await client.query<{ clerk_id: string | null }>(
    `SELECT clerk_id FROM ${quoteIdentifier(schema)}."organizations" WHERE clerk_id IS NOT NULL`
  );
  return rows.flatMap((row) => (row.clerk_id === null ? [] : [row.clerk_id]));
}
