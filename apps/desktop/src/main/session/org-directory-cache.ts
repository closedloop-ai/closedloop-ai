import { createHash } from "node:crypto";
import type { AgentSessionUsageByUser } from "@repo/api/src/types/agent-session";
import type { BasicUser } from "@repo/api/src/types/user";
import { z } from "zod";
import { unwrapApiEnvelope } from "../util/api-response-utils.js";
import { fetchJsonAndParse } from "../util/fetch-json-and-parse.js";
import { displayUserName } from "./user-display-name.js";

/**
 * @file org-directory-cache.ts — canonical owner-identity resolution for the
 * desktop multiplayer surfaces (Sessions + Branches "Owner").
 *
 * The cloud is the source of truth for who is in an org: `GET /users`
 * (`withAnyAuth`, reachable with the desktop's managed `sk_live` key) returns
 * the org's users. The desktop only stores an opaque `user_id` on local session
 * rows, so it resolves that id to a display identity by consulting this cached
 * directory at read time. The snapshot is an in-memory, TTL-refreshed
 * `Map<userId, BasicUser>`.
 *
 * FEA-3457 — durable owner attribution: the snapshot is ALSO persisted to disk
 * (keyed by the signed-in identity) and rehydrated on cold start. Without this,
 * every app launch begins with an empty directory, so the Branches/Sessions
 * "Owner" column reads blank until a live `GET /users` lands (and stays blank
 * for the whole failure-backoff window if the first fetch is offline/failing).
 * Rehydrating the last-known directory makes owners resolve immediately at boot
 * and survive an offline session; a subsequent successful fetch refreshes it.
 * On a genuinely cold cache with no persisted snapshot (first-ever launch) the
 * owner still resolves to `null` (the existing unattributed affordance), never
 * a fabricated identity. Persistence is strictly identity-scoped, so a prior
 * account's directory is never rehydrated for a different account.
 */

/** Resolved snapshot: opaque `user_id` → the org user's display identity. */
export type OrgDirectorySnapshot = ReadonlyMap<string, BasicUser>;

/** Per-session token totals folded into the `byUser` rollup. */
export type OwnerTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

const ORG_DIRECTORY_TTL_MS = 5 * 60 * 1000;
const ORG_DIRECTORY_TIMEOUT_MS = 10_000;
// After a failed/empty fetch the snapshot stays empty, so without a floor the
// next list/usage read would re-await another (up to `ORG_DIRECTORY_TIMEOUT_MS`)
// fetch — stacking that latency onto every list load while offline or when the
// endpoint is failing / the org has zero directory users. Gate cold re-awaits
// behind this short backoff so a failed fetch is retried at most this often;
// owners keep resolving to null (unattributed) in the meantime.
const ORG_DIRECTORY_FAILURE_BACKOFF_MS = 30 * 1000;

// Canonical BasicUser-shape validator — the single source of truth for both the
// live `/users` response parse (below) and the durable-store rehydrate guard
// (see `org-directory-persistence-store.ts`, FEA-3517), so the two paths can
// never disagree about what a well-formed org user is.
export const basicUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

// `GET /users` returns the full `User` rows; we keep only the BasicUser-shaped
// identity fields (passthrough tolerates the extra columns without coupling the
// desktop to the whole User contract).
const orgUserSchema = basicUserSchema.passthrough();

const orgUsersSchema = z.array(orgUserSchema);

export type OrgDirectoryFetchOptions = {
  /** API origin, e.g. `https://api.closedloop.ai`. */
  getApiOrigin: () => string | null | undefined;
  /** Managed `sk_live` key; `/users` accepts it via `withAnyAuth`. */
  getApiKey: () => string | null | undefined;
  /** Test seam. */
  fetchImpl?: typeof fetch;
};

/**
 * Durable snapshot store (FEA-3457). The app wires an electron-store-backed
 * implementation; tests inject an in-memory one. Persistence failures are
 * non-fatal — a missing/corrupt/unwritable store degrades to the pre-persistence
 * behavior (owners resolve to null until a live fetch lands).
 *
 * SECURITY: the `identityKey` that crosses this boundary is a one-way SHA-256
 * fingerprint of `apiOrigin + token` (see {@link persistenceIdentityKeyOf}),
 * NOT the raw `sk_live` credential. The on-disk electron-store file is not
 * `safeStorage`-encrypted, so it must never carry the live key; the fingerprint
 * still scope-checks identity (equality only) without persisting a reusable
 * secret. The raw key stays in memory ({@link cachedIdentityKey}) for live
 * `/users` fetches and account-switch comparisons.
 */
export type OrgDirectoryPersistence = {
  /**
   * Load the persisted `(identityKey, users)` snapshot, or null if none.
   * `identityKey` is the hashed fingerprint, never the raw credential.
   */
  load: () => { identityKey: string; users: BasicUser[] } | null;
  /** Persist the current identity's snapshot (hashed identity key). */
  save: (record: { identityKey: string; users: BasicUser[] }) => void;
  /** Drop the persisted snapshot (identity change / sign-out). */
  clear: () => void;
};

let cachedSnapshot: Map<string, BasicUser> = new Map();
let lastFetchedAtMs = 0;
// Wall-clock of the last *completed* fetch attempt (success OR failure/empty),
// under the current identity. Advanced even when the fetch yields no snapshot so
// the failure-backoff gate below applies to failures too — a failed fetch does
// not re-await on the very next list call.
let lastAttemptedAtMs = 0;
let inFlight: { identityKey: string; promise: Promise<void> } | null = null;
// Identity (org origin + managed key) that produced `cachedSnapshot`. The
// directory is per-account, so a snapshot fetched under one identity must never
// resolve owners for another: when the signed-in identity changes (org switch,
// key rotation) or is missing (sign-out), the cache is invalidated below so we
// never render a prior account's names/emails/avatars on local Sessions.
let cachedIdentityKey: string | null = null;
// Durable store (FEA-3457). Null until the app wires one; tests inject their own.
let persistence: OrgDirectoryPersistence | null = null;
// Whether we have already attempted a rehydrate-from-disk for the current
// process lifetime under the current identity. Rehydration only ever runs while
// the in-memory cache is empty, so this guards a single disk read per identity
// (a re-attempt after invalidation is allowed because clearSnapshot resets it).
let rehydratedForIdentity: string | null = null;

/**
 * Wire the durable snapshot store (FEA-3457). Call once at app startup with an
 * electron-store-backed implementation; passing `null` disables persistence
 * (the pre-FEA-3457 in-memory-only behavior). Resets the per-process rehydrate
 * guard so a freshly-configured store is consulted on the next read.
 */
export function configureOrgDirectoryPersistence(
  store: OrgDirectoryPersistence | null
): void {
  persistence = store;
  rehydratedForIdentity = null;
}

/**
 * Rehydrate the in-memory snapshot from the durable store for `identityKey`,
 * but only while the cache is empty and only once per identity per process.
 * A persisted snapshot for a DIFFERENT identity is ignored (never leaked) — the
 * caller has already cleared a mismatched snapshot. Persistence errors are
 * swallowed: a missing/corrupt store simply leaves the cache empty.
 */
function rehydrateFromPersistence(identityKey: string): void {
  if (
    !persistence ||
    cachedSnapshot.size > 0 ||
    rehydratedForIdentity === identityKey
  ) {
    return;
  }
  rehydratedForIdentity = identityKey;
  let record: { identityKey: string; users: BasicUser[] } | null = null;
  try {
    record = persistence.load();
  } catch {
    return;
  }
  // The persisted record is identity-scoped by the one-way fingerprint (not the
  // raw key), so compare against the fingerprint of the current identity. A
  // record from a different account produces a different digest and is ignored.
  if (
    !record ||
    record.identityKey !== persistenceIdentityKeyOf(identityKey) ||
    !record.users.length
  ) {
    return;
  }
  cachedSnapshot = new Map(record.users.map((user) => [user.id, user]));
  cachedIdentityKey = identityKey;
  // Treat a rehydrated snapshot as immediately usable but due for a refresh:
  // leave `lastFetchedAtMs` at 0 so the next read still kicks a background
  // `GET /users` to reconcile any membership changes since it was persisted.
}

/** Stable key for the account whose directory a snapshot represents. */
function identityKeyOf(options: OrgDirectoryFetchOptions): string | null {
  const apiOrigin = options.getApiOrigin();
  const token = options.getApiKey();
  if (!(apiOrigin && token)) {
    return null;
  }
  return `${apiOrigin}\u0000${token}`;
}

/**
 * Non-secret, one-way fingerprint of an in-memory identity key, used as the
 * ONLY identity material that crosses the {@link OrgDirectoryPersistence}
 * boundary (SECURITY, FEA-3457). The persisted electron-store file is not
 * `safeStorage`-encrypted, so it must never hold the raw `sk_live` token; a
 * SHA-256 hex digest still scope-checks identity by equality (a different
 * account produces a different digest) while being useless as a credential if
 * the file is exfiltrated. Deterministic, so a fingerprint written by one
 * process matches the same account on the next cold start.
 */
function persistenceIdentityKeyOf(identityKey: string): string {
  return createHash("sha256").update(identityKey).digest("hex");
}

/**
 * Drop the snapshot so owners resolve to null (unattributed) again. Also clears
 * the durable store (FEA-3457) and the per-identity rehydrate guard, so an
 * identity change / sign-out never rehydrates the prior account's directory.
 */
function clearSnapshot(): void {
  cachedSnapshot = new Map();
  lastFetchedAtMs = 0;
  lastAttemptedAtMs = 0;
  cachedIdentityKey = null;
  rehydratedForIdentity = null;
  if (persistence) {
    try {
      persistence.clear();
    } catch {
      // Non-fatal: a failed clear cannot leak identities into memory (the
      // in-memory snapshot is already emptied above); the next successful save
      // overwrites the stale on-disk record.
    }
  }
}

/** Current resolved directory. Empty until the first successful fetch. */
export function getOrgDirectorySnapshot(): OrgDirectorySnapshot {
  return cachedSnapshot;
}

/** Reset module state — for tests only. */
export function resetOrgDirectoryCacheForTest(): void {
  // Detach any test-injected store BEFORE clearing so clearSnapshot does not
  // invoke a stale persistence.clear(); then reset in-memory state fully.
  persistence = null;
  clearSnapshot();
  inFlight = null;
  rehydratedForIdentity = null;
}

/**
 * Ensure the directory is reasonably fresh. Awaits the fetch only when the cache
 * is empty (so the first render can resolve owners); otherwise refreshes in the
 * background past the TTL and returns immediately. De-dupes concurrent refreshes.
 * `nowMs` is injectable for deterministic tests.
 *
 * The cache is scoped to the signed-in identity: if credentials are missing, or
 * the identity has changed since the current snapshot was fetched, the stale
 * snapshot is dropped first so we never resolve owners against the wrong account.
 */
export async function ensureOrgDirectory(
  options: OrgDirectoryFetchOptions,
  nowMs: number = Date.now()
): Promise<void> {
  const identityKey = identityKeyOf(options);
  if (!identityKey) {
    // Signed out / no managed key — cannot attribute owners; forget the
    // previous account's directory rather than keep serving it.
    clearSnapshot();
    return;
  }
  if (cachedIdentityKey !== null && cachedIdentityKey !== identityKey) {
    clearSnapshot();
  }
  // FEA-3457: on a cold in-memory cache, rehydrate the last-known directory from
  // disk (identity-scoped) so owners resolve at boot / offline before any live
  // fetch. A rehydrated snapshot is still refreshed in the background below.
  rehydrateFromPersistence(identityKey);
  const isEmpty = cachedSnapshot.size === 0;
  const isStale = nowMs - lastFetchedAtMs >= ORG_DIRECTORY_TTL_MS;
  // A recent *completed* attempt (success or failure/empty) that left the cache
  // empty is honored for a short backoff: within the window we neither await nor
  // kick a fresh fetch, so a failing/offline endpoint (or a zero-user org) cannot
  // stack fetch latency onto every list load. `lastAttemptedAtMs === 0` (never
  // attempted, or freshly invalidated) is not a backoff, so the first cold read
  // still awaits.
  const attemptedRecently =
    lastAttemptedAtMs !== 0 &&
    nowMs - lastAttemptedAtMs < ORG_DIRECTORY_FAILURE_BACKOFF_MS;
  if (!(isEmpty || isStale)) {
    return;
  }
  // Cold cache still inside the failure backoff: do not re-await (or re-issue) a
  // fetch. Owners resolve to null (unattributed) until the backoff elapses.
  // Staleness is undefined with no snapshot — a failed/empty fetch leaves
  // `lastFetchedAtMs` at 0, so at real wall-clock `isStale` is unconditionally
  // true; gating this on `!isStale` (as before) made the backoff dead code in
  // production, so an offline endpoint or a zero-user org re-kicked a `/users`
  // fetch on every list/usage read. Gate purely on a recent completed attempt.
  if (isEmpty && attemptedRecently) {
    return;
  }
  // Only reuse an in-flight refresh if it is fetching the *current* identity; a
  // refresh started under a previous account would otherwise repopulate the
  // snapshot with the wrong org's users.
  const reusable =
    inFlight && inFlight.identityKey === identityKey ? inFlight.promise : null;
  const refresh = reusable ?? startRefresh(options, nowMs, identityKey);
  // Await only a genuinely-cold cache with no recent attempt, so the first render
  // can resolve owners; otherwise refresh in the background and return.
  if (isEmpty && !attemptedRecently) {
    await refresh;
  }
}

function startRefresh(
  options: OrgDirectoryFetchOptions,
  nowMs: number,
  identityKey: string
): Promise<void> {
  const run = (async () => {
    const users = await fetchOrgUsers(options);
    // Only commit if the identity is still current: an account switch during the
    // fetch must not repopulate the snapshot with the previous org's users (nor
    // let a stale attempt's timestamps gate the new account's first read).
    if (identityKeyOf(options) !== identityKey) {
      return;
    }
    // Record the attempt time even on a failed/empty fetch so the failure backoff
    // applies to failures too; a non-empty result additionally refreshes the TTL.
    lastAttemptedAtMs = nowMs;
    if (users && users.length > 0) {
      cachedSnapshot = new Map(users.map((user) => [user.id, user]));
      lastFetchedAtMs = nowMs;
      cachedIdentityKey = identityKey;
      // Persist the fresh directory (FEA-3457) so the next cold start resolves
      // owners immediately. Identity-scoped by a one-way FINGERPRINT (never the
      // raw sk_live key — the on-disk store is unencrypted). Write failures are
      // non-fatal.
      if (persistence) {
        try {
          persistence.save({
            identityKey: persistenceIdentityKeyOf(identityKey),
            users,
          });
        } catch {
          // Swallow: an unwritable store only means the next launch starts cold,
          // not that the current in-memory snapshot is unusable.
        }
      }
    }
  })().finally(() => {
    if (inFlight?.identityKey === identityKey) {
      inFlight = null;
    }
  });
  inFlight = { identityKey, promise: run };
  return run;
}

async function fetchOrgUsers(
  options: OrgDirectoryFetchOptions
): Promise<BasicUser[] | null> {
  const apiOrigin = options.getApiOrigin();
  const token = options.getApiKey();
  if (!(apiOrigin && token)) {
    return null;
  }
  const result = await fetchJsonAndParse("/users", orgUsersSchema, {
    apiOrigin,
    token,
    unwrap: unwrapApiEnvelope,
    sentinel: null,
    headers: { Accept: "application/json" },
    timeoutMs: ORG_DIRECTORY_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
  });
  if (!result) {
    return null;
  }
  return result.map((user) => ({
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
  }));
}

/** Resolve an opaque session/branch `user_id` to its org identity, or null. */
export function resolveOwner(
  userId: string | null | undefined,
  snapshot: OrgDirectorySnapshot
): BasicUser | null {
  if (!userId) {
    return null;
  }
  return snapshot.get(userId) ?? null;
}

/**
 * Best display name for a resolved user: full name, then email. Routed through
 * the desktop-main SSOT (`displayUserName`) so this stays contract-identical to
 * the cloud derivation instead of hand-rolling the collapse (FEA-3606).
 */
export function ownerDisplayName(user: BasicUser): string {
  return displayUserName(user);
}

/**
 * Build the `byUser` usage rollup from per-session `(userId, totals)` pairs and
 * the directory snapshot. Sessions whose `userId` is null or not in the
 * directory are dropped (they carry no attributable owner), mirroring the web
 * aggregate which groups on a resolvable user. Ordered by session count desc for
 * a stable, useful facet order.
 */
export function buildByUserRollup(
  entries: readonly { userId: string | null; totals: OwnerTokenTotals }[],
  snapshot: OrgDirectorySnapshot
): AgentSessionUsageByUser[] {
  const byUser = new Map<string, AgentSessionUsageByUser>();
  for (const { userId, totals } of entries) {
    const user = resolveOwner(userId, snapshot);
    if (!(userId && user)) {
      continue;
    }
    const existing = byUser.get(userId);
    if (existing) {
      existing.sessionCount += 1;
      existing.inputTokens += totals.inputTokens;
      existing.outputTokens += totals.outputTokens;
      existing.cacheReadTokens += totals.cacheReadTokens;
      existing.cacheWriteTokens += totals.cacheWriteTokens;
      existing.estimatedCost += totals.estimatedCost;
    } else {
      byUser.set(userId, {
        userId,
        userName: ownerDisplayName(user),
        userEmail: user.email,
        userAvatarUrl: user.avatarUrl,
        sessionCount: 1,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens,
        estimatedCost: totals.estimatedCost,
      });
    }
  }
  return [...byUser.values()].sort((a, b) => b.sessionCount - a.sessionCount);
}

/**
 * Build the `byUser` rollup from pre-aggregated per-owner session counts (the
 * O(grouped) SQL fast path, which has no per-owner token sums). Resolves each
 * `userId` to identity via the directory and drops the unresolved. Token fields
 * are zero here — the desktop Owner facet uses session counts only; per-owner
 * token sums are surfaced solely on the hydrated path via {@link buildByUserRollup}.
 */
export function buildByUserFromCounts(
  counts: readonly { userId: string | null; sessionCount: number }[],
  snapshot: OrgDirectorySnapshot
): AgentSessionUsageByUser[] {
  const result: AgentSessionUsageByUser[] = [];
  for (const { userId, sessionCount } of counts) {
    const user = resolveOwner(userId, snapshot);
    if (!(userId && user)) {
      continue;
    }
    result.push({
      userId,
      userName: ownerDisplayName(user),
      userEmail: user.email,
      userAvatarUrl: user.avatarUrl,
      sessionCount,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
    });
  }
  return result.sort((a, b) => b.sessionCount - a.sessionCount);
}
