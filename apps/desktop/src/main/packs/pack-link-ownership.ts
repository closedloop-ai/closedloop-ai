/**
 * @file pack-link-ownership.ts
 * @description Which pack owns a child `agent_components` row, and the write that
 * records it.
 *
 * Split out of `component-scanner.ts` (ISS-6905): resolving ownership is a decision
 * over paths with no database in it, and keeping it beside the scanner's scan/upsert/
 * tombstone flow made an already-large file carry two unrelated responsibilities.
 * Every symbol here is pure — the two SQL builders return statement TEXT and touch no
 * connection — so the rule can be reasoned about, and tested, without a store.
 */

import { PLUGIN_CHILD_KINDS_SQL_LIST } from "../database/db-helpers.js";

/** One or more trailing `/` on an otherwise well-formed install path. */
const TRAILING_SEPARATOR_RE = /\/+$/;

/** The two fields the child-claim order is decided on. */
export type PackClaimOrderKey = {
  packId: string;
  installPath: string;
};

/** A child row's identity and current link, for in-memory owner resolution. */
export type ChildOwnershipRow = {
  id: string;
  installPath: string | null;
  packId: string | null;
};

/**
 * One resolved re-link: the row to stamp, and the `install_path` the owner was
 * resolved FROM. Both are bound into the UPDATE — see {@link buildPackLinkClaimSql}
 * for why carrying the path this far is load-bearing rather than redundant.
 */
export type PackLinkClaim = {
  id: string;
  installPath: string;
};

/** An `agent_packs` row, as much of it as ownership reconciliation reads. */
export type PackInstallRow = {
  packId: string;
  installPath: string;
  uninstalledAt: string | null;
};

/**
 * Rows re-linked per statement. A bound on bind-parameter count and on how long one
 * statement holds the single SQLite writer, not a batching optimisation.
 */
export const PACK_LINK_WRITE_CHUNK = 200;

/**
 * Candidate child rows hydrated per read.
 *
 * ISS-6905 review (davetho): the claim pass resolves the winning owner in memory,
 * which needs the child's `install_path` and current `pack_id` — but hydrating EVERY
 * plugin-child row in one statement makes the DB host's heap a function of the local
 * component inventory with no ceiling on it. The candidate read is therefore keyset-
 * paged on `id`, and each page is resolved and written before the next is read, so
 * peak residency is one page regardless of inventory size.
 *
 * `id` is a safe paging key precisely because nothing here writes it: the claim
 * UPDATE touches `pack_id`/`last_seen_at` only, so a row cannot move across the page
 * boundary and be skipped or seen twice. A row INSERTED below the cursor mid-pass is
 * missed by this scan and picked up by the next, which is the same at-least-eventually
 * guarantee the single-statement read had against a concurrent insert.
 */
export const PACK_LINK_READ_PAGE = 500;

/**
 * ISS-6094: strip trailing separators from a pack's stored `install_path` before it is
 * used as a match root.
 *
 * The registry reader accepts whatever non-empty `installPath` the harness wrote, while
 * child rows carry `path.join`-normalized paths that never keep a trailing separator.
 * So a pack stored as `…/plugin/` compared unequal to its own directory and matched
 * none of its children — the pack silently adopted nothing and rolled up zero.
 *
 * A path that is nothing but separators (`/`) is returned unchanged: there is no
 * shorter root to fall back to, and emptying it would match every row.
 */
export function normalizePackRoot(installPath: string): string {
  const trimmed = installPath.replace(TRAILING_SEPARATOR_RE, "");
  return trimmed === "" ? installPath : trimmed;
}

/**
 * ISS-6094: order two packs shallowest-first for the last-writer-wins child claim, so
 * the pack with the MOST SPECIFIC (longest) matching root ends up owning a child that
 * several packs' prefixes match.
 *
 * Length of the normalized root, not segment count: an ancestor's root is always a
 * strict string prefix of a descendant's, so it is always strictly shorter — the two
 * orderings agree wherever ancestry exists, and length needs no splitting. Unrelated
 * equal-length roots cannot both match one child, so their relative order is arbitrary;
 * it is still pinned (root, then packId) because an unstable comparator would let a
 * child's `pack_id` flap between scans and move a plugin's invocations between
 * dashboard refreshes.
 */
export function comparePackClaimSpecificity(
  a: PackClaimOrderKey,
  b: PackClaimOrderKey
): number {
  const rootA = normalizePackRoot(a.installPath);
  const rootB = normalizePackRoot(b.installPath);
  if (rootA.length !== rootB.length) {
    return rootA.length - rootB.length;
  }
  if (rootA !== rootB) {
    return rootA < rootB ? -1 : 1;
  }
  if (a.packId === b.packId) {
    return 0;
  }
  return a.packId < b.packId ? -1 : 1;
}

/**
 * Whether a child sits at a pack's own root or strictly beneath it.
 *
 * ISS-6094's rule, evaluated in memory rather than as `install_path = ? OR install_path
 * LIKE ? ESCAPE '\'`. The LIKE form needed `escapeSqliteLikePattern` because `%` and `_`
 * are ordinary characters in a directory name and metacharacters to LIKE; a string
 * comparison has no metacharacters, so the rule needs no escaping to stay literal.
 *
 * The trailing `/` is what keeps a sibling out: a pack at `…/cache/git` must not claim
 * `…/cache/git-flow`'s children just because one name prefixes the other.
 *
 * This is NOT byte-equivalent to the predicate it replaces, and the difference is
 * deliberate: SQLite's `LIKE` is case-INSENSITIVE for ASCII unless
 * `PRAGMA case_sensitive_like` is set, which this store never sets, so the old
 * strictly-beneath arm matched a case-variant path while the `=` arm beside it did not.
 * Both arms are now case-SENSITIVE. That resolves the two arms disagreeing rather than
 * preserving it: a pack root and its own children are written by the same scan from the
 * same on-disk walk, so they agree on case, and treating `…/Foo` as beneath `…/foo` is
 * not what "inside this directory" means on the case-sensitive paths this compares.
 */
export function isBeneathPackRoot(installPath: string, root: string): boolean {
  return installPath === root || installPath.startsWith(`${root}/`);
}

/**
 * The pack that owns a child: the DEEPEST active root matching it.
 *
 * `claimOrder` is shallowest-first, so taking the LAST match reproduces exactly what
 * the previous per-pack last-writer-wins loop converged on — the same owner, without
 * writing every intermediate claim to get there.
 */
export function resolveChildOwner(
  installPath: string,
  claimOrder: readonly PackClaimOrderKey[]
): string | null {
  let owner: string | null = null;
  for (const pack of claimOrder) {
    if (isBeneathPackRoot(installPath, normalizePackRoot(pack.installPath))) {
      owner = pack.packId;
    }
  }
  return owner;
}

/**
 * Group the children whose `pack_id` must CHANGE by the owner they must move to.
 *
 * ISS-6905: resolving the winner before writing is what keeps the ordering-key advance
 * affordable. A per-pack claim loop asks each pack in turn "is this row mine?", so when
 * two active roots overlap — an ancestor pack and a pack beneath it, which
 * {@link comparePackClaimSpecificity} exists to order — the shallow pack re-claims the
 * row the deep pack owns and the deep pack takes it straight back, every scan. The row
 * lands on the value it started with, so the LINK looks stable, but it was written
 * twice; once a write advances the ordering key those become two sync-lane re-entries
 * per scan, forever, for a row nothing changed about. Comparing against the FINAL owner
 * emits a write only on a genuine change.
 *
 * A child with no `install_path` is skipped rather than treated as matching: the path
 * is the whole ownership signal, and a row without one has no pack to belong to.
 */
export function groupChildrenByNewOwner(
  children: readonly ChildOwnershipRow[],
  claimOrder: readonly PackClaimOrderKey[]
): Map<string, PackLinkClaim[]> {
  const byOwner = new Map<string, PackLinkClaim[]>();
  for (const child of children) {
    if (child.installPath === null) {
      continue;
    }
    const owner = resolveChildOwner(child.installPath, claimOrder);
    if (owner === null || owner === child.packId) {
      continue;
    }
    const claim: PackLinkClaim = {
      id: child.id,
      installPath: child.installPath,
    };
    const claimed = byOwner.get(owner);
    if (claimed === undefined) {
      byOwner.set(owner, [claim]);
    } else {
      claimed.push(claim);
    }
  }
  return byOwner;
}

/**
 * The pack ids whose child links must be RELEASED: every id that has at least one
 * tombstoned install and NO surviving active one, listed once.
 *
 * ISS-6905 review (davetho): `agent_packs` is keyed `(pack_id, harness,
 * install_path)`, so one logical pack id can hold several install rows — `scanGStack`
 * registers `gstack` under BOTH `claude` and `codex`. Treating each tombstoned ROW as
 * a tombstone for the ID released the children of the installs that are still active,
 * and the claim pass immediately re-stamped them. The link therefore looked stable
 * while every scan wrote each child twice; once a write advances the sync ordering key
 * (which is what ISS-6905 does), those two writes become two lane re-entries per scan,
 * forever, for a row nothing changed about. An id with a live install is not released
 * at all — the claim pass owns those rows.
 *
 * Distinct ids, because two tombstoned installs of one id would otherwise run the same
 * release statement twice, the second matching nothing.
 */
export function selectTombstonedPackIdsToClear(
  packs: readonly PackInstallRow[]
): string[] {
  const activePackIds = new Set<string>();
  for (const pack of packs) {
    if (pack.uninstalledAt === null) {
      activePackIds.add(pack.packId);
    }
  }
  const toClear: string[] = [];
  const seen = new Set<string>();
  for (const pack of packs) {
    if (pack.uninstalledAt === null || activePackIds.has(pack.packId)) {
      continue;
    }
    if (seen.has(pack.packId)) {
      continue;
    }
    seen.add(pack.packId);
    toClear.push(pack.packId);
  }
  return toClear;
}

/**
 * One page of candidate child rows, ordered by `id` from `$1` (exclusive) when
 * `hasCursor`, and from the start of the table otherwise.
 *
 * `limit` is interpolated rather than bound because it is a caller-owned integer, and
 * it is floored through {@link PACK_LINK_READ_PAGE}'s clamp at the call site; a
 * non-integer here would be a programming error, not user input.
 */
export function buildChildCandidatePageSql(
  hasCursor: boolean,
  limit: number
): string {
  return `SELECT id,
                 install_path AS "installPath",
                 pack_id AS "packId"
            FROM agent_components
           WHERE component_kind IN (${PLUGIN_CHILD_KINDS_SQL_LIST})
             ${hasCursor ? "AND id > $1" : ""}
           ORDER BY id
           LIMIT ${Math.max(1, Math.floor(limit))}`;
}

/**
 * Claim one chunk of children for `$1`, stamping the ordering key `$2`.
 *
 * Every claim binds BOTH halves of the snapshot the owner was resolved from — its
 * `id` AND the `install_path` that selected that owner — because the resolution runs
 * on a reader connection OUTSIDE the write task, and a row's path is MUTABLE while it
 * sits there: `upsertDefinition` re-`INSERT`s a child under the same deterministic id
 * and sets `install_path = excluded.install_path` on conflict. A predicate that
 * checked only `pack_id != $1` therefore let a child that MOVED between the read and
 * this write be stamped with the pack that owned it at its OLD location, and advance
 * its sync ordering key, shipping the wrong owner to the cloud. That is not
 * self-correcting either: if the row moved out from under every active root, the next
 * scan resolves no owner for it and {@link groupChildrenByNewOwner} skips it, so the
 * wrong link is never revisited.
 *
 * Binding the path makes the UPDATE assert the snapshot instead of trusting it — a row
 * whose path changed simply matches nothing and is re-resolved by the next scan
 * against its current path. That is the whole conflict policy: no retry loop, because
 * losing a stamp defers a correct write while winning one with a stale path records a
 * wrong fact.
 *
 * `component_kind` is re-asserted for the same reason at the same cost. It cannot in
 * fact change for a given id — the id is derived from `(kind, externalId)` and the
 * `ON CONFLICT` key is that same pair — so this arm is the statement stating its own
 * scope rather than a race it closes.
 *
 * The `pack_id IS NULL OR pack_id != $1` guard is what bounds the re-sync cost: it
 * matches only rows whose link actually CHANGES, so a concurrent writer that settled a
 * row in between makes this a no-op for that row instead of re-stamping an ordering
 * key the sync lane would then have to carry again.
 */
export function buildPackLinkClaimSql(claimCount: number): string {
  const matches = Array.from({ length: claimCount }, (_, index) => {
    const idParam = index * 2 + 3;
    return `(id = $${idParam} AND install_path = $${idParam + 1})`;
  }).join(" OR ");
  return `UPDATE agent_components
             SET pack_id = $1,
                 last_seen_at = $2
           WHERE component_kind IN (${PLUGIN_CHILD_KINDS_SQL_LIST})
             AND (${matches})
             AND (pack_id IS NULL OR pack_id != $1)`;
}

/** Flatten claims into the `$3`-onward bind order {@link buildPackLinkClaimSql} numbers. */
export function packLinkClaimParams(
  claims: readonly PackLinkClaim[]
): string[] {
  const params: string[] = [];
  for (const claim of claims) {
    params.push(claim.id, claim.installPath);
  }
  return params;
}
