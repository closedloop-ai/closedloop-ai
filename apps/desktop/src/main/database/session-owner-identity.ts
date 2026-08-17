/**
 * @file session-owner-identity.ts
 * @description Single owner of the `sessions.user_id` / `sessions.organization_id`
 * write contract.
 *
 * ISS-6168: the local store has THREE writers that can CREATE a `sessions` row —
 * the live hook (`live-hook.ts` `ensureSession`), the transcript importer
 * (`write-core.ts` `importSession`), and the Codex OTel batch writer
 * (`otel/codex-otel-writer.ts` `minimalCodexSessionUpsert`, which usually wins the
 * race for a live Codex run) — and only the live hook bound the identity columns.
 * Every imported session therefore persisted a NULL owner and the desktop Owner
 * column rendered the unattributed affordance for the whole corpus. All three now
 * build their identity column list, placeholders, and bound values from
 * {@link buildSessionIdentityInsert}, so a future identity column cannot reach one
 * writer and miss the others.
 *
 * Only the CREATE arms bind it. The importer's `if (existing)` merge arm and the
 * OTel `ON CONFLICT DO UPDATE` arm deliberately leave the columns alone: an
 * existing row's owner is whoever created it, and a later write must not rewrite
 * that. Rows created before this fix are repaired by the claim below, not by a
 * merge arm.
 *
 * {@link claimUnownedSessionIdentity} repairs the rows the importer already
 * wrote NULL. It is a boot-time pass, not a migration: the value to stamp is the
 * signed-in identity, which is process state the SQLite migration runner cannot
 * see. It is identity-scoped — a store that already holds another user's
 * sessions is left alone rather than reattributed — and it never invents an
 * identity for a machine that has never signed in.
 *
 * Near-leaf module: `db-helpers`, the Prisma facade type, and the cohort
 * predicate `activity-metrics` owns (the claim re-stamps the derived
 * `session_activity_metrics.closedloop_user` it invalidates). None of those
 * import back into a write path, so both write paths and the boot maintenance
 * chain can depend on it without a cycle.
 */
import { isClosedloopUser } from "./activity-metrics.js";
import { safe } from "./db-helpers.js";
import type { DesktopPrisma } from "./prisma-client.js";

/** The resolved signed-in identity, as the desktop main process reports it. */
export type SessionIdentity = {
  userId: string | null;
  organizationId: string | null;
};

/**
 * Reads the CURRENT signed-in identity. Synchronous and re-read per insert, so a
 * sign-in that lands after the store opened is honored by the next write.
 */
export type SessionIdentityProvider = () => SessionIdentity | null;

/**
 * The identity columns of `sessions`, in bind order. Every INSERT path appends
 * this fragment (and {@link SessionIdentityInsertBinding.values} in the same
 * order) to its own column list, so they cannot drift apart.
 */
export const SESSION_IDENTITY_COLUMNS = "user_id, organization_id";

export type SessionIdentityInsertBinding = {
  /** SQL column-list fragment; always {@link SESSION_IDENTITY_COLUMNS}. */
  columns: string;
  /** Matching `$N, $M` placeholder fragment for the VALUES list. */
  placeholders: string;
  /** Bound values, positionally aligned with `columns`. */
  values: readonly [string | null, string | null];
};

export const SessionOwnerClaimSkip = {
  /** Nobody is signed in; a NULL owner is the honest value, so nothing is stamped. */
  NoIdentity: "no_identity",
  /** The store already holds another account's sessions; claiming would misattribute them. */
  ForeignOwnerPresent: "foreign_owner_present",
} as const;
export type SessionOwnerClaimSkip =
  (typeof SessionOwnerClaimSkip)[keyof typeof SessionOwnerClaimSkip];

export type SessionOwnerClaimResult = {
  claimed: number;
  skipped: SessionOwnerClaimSkip | null;
};

/**
 * Build the identity tail of a `sessions` INSERT.
 *
 * `precedingParamCount` is how many `$N` placeholders the caller's statement
 * already binds; the returned placeholders continue from there, so the caller
 * appends `...binding.values` to its argument list and never hand-counts an
 * index. A throwing or absent provider degrades to a NULL owner rather than
 * failing the insert — losing attribution on one row is recoverable (the boot
 * claim below re-stamps it); losing the session is not.
 */
export function buildSessionIdentityInsert(
  getUserIdentity: SessionIdentityProvider | undefined,
  precedingParamCount: number
): SessionIdentityInsertBinding {
  const identity = safe(() => getUserIdentity?.()) ?? null;
  return {
    columns: SESSION_IDENTITY_COLUMNS,
    placeholders: `$${precedingParamCount + 1}, $${precedingParamCount + 2}`,
    values: [identity?.userId ?? null, identity?.organizationId ?? null],
  };
}

/**
 * Stamp the signed-in identity onto sessions that carry no owner at all.
 *
 * Scoping rule, in one sentence: a store whose sessions are either unowned or
 * already owned by THIS account is this account's store, so the unowned rows are
 * theirs; a store that also holds a different `user_id` OR a different
 * `organization_id` has served more than one account and the unowned rows cannot
 * be attributed from local evidence, so they stay NULL and render the existing
 * unattributed affordance.
 *
 * Known limit, stated rather than papered over: an unowned row carries no
 * evidence of who created it. On a store whose sessions ALL predate owner
 * stamping and that has since changed hands, there is nothing local to
 * distinguish the previous account's rows — the first account to claim gets
 * them. The guard covers every case where the store retained evidence of the
 * other account; it cannot invent evidence that was never written.
 *
 * `updated_at` is deliberately NOT bumped. That column is the local→cloud sync
 * watermark, and the cloud already resolves these sessions' owner from the
 * authenticated principal at ingest (which is why web shows an Owner today);
 * re-queueing the whole corpus would buy nothing and cost a full re-sync. For
 * the same reason this repair needs no `DATA_REVISION` bump — it changes no
 * derived value, only the local attribution column.
 */
export function claimUnownedSessionIdentity(
  prisma: DesktopPrisma,
  identity: SessionIdentity | null
): Promise<SessionOwnerClaimResult> {
  const userId = identity?.userId ?? null;
  if (!userId) {
    return Promise.resolve({
      claimed: 0,
      skipped: SessionOwnerClaimSkip.NoIdentity,
    });
  }
  const organizationId = identity?.organizationId ?? null;
  return prisma.write(async (client) => {
    // Ask the cheap question first. `idx_sessions_unowned` (migration 0057) is
    // partial on exactly UNOWNED_SESSION_PREDICATE, so it holds one entry per
    // unowned session, covers `id` outright, and is EMPTY once a signed-in
    // install has been claimed — which makes every subsequent boot an empty
    // index scan rather than a full scan of a corpus-sized table. Returning here
    // also skips the foreign-owner probe below, which would otherwise walk every
    // owned row to prove a negative.
    const targets = await client.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM sessions WHERE ${UNOWNED_SESSION_PREDICATE}`
    );
    if (targets.length === 0) {
      return { claimed: 0, skipped: null };
    }
    // The account identity is the (user_id, organization_id) PAIR — the same
    // atomic identity `OrgSyncPolicyAccountIdentity` uses — so a differing ORG
    // under the same user is foreign too. Guarding only the user axis would let
    // an org switch silently repaint every historical row with the new org.
    //
    // `IS NOT`, not `<>`: SQL inequality against a NULL bound value yields NULL,
    // never true, so with no organization in hand `organization_id <> $2` matched
    // nothing and an org-stamped-but-userless row sailed past this guard — and
    // the UPDATE then erased the one identity value that row did know (PR #4947
    // review, wongk). `IS NOT` is SQLite's NULL-safe inequality, so the guard now
    // agrees with UNOWNED_SESSION_PREDICATE on exactly which rows are claimable.
    const foreign = await client.$queryRawUnsafe<
      Array<{ foreign_owners: number | bigint }>
    >(
      `SELECT COUNT(*) AS foreign_owners FROM sessions
        WHERE (user_id IS NOT NULL AND user_id IS NOT $1)
           OR (organization_id IS NOT NULL AND organization_id IS NOT $2)`,
      userId,
      organizationId
    );
    if (Number(foreign[0]?.foreign_owners ?? 0) > 0) {
      return { claimed: 0, skipped: SessionOwnerClaimSkip.ForeignOwnerPresent };
    }
    const claimed = await client.$executeRawUnsafe(
      `UPDATE sessions SET user_id = $1, organization_id = $2 WHERE ${UNOWNED_SESSION_PREDICATE}`,
      userId,
      organizationId
    );
    await refreshClaimedActivityMetricsCohort(
      client,
      targets.map((row) => row.id),
      { userId, organizationId }
    );
    return { claimed, skipped: null };
  });
}

/**
 * A session is CLAIMABLE only when it carries NO identity at all. Both the
 * probe, the UPDATE and `idx_sessions_unowned` (migration 0057) are written in
 * terms of this one predicate so they cannot disagree about which rows the claim
 * may touch, and so a row that already knows its organization is never rewritten
 * to a NULL one.
 */
const UNOWNED_SESSION_PREDICATE = "user_id IS NULL AND organization_id IS NULL";

/** Session ids per `session_activity_metrics` re-stamp statement. */
const CLAIM_METRICS_CHUNK = 200;

/** The one write capability the cohort re-stamp needs from the write client. */
type RawWriteExecutor = {
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
};

/**
 * Re-stamp the ClosedLoop-user cohort on the claimed sessions' already-persisted
 * metrics rows.
 *
 * `session_activity_metrics.closedloop_user` is MATERIALIZED from the very
 * identity columns the claim just repaired, and `backfillActivityMetrics` only
 * re-selects rows that are missing or version-stale — a current-version row is
 * never revisited, so without this the repaired sessions would stay classified
 * `external` forever (PR #4947 review, wongk). The flag comes from
 * `isClosedloopUser`, the same predicate `deriveCohorts` uses, so the repair
 * cannot drift from the derivation it is correcting. Only this one cohort column
 * depends on identity; every other field in the row is spend/segment math the
 * claim does not touch, which is why this is a targeted re-stamp rather than a
 * full corpus-sized recompute on the boot path.
 */
async function refreshClaimedActivityMetricsCohort(
  client: RawWriteExecutor,
  sessionIds: readonly string[],
  identity: SessionIdentity
): Promise<void> {
  const closedloopUser = isClosedloopUser(identity) ? 1 : 0;
  for (let i = 0; i < sessionIds.length; i += CLAIM_METRICS_CHUNK) {
    const chunk = sessionIds.slice(i, i + CLAIM_METRICS_CHUNK);
    const placeholders = chunk.map((_, index) => `$${index + 2}`).join(", ");
    await client.$executeRawUnsafe(
      `UPDATE session_activity_metrics SET closedloop_user = $1
        WHERE session_id IN (${placeholders})`,
      closedloopUser,
      ...chunk
    );
  }
}
