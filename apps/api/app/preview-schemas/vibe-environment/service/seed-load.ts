import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { LOCAL_TRUSTED_ORG_ID } from "@repo/auth/auth-mode";
import { headTranscriptObject } from "@repo/aws/transcript-storage";
import { quoteIdentifier } from "@repo/database/scripts/db-utils";
import {
  type VibeEnvironmentMarker,
  VibeEnvironmentMode,
  VibeEnvironmentState,
  vibeEnvironmentKeyPrefix,
} from "@repo/database/scripts/vibe-environment";
import { VibeSeedRestoreError } from "@repo/database/scripts/vibe-environment-restore";
import { log } from "@repo/observability/log";
import type pg from "pg";

/**
 * ISS-12056: the pieces of loading a seeded vibe environment that are not the
 * generic restore: which schemas may receive a seed, binding the seeded org to
 * the person's stage Clerk org, and pointing seeded transcripts at the objects
 * uploaded under the schema's key prefix.
 */

export const AWAITING_SEED = {
  accepts: (marker: VibeEnvironmentMarker | null) =>
    marker?.mode === VibeEnvironmentMode.Seeded &&
    marker.state === VibeEnvironmentState.Pending,
  notAccepted:
    "The schema is not a seeded vibe environment awaiting its seed; ensure it with vibeEnvironment=seeded first",
} as const;

export const SEEDED_READY: VibeEnvironmentMarker = {
  mode: VibeEnvironmentMode.Seeded,
  state: VibeEnvironmentState.Ready,
};

/**
 * The vibe seed runs on a runner with no Clerk identity, so its org carries
 * the local-trusted Clerk id (`ensureSeedIdentity`). Here, inside the
 * restore's transaction, that org is rebound to the person's stage Clerk org
 * and renamed to `name`: their first request resolves the org by `clerk_id`
 * and lands in the seeded org. Only this schema's row is renamed, never the
 * Clerk org, and the slug stays the seed's. Exactly one row must move, or the
 * whole load rolls back.
 */
export async function bindSeededOrganization(
  client: Pick<pg.Client, "query">,
  schema: string,
  clerkOrgId: string,
  name: string
): Promise<void> {
  const { rowCount } = await client.query(
    `UPDATE ${quoteIdentifier(schema)}."organizations" SET clerk_id = $1, name = $3 WHERE clerk_id = $2`,
    [clerkOrgId, LOCAL_TRUSTED_ORG_ID, name]
  );
  if (rowCount !== 1) {
    throw new VibeSeedRestoreError(
      `expected one seeded organization to bind to the person's Clerk org, found ${rowCount ?? 0}`
    );
  }
}

/**
 * The seed uploaded each transcript to the runner's local object store and
 * recorded that store's ETag; the copy under this schema's prefix has its own.
 * The next Desktop append sends the stored ETag as If-Match, so it is replaced
 * with the real one. A transcript whose object never arrived is counted.
 */
export async function reconcileTranscriptEtags(
  client: Pick<pg.Client, "query">,
  schema: string
): Promise<{ reconciled: number; missing: number }> {
  const table = `${quoteIdentifier(schema)}."session_transcript"`;
  const { rows } = await client.query<{ id: string; key: string }>(
    `SELECT id, object_storage_key AS key FROM ${table} WHERE upload_status = $1`,
    [TranscriptUploadStatus.Uploaded]
  );
  const prefix = vibeEnvironmentKeyPrefix(schema);
  let reconciled = 0;
  let missing = 0;
  for (const row of rows) {
    const head = await headTranscriptObject(`${prefix}${row.key}`);
    if (head?.etag === undefined) {
      missing += 1;
      continue;
    }
    await client.query(`UPDATE ${table} SET stored_etag = $1 WHERE id = $2`, [
      head.etag,
      row.id,
    ]);
    reconciled += 1;
  }
  if (missing > 0) {
    log.warn("[vibe-environment] Seeded transcripts without an object", {
      schema,
      missing,
    });
  }
  return { reconciled, missing };
}

/** A transcript key as the seed recorded it: relative, bounded, no traversal. */
export function isAcceptableObjectKey(key: string, maxLength: number): boolean {
  return (
    key.length > 0 &&
    key.length <= maxLength &&
    !key.startsWith("/") &&
    !key.split("/").some((segment) => segment === "" || segment === "..")
  );
}

/**
 * ISS-12135 (A1, Daveth Oakhurst's ruling of 2026-10-07): a seeded org is named
 * after the signed-in person as "<their primary email> Co".
 */
export function seededOrganizationName(personEmail: string): string {
  return `${personEmail} Co`;
}
