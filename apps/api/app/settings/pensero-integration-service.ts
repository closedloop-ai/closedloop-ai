import { withDb } from "@repo/database";
import {
  encryptSecret,
  KmsSecretPurpose,
  secretLastFour,
} from "@/lib/crypto/kms-secret";

/**
 * Per-organization Pensero credential storage (ISS-8007, layer 1).
 *
 * SECURITY CONTRACT, and the reason this service has no `get…Token` method:
 * the stored token embeds an `sk_` secret half, and nothing here returns it.
 * The only shape that leaves this module is {@link PenseroCredentialInfo},
 * which carries presence, a last-four FINGERPRINT, the non-secret base URL, the
 * non-secret team narrowing, and a timestamp. A credential is
 * write-and-replace: to change it you send a new one, never edit a prefilled
 * field.
 *
 * ISS-8761 narrowed that contract rather than keeping it absolute, under an
 * explicit operator decision: the scheduled backfill cannot poll a provider on
 * an org's behalf without that org's token, so a decrypt now exists — in
 * `apps/api/lib/delivery-points/pensero-credential-resolver.ts`, on the
 * CRON_SECRET-authenticated cron path only, and callback-scoped so the
 * plaintext never lands on a returned value. This module, which is what the
 * browser-reachable settings route talks to, still has no such method and
 * still returns no token.
 *
 * Every query is keyed on `organizationId`. There is no unscoped read or write
 * on this table, and the `@unique` constraint on `organization_id` is what lets
 * the write be a single atomic upsert rather than a read-then-write race.
 */

/** What a client is allowed to learn about a stored credential. */
export type PenseroCredentialInfo = {
  isSet: boolean;
  /** Last four characters of the token — a fingerprint, not a usable prefix. */
  lastFour: string | null;
  /** The org's base-URL override, or null when it inherits the deployment default. */
  baseUrl: string | null;
  /**
   * Provider team identifiers the scheduled poll is narrowed to (ISS-8761).
   * Empty means "do not narrow". Not secret, so unlike the token it is read
   * back to the client.
   */
  teamIdentifiers: string[];
  setAt: Date | null;
};

const NOT_CONFIGURED: PenseroCredentialInfo = {
  isSet: false,
  lastFour: null,
  baseUrl: null,
  teamIdentifiers: [],
  setAt: null,
};

export const penseroIntegrationService = {
  /**
   * Create or replace this organization's Pensero credential.
   *
   * `baseUrl` is optional; passing `null`/`undefined` clears any previous
   * override so the org falls back to the deployment default rather than
   * silently keeping a stale host.
   *
   * `teamIdentifiers` does NOT follow that rule: an explicit `[]` clears the
   * narrowing, an OMITTED field preserves whatever is stored. See the comment
   * on the assignment below for why the two optional fields differ.
   */
  async setOrgCredential(
    organizationId: string,
    credential: {
      token: string;
      baseUrl?: string | null;
      teamIdentifiers?: readonly string[];
    }
  ): Promise<PenseroCredentialInfo> {
    const apiTokenEncrypted = await encryptSecret(
      credential.token,
      KmsSecretPurpose.PenseroApiToken
    );
    const apiTokenLastFour = secretLastFour(credential.token);
    const baseUrl = credential.baseUrl ?? null;
    // OMITTED MEANS "LEAVE IT ALONE", and only for this field (codex + whitlockk,
    // #6492). `baseUrl` collapses omitted into null because every client that
    // writes a credential can also SEE and restate the base URL, so an omission
    // there really is a statement. The team list is behind a closed-by-default
    // flag: a client with that control hidden cannot read the stored list, so
    // its omission states nothing — and treating it as "clear" meant an admin
    // rotating a token with the flag off silently widened their org's poll to
    // every Pensero team, with no screen anywhere showing what changed.
    //
    // An explicit `[]` still clears it. The distinction is expressible; it just
    // has to be made by a client that can see what it is changing.
    const teamIdentifiers = credential.teamIdentifiers
      ? [...credential.teamIdentifiers]
      : undefined;
    const setAt = new Date();

    const row = await withDb((db) =>
      db.penseroIntegration.upsert({
        where: { organizationId },
        create: {
          organizationId,
          apiTokenEncrypted,
          apiTokenLastFour,
          baseUrl,
          // On CREATE there is no stored list to preserve, so an omission is
          // the documented default: do not narrow.
          teamIdentifiers: teamIdentifiers ?? [],
          setAt,
        },
        update: {
          apiTokenEncrypted,
          apiTokenLastFour,
          baseUrl,
          // Spread, so an omitted list leaves the column untouched rather than
          // writing `undefined` — which Prisma would treat as "no change" here
          // anyway, but only by accident of this key existing at all.
          ...(teamIdentifiers ? { teamIdentifiers } : {}),
          setAt,
        },
        select: {
          apiTokenLastFour: true,
          baseUrl: true,
          teamIdentifiers: true,
          setAt: true,
        },
      })
    );

    return {
      isSet: true,
      lastFour: row.apiTokenLastFour,
      baseUrl: row.baseUrl,
      teamIdentifiers: row.teamIdentifiers,
      setAt: row.setAt,
    };
  },

  /**
   * Remove this organization's Pensero credential.
   *
   * `deleteMany` rather than `delete` so removing an absent credential is
   * idempotent instead of throwing on a missing row — a double-click on
   * Disconnect is not an error.
   */
  async removeOrgCredential(organizationId: string): Promise<void> {
    await withDb((db) =>
      db.penseroIntegration.deleteMany({ where: { organizationId } })
    );
  },

  /**
   * Read this organization's credential metadata. Never selects the encrypted
   * token: the column is not in the `select`, so there is no decrypted value in
   * this code path to leak by accident.
   */
  async getOrgCredentialInfo(
    organizationId: string
  ): Promise<PenseroCredentialInfo> {
    const row = await withDb((db) =>
      db.penseroIntegration.findUnique({
        where: { organizationId },
        select: {
          apiTokenLastFour: true,
          baseUrl: true,
          teamIdentifiers: true,
          setAt: true,
        },
      })
    );

    if (!row) {
      return NOT_CONFIGURED;
    }

    return {
      isSet: true,
      lastFour: row.apiTokenLastFour,
      baseUrl: row.baseUrl,
      teamIdentifiers: row.teamIdentifiers,
      setAt: row.setAt,
    };
  },
};
