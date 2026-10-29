import type { BranchPageDetail } from "@repo/api/src/types/branch";
import type { BranchUsageActorBucket } from "@repo/api/src/types/branch-usage";
import type { PrismaClient } from "@repo/database";
import { POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";
import { displayUserName, formatUserFullName } from "@/lib/user-display-name";
import type { SessionUsage, UsageTotals } from "./session-usage-window";

/**
 * Branch owner attribution (FEA-3457 / FEA-3576): which human a branch and each
 * of its sessions is credited to, and the per-owner usage rollup that facets
 * from it. Split out of `branch-read-service.ts`, which consumes these helpers
 * from its list, detail, and usage paths.
 */

/** The Prisma surface this concern reads — only the org-scoped User lookup. */
type BranchOwnerReadClient = Pick<PrismaClient, "user">;

/**
 * Resolve a set of owner `user_id`s to their org display names in ONE query
 * (FEA-3457), so no path issues a per-branch (N+1) User read. STRICTLY org-scoped:
 * `organizationId` is ANDed into the WHERE, so an owner id that belongs to
 * another org (never expected — sessions are org-scoped — but defended anyway)
 * resolves to null (unattributed) rather than leaking a cross-org identity.
 * Display name mirrors the sessions service's `displayUserName` (full name, then
 * a name part, then email) so the same user reads identically on both surfaces.
 */
export async function resolveOwnerNames(
  db: BranchOwnerReadClient,
  organizationId: string,
  userIds: Iterable<string>
): Promise<Map<string, string>> {
  return ownerDisplayNames(
    await readOwnerDirectory(db, organizationId, userIds)
  );
}

/**
 * The `displayUserName` half of an already-read directory: full name, then a
 * name part, then EMAIL. The fallback is why this derivation is not the one
 * `sessionOwnerProfiles` uses.
 */
export function ownerDisplayNames(
  users: readonly OwnerDirectoryUser[]
): Map<string, string> {
  const names = new Map<string, string>();
  for (const user of users) {
    names.set(user.id, displayUserName(user));
  }
  return names;
}

/**
 * FEA-3576 — stamp each `detail.sessions[]` row with its HUMAN owner's display
 * name so the branch PR-activity timeline segments each hour by user spend. The
 * per-session owner ids live on `usage.sessionOwnerById` (session artifact id →
 * the session's assignee, ISS-12251); resolve the DISTINCT ids to names in ONE org-scoped
 * User query (no N+1, and no cross-org identity leak — `resolveOwnerNames` ANDs
 * `organizationId`), then set each matching session's `ownerUserName`. A session
 * with no owner id, or one that does not resolve (unknown / cross-org), keeps its
 * null placeholder and folds into the timeline's shared "unattributed" bucket.
 * Mutates `detail.sessions` in place.
 */
export function attachSessionOwnerNames(
  usage: SessionUsage,
  detail: BranchPageDetail,
  nameById: Map<string, string>
): void {
  for (const session of detail.sessions) {
    const ownerId = usage.sessionOwnerById.get(session.sessionId) ?? null;
    session.ownerUserId = ownerId;
    session.ownerUserName = ownerId ? (nameById.get(ownerId) ?? null) : null;
  }
}

/**
 * The DISTINCT session owner user ids referenced by a set of branches' usage
 * (`sessionOwnerById`), resolved in ONE org-scoped User query for each session's
 * `ownerUserName` and chip profile. Null owner ids (ownerless sessions) are
 * excluded.
 */
export function collectBranchOwnerIds(
  usageByBranch: Map<string, SessionUsage>
): Set<string> {
  const ownerIds = new Set<string>();
  for (const usage of usageByBranch.values()) {
    for (const ownerId of usage.sessionOwnerById.values()) {
      if (ownerId) {
        ownerIds.add(ownerId);
      }
    }
  }
  return ownerIds;
}

/**
 * The per-owner usage rollup (`byActor`, FEA-3457): each DISTINCT session across
 * the corpus contributes its tokens/cost ONCE, grouped by its owner's resolved
 * display name. Owner ids are resolved in ONE org-scoped User query (no N+1);
 * sessions with no owner (or an unresolved / cross-org owner) fold into a single
 * `owner: null` unattributed bucket. Buckets are ordered by cost desc, with the
 * unattributed bucket last, for a stable, useful facet order.
 */
export async function buildBranchByActor(
  db: BranchOwnerReadClient,
  organizationId: string,
  usageByBranch: Map<string, SessionUsage>
): Promise<BranchUsageActorBucket[]> {
  // Fold each distinct session's usage under its owner id (null = unattributed),
  // counting a session once even if several branches (or links) reference it.
  const totalsByOwner = new Map<string | null, UsageTotals>();
  const seen = new Set<string>();
  for (const usage of usageByBranch.values()) {
    for (const session of usage.sessions) {
      if (seen.has(session.sessionId)) {
        continue;
      }
      seen.add(session.sessionId);
      const ownerId = usage.sessionOwnerById.get(session.sessionId) ?? null;
      const bucket = totalsByOwner.get(ownerId) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
      };
      bucket.inputTokens += session.inputTokens;
      bucket.outputTokens += session.outputTokens;
      bucket.cacheReadTokens += session.cacheReadTokens;
      bucket.cacheWriteTokens += session.cacheWriteTokens;
      bucket.estimatedCostUsd += session.estimatedCostUsd ?? 0;
      totalsByOwner.set(ownerId, bucket);
    }
  }
  const ownerIds = [...totalsByOwner.keys()].filter(
    (id): id is string => id !== null
  );
  const nameById = await resolveOwnerNames(db, organizationId, ownerIds);
  // Emit ONE bucket per RESOLVED owner id (never merged by display name, so two
  // distinct users who happen to share a name stay separate and are not
  // double-counted). Only the unattributed rows fold together: a null owner id,
  // OR a non-null id that did not resolve (unknown / cross-org) — those all
  // accumulate into the single `owner: null` bucket so the byActor totals still
  // reconcile with the corpus total.
  const buckets: BranchUsageActorBucket[] = [];
  const unattributed: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
  };
  let hasUnattributed = false;
  for (const [ownerId, totals] of totalsByOwner) {
    const owner = ownerId ? (nameById.get(ownerId) ?? null) : null;
    if (owner === null) {
      hasUnattributed = true;
      unattributed.inputTokens += totals.inputTokens;
      unattributed.outputTokens += totals.outputTokens;
      unattributed.cacheReadTokens += totals.cacheReadTokens;
      unattributed.cacheWriteTokens += totals.cacheWriteTokens;
      unattributed.estimatedCostUsd += totals.estimatedCostUsd;
      continue;
    }
    // Keyed by the resolved owner id (one totals entry per id), so this is one
    // bucket per distinct user — no name-based merge that could collide two ids.
    buckets.push({ owner, ...totals });
  }
  if (hasUnattributed) {
    buckets.push({ owner: null, ...unattributed });
  }
  return buckets.sort((a, b) => {
    // Unattributed bucket sorts last; otherwise by cost desc.
    if (a.owner === null) {
      return 1;
    }
    if (b.owner === null) {
      return -1;
    }
    return b.estimatedCostUsd - a.estimatedCostUsd;
  });
}

/** A Session owner as a chip renders them: the display name, and a picture if any. */
export type OwnerProfile = {
  name: string;
  /** Omitted, never null — absence is how "no picture" reaches the wire. */
  avatarUrl?: string;
};

/**
 * Bind parameters this statement spends on anything OTHER than the id list.
 *
 * The `where` binds `organizationId` and nothing else, so this is headroom for
 * that plus the parameters Prisma adds to a `findMany` no caller can see, with
 * slack so a later added predicate cannot push the statement over the line
 * silently. Same reasoning as `TAG_RELATION_FIXED_BIND_PARAMETERS`.
 */
const OWNER_PROFILE_FIXED_BIND_PARAMETERS = 16;

/**
 * Owner ids per profile statement.
 *
 * Prisma binds ONE parameter per `in` element and REFUSES a built statement at
 * `POSTGRES_MAX_BIND_PARAMETERS`, so a predicate whose width follows the page's
 * session count does not merely run slowly on a large tenant — the statement is
 * rejected and takes the whole list read with it. ISS-8972 widened this read
 * from the page's DOMINANT owners (at most one per branch) to EVERY linked
 * session's owner, which is what put the session count into the statement width;
 * this is the bound that answers for it.
 */
export const OWNER_PROFILE_ID_CHUNK_SIZE =
  POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS - OWNER_PROFILE_FIXED_BIND_PARAMETERS;

/**
 * Resolve a set of owner `user_id`s to their display name and avatar in ONE
 * org-scoped query per chunk.
 *
 * The single owner-identity read for every branch surface: `resolveOwnerNames`
 * is this function with the picture dropped, so the two cannot disagree about
 * who a user is or select different columns for the same answer.
 *
 * STRICTLY org-scoped: `organizationId` is ANDed into the WHERE, so an owner id
 * belonging to another org (never expected — sessions are org-scoped — but
 * defended anyway) resolves to absent rather than leaking a cross-org identity.
 *
 * Chunks are read in SEQUENCE rather than with `Promise.all`: the chunk COUNT
 * follows the page's session count, so awaiting them together would be the
 * unbounded concurrent fan-out `apps/api/AGENTS.md` forbids. Every realistic page
 * is one chunk and therefore one statement.
 */
export async function resolveOwnerProfiles(
  db: BranchOwnerReadClient,
  organizationId: string,
  userIds: Iterable<string>
): Promise<Map<string, OwnerProfile>> {
  const profiles = new Map<string, OwnerProfile>();
  for (const user of await readOwnerDirectory(db, organizationId, userIds)) {
    profiles.set(user.id, {
      name: displayUserName(user),
      // Omit rather than carry a null: absence is the contract's encoding of
      // "no picture", and the chip falls back to initials on absence.
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    });
  }
  return profiles;
}

/** The org-scoped User columns every branch owner derivation reads. */
export type OwnerDirectoryUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
};

/**
 * The org-scoped owner read itself, chunked, with no derivation applied.
 *
 * Separate from `resolveOwnerProfiles` because a caller that needs BOTH the
 * chip profile (name parts only) and the display name (email fallback) must get
 * them from ONE statement; the two derivations disagree for a user with no name
 * parts, so neither can be recovered from the other.
 */
export async function readOwnerDirectory(
  db: BranchOwnerReadClient,
  organizationId: string,
  userIds: Iterable<string>
): Promise<OwnerDirectoryUser[]> {
  const distinct = [...new Set(userIds)];
  const users: OwnerDirectoryUser[] = [];
  for (
    let start = 0;
    start < distinct.length;
    start += OWNER_PROFILE_ID_CHUNK_SIZE
  ) {
    const idChunk = distinct.slice(start, start + OWNER_PROFILE_ID_CHUNK_SIZE);
    const chunk = await db.user.findMany({
      where: { id: { in: idChunk }, organizationId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
      },
    });
    users.push(...chunk);
  }
  return users;
}

/**
 * One user as a Session-owner chip renders them, or null when there is nothing
 * to render them BY.
 *
 * Name parts only — never `displayUserName`, whose email fallback would put a
 * private address on the wire as `ownerName` (whitlockk review, ISS-11738). A user
 * with no first or last name yields null, which leaves the session absent from
 * the profile map and therefore `ownerUnavailable` on the projection: the
 * shipped state for an owner nobody can name.
 */
export function sessionOwnerProfileFromUser(
  user: OwnerDirectoryUser
): OwnerProfile | null {
  const name = formatUserFullName(user);
  if (!name) {
    return null;
  }
  return {
    name,
    // Omitted, never null: absence is the contract's "no picture", and the chip
    // falls back to initials on absence.
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
  };
}

/**
 * The chip-profile half of an already-read directory, shared by the list and
 * detail paths so the same user cannot read one way on one and another on the
 * other (ISS-11738).
 */
export function sessionOwnerProfiles(
  users: readonly OwnerDirectoryUser[]
): Map<string, OwnerProfile> {
  const profiles = new Map<string, OwnerProfile>();
  for (const user of users) {
    const profile = sessionOwnerProfileFromUser(user);
    if (profile) {
      profiles.set(user.id, profile);
    }
  }
  return profiles;
}

/**
 * ISS-8972 — stamp each branch's per-session owner PROFILE onto its usage, so the
 * list projection can name and picture the owner of every linked Session without
 * a second identity read.
 *
 * ISS-11738 — called by the LIST and DETAIL paths both. {@link
 * attachSessionOwnerNames} is the separate stamp for the detail's own
 * `sessions[]` rows (`ownerUserName`), which carries the display-name
 * derivation and its email fallback; this one carries the chip profile, whose
 * name is name parts only.
 *
 * A session with no owner id, an owner that does not resolve (unknown /
 * cross-org), or one with no name to render is simply absent from the map — the
 * projection then reports `ownerUnavailable` rather than fabricating a name.
 * Mutates each usage in place.
 */
export function attachSessionOwnerProfiles(
  usageByBranch: Map<string, SessionUsage>,
  profileByUserId: ReadonlyMap<string, OwnerProfile>
): void {
  for (const usage of usageByBranch.values()) {
    for (const [sessionId, ownerId] of usage.sessionOwnerById) {
      const profile = ownerId ? profileByUserId.get(ownerId) : undefined;
      if (profile) {
        usage.sessionOwnerProfileById.set(sessionId, profile);
      }
    }
  }
}
