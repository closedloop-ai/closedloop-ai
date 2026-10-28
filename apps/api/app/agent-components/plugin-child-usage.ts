import "server-only";

import {
  AgentComponentKind,
  PLUGIN_CHILD_KINDS,
} from "@repo/api/src/types/agent-component";
import { normalizeComponentKey } from "@repo/api/src/types/agent-component-analytics";
import type { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { chunksOf } from "@/lib/chunks-of";
import { countPredicateBindParameters } from "@/lib/postgres-bind-parameters";
import {
  INVENTORY_USAGE_ID_CHUNK_SIZE,
  orArmsPerStatement,
} from "./usage-bind-budget";

// ---------------------------------------------------------------------------
// Plugin child-usage rollup + usage-window primitives (extracted from
// service.ts, FEA-4337). Plugin-kind components are never invoked directly, so
// their invocations/sessions are the SUM of their CHILD components' usage. This
// module owns HOW that child usage is loaded and attributed to a plugin's pack —
// the shared read reused by `listForOrg`, the detail view, the ranking
// leaderboard, and the pack-analytics overlay. Kept separate to shrink the
// service.ts and give the rollup contract its own test target.
//
// The usage-window helpers live here too because they are shared verbatim by the
// direct-usage lane in service.ts and the child-usage lane here (SSOT).
// ---------------------------------------------------------------------------

/**
 * Row ceiling for the DETAIL-side usage reads — the ones scoped to a single
 * component identity, which report their own truncation to the caller (see
 * `detail-usage-reads.ts`, whose `truncated` flag is derived from reaching it).
 *
 * ISS-6891: no longer applied to the org-wide plugin child-usage rollup. There it
 * was a terminal cap over a set of pack ids that DEPENDS on the request's facets
 * (the union comes from the faceted population's plugin identities) and was
 * ordered globally across every unioned pack — so a busy pack crowded a quiet
 * one out of the top 20,000, and `?kinds=plugin` rolled a plugin up differently
 * from All. That is the same "a narrower filter returns more" defect the identity
 * cap caused; see `loadChildUsageByPackId`.
 */
export const MAX_ORG_ORPHAN_USAGE_ROWS = 20_000;

/**
 * A usage window: an optional `lastInvokedAt` lower/upper bound. Each bound is
 * absent: no `start` ⇒ unbounded below, no `end` ⇒ unbounded above. When both
 * are absent the window is all-time and no predicate is emitted.
 */
export type UsageWindow = { start?: Date; end?: Date };

/**
 * Build the `lastInvokedAt` where-fragment for a usage window, or `{}` (no
 * predicate) when the window has neither bound. Single source of truth so every
 * usage lane windows identically: `start` → `gte`, `end` → `lte`. FEA-3178
 * adds the upper bound (`end`) so a bounded PRECEDING window can be fetched for
 * the period-over-period delta; the pre-FEA-3178 lower-bound-only behavior is
 * unchanged when `end` is absent.
 */
export function usageWindowWhere(window: UsageWindow): {
  lastInvokedAt?: { gte?: Date; lte?: Date };
} {
  const bound: { gte?: Date; lte?: Date } = {};
  if (window.start) {
    bound.gte = window.start;
  }
  if (window.end) {
    bound.lte = window.end;
  }
  return Object.keys(bound).length > 0 ? { lastInvokedAt: bound } : {};
}

/**
 * The set of pack ids a plugin identity rolls its child usage up over: every
 * pack id folded into the identity plus the plugin's own key (a plugin's own
 * `pack_id` usually equals its `componentKey`). Mirrors the desktop reader's
 * `pluginPackCandidates` in `shared-agent-components-api.ts` so both surfaces
 * derive plugin usage from the identical source.
 */
export function pluginPackCandidates(merged: {
  packIds: Set<string>;
  key: string | null;
}): Set<string> {
  const candidates = new Set<string>(merged.packIds);
  if (merged.key) {
    candidates.add(merged.key);
  }
  return candidates;
}

/**
 * Child-usage aggregate for one pack id: rolled-up invocations + sessions, plus
 * the max child `lastInvokedAt` so a plugin's real last-invocation time reflects
 * its most recently used child (plugins have no own usage rows — FEA-3179).
 */
export type PackUsageBucket = {
  invocations: number;
  errors: number;
  sessionIds: Set<string>;
  lastInvokedAt: Date | null;
};

/**
 * The `${componentKind}::${normalizedComponentKey}` natural identity of one
 * child usage or inventory row — the key the child-usage rollup joins on. Kept
 * identical to the desktop reader's `lower(trim(coalesce(...)))` normalization
 * (FEA-3239) so both surfaces match a child to its pack even when the usage
 * row's key differs from the inventory key only in case/whitespace.
 */
function childIdentityKey(
  componentKind: string,
  componentKey: string | null
): string {
  return `${componentKind}::${normalizeComponentKey(componentKey)}`;
}

/**
 * The child-inventory JOIN side of the plugin child-usage rollup, resolved once
 * per requested pack set:
 *  - `packIdsByIdentity`: child identity (`kind::key`) → the set of requested
 *    pack ids whose inventory carries that child. The orphan-FK fallback join.
 *  - `packIdByComponentId`: inventory row id → its pack id. Lets a usage row that
 *    DOES carry an authoritative `agentComponentId` FK be credited to that exact
 *    inventory row's pack (whitlockk review), instead of the org-global identity
 *    match — which could otherwise credit a compute-target-A usage row to a pack
 *    whose same `kind::key` exists only on compute-target B.
 *  - `identityPrefilter`: the natural-identity half of the usage read's Prisma
 *    `OR`, expressed as `(componentKind, componentKeyNormalized)` equalities.
 *    `loadChildUsageByPackId` pairs it with the stable inventory ids from
 *    `packIdByComponentId`, so a renamed child still admits usage written under
 *    its prior key before authoritative FK attribution runs. Empty normalized
 *    keys are skipped: an inventory child whose key folds to nothing has no
 *    natural identity to ask for, and an equality on `''` would admit every
 *    usage row whose OWN key is blank or whitespace.
 *
 * The predicate matches the SAME identity the JS re-match below keeps: the
 * persisted fold is written by the ISS-6756 BEFORE INSERT/UPDATE trigger from the
 * same `lower(trim(…))` definition `normalizeComponentKey` applies here, so a
 * case/whitespace-variant usage key (`" Reviewer "` for inventory `reviewer`)
 * still lands on `reviewer` and is still admitted (FEA-3239 desktop parity). The
 * former spelling — a case-insensitive `contains` of the normalized key on the
 * RAW column — admitted a superset that the JS re-match then discarded, and
 * `ILIKE` is an operator no btree implements, so it read as an unindexable
 * substring scan of every same-kind row in the table. That is the one lane the
 * ISS-6756 index migration named as still unable to reach
 * `agent_component_session_usage_kind_key_norm_idx`; it reaches it now.
 *
 * BIND CEILING (ISS-8932, #6483 chatgpt-codex-connector). The prefilter is an
 * `OR` arm — 2 bind slots since #6584 folded the arm to a
 * `componentKeyNormalized` equality — per child identity, against the
 * ~32,000-slot {@link INVENTORY_USAGE_ID_CHUNK_SIZE}, so an org past ~16k plugin
 * child identities emitted a statement the driver refuses. Unlike an `IN` list,
 * which Prisma re-splits of its own accord, an `OR` of per-identity arms is not
 * re-split. The bound is applied by the CONSUMER rather than by a cap here,
 * because a cap would decide which children a plugin's total covers: the arms are
 * sliced and the rows de-duplicated on their primary key — see
 * {@link loadChildUsageByPackId}. The prefilter itself stays the complete set.
 */
export type UsageIdentityPredicate = {
  componentKind: string;
  componentKeyNormalized: string;
};

type ChildInventoryJoin = {
  packIdsByIdentity: Map<string, Set<string>>;
  packIdByComponentId: Map<string, string>;
  identityPrefilter: UsageIdentityPredicate[];
};

/**
 * FEA-4337: resolve the child-inventory JOIN for the requested packs (see
 * `ChildInventoryJoin`). A child usage row is attributed to a pack by its
 * authoritative `agentComponentId` FK when present, else by matching its
 * `(componentKind, componentKey)` to a child INVENTORY row's pack id — the FK is
 * nullable (usage can sync before the inventory row exists, or the FK-link lane
 * may not have run). Keying off the FK ALONE silently dropped every orphan-FK
 * child usage row, so plugins whose children were used but whose usage rows were
 * unlinked rolled up to zero — the bug this fixes. Mirrors the desktop reader's
 * natural-key join in `shared-agent-components-api.ts` (`pluginUsageSql`).
 */
async function loadChildInventoryJoin(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  packIds: string[],
  organizationId: string
): Promise<ChildInventoryJoin> {
  const childInventory = await readChildInventory(db, packIds, organizationId);

  const packIdsByIdentity = new Map<string, Set<string>>();
  const packIdByComponentId = new Map<string, string>();
  const prefilterSeen = new Set<string>();
  const identityPrefilter: UsageIdentityPredicate[] = [];
  for (const child of childInventory) {
    if (!(child.packId && child.componentKey)) {
      continue;
    }
    packIdByComponentId.set(child.id, child.packId);
    const identity = childIdentityKey(child.componentKind, child.componentKey);
    let packs = packIdsByIdentity.get(identity);
    if (!packs) {
      packs = new Set<string>();
      packIdsByIdentity.set(identity, packs);
    }
    packs.add(child.packId);
    // Match the persisted fold, not the raw column: a case/whitespace variant
    // usage row is still admitted (FEA-3239) because the trigger folded it the
    // same way. A child whose own key folds to nothing is skipped — it has no
    // identity, and `''` would admit every blank-keyed usage row in the org.
    const normalizedKey = normalizeComponentKey(child.componentKey);
    const prefilterKey = `${child.componentKind}::${normalizedKey}`;
    if (normalizedKey !== "" && !prefilterSeen.has(prefilterKey)) {
      prefilterSeen.add(prefilterKey);
      identityPrefilter.push({
        componentKind: child.componentKind,
        componentKeyNormalized: normalizedKey,
      });
    }
  }
  return { packIdsByIdentity, packIdByComponentId, identityPrefilter };
}

/**
 * ISS-8932: the child-inventory rows for the requested packs, read in slices
 * narrow enough for one statement's bind budget.
 *
 * The `packId: { in: … }` list follows the union of every requested plugin's
 * candidate packs and nothing upstream caps it. Prisma re-splits an over-wide
 * `in` of its own accord, so this list was the milder half of the ceiling — but
 * that is a property of the client, not of the contract, and a lane whose
 * correctness rests on it cannot be checked here. Slicing makes the width this
 * lane's own.
 *
 * SOUND TO CONCATENATE WITH NO DEDUPE: a row carries exactly ONE `packId`, so the
 * slices partition the result and no row can be read twice.
 */
function readChildInventory(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  packIds: string[],
  organizationId: string
) {
  const whereFor = (
    packIdChunk: string[]
  ): Prisma.AgentComponentWhereInput => ({
    organizationId,
    packId: { in: packIdChunk },
    componentKind: { in: [...PLUGIN_CHILD_KINDS] },
    // ISS-6180: roll up only LIVE inventory children, the same
    // `uninstalledAt: null` scope `orgInventoryWhere` applies (see FEA-4086
    // there for why the predicate is required). Scanners tombstone rather than
    // delete and nothing clears the child's `packId`, so without this an
    // uninstalled child's invocations keep rolling into its plugin's total
    // while the SAME usage also surfaces as a standalone orphan row — one
    // invocation counted twice in one response.
    uninstalledAt: null,
    // A key-less inventory child cannot be joined to a usage row
    // (`AgentComponentSessionUsage.componentKey` is non-null), and it would
    // over-match every empty-key usage row — exactly the `component_key IS NOT
    // NULL` guard the desktop join keeps.
    componentKey: { not: null },
  });
  const chunkSize = orArmsPerStatement(
    countPredicateBindParameters(whereFor([])),
    PACK_ID_BIND_WIDTH,
    1
  );
  return readChunked(packIds, chunkSize, (packIdChunk) =>
    db.agentComponent.findMany({
      where: whereFor(packIdChunk),
      select: {
        id: true,
        componentKind: true,
        componentKey: true,
        packId: true,
      },
    })
  );
}

/** One `packId` in an `in` list binds exactly one slot; measured, not restated. */
const PACK_ID_BIND_WIDTH = countPredicateBindParameters("");

/**
 * What one {@link UsageIdentityPredicate} arm costs, measured off a
 * representative arm rather than restated as a number beside it: a hand count of
 * "two binds" goes stale the moment the arm grows a term — #6584 already moved it
 * once, from three — and this is what divides the child-usage read's budget.
 *
 * Divides BOTH consumers' budgets: the list rollup below and the detail lane in
 * {@link loadDetailChildUsageRows}, which is why that read lives in this module
 * rather than at its caller (whitlockk review) — a second hand count beside the
 * detail's own statement is exactly what would drift from this one.
 */
const CHILD_PREFILTER_ARM_BIND_WIDTH = countPredicateBindParameters({
  componentKind: "",
  componentKeyNormalized: "",
} satisfies UsageIdentityPredicate);

/**
 * Run `read` over `items` in slices of `chunkSize` and concatenate. Shared by the
 * two bind-bounded reads in this module so neither restates the loop — including
 * the reason the accumulator appends one at a time: a spread passes every element
 * as its own ARGUMENT and throws `RangeError` past the engine's argument limit.
 */
async function readChunked<TItem, TRow>(
  items: readonly TItem[],
  chunkSize: number,
  read: (chunk: TItem[]) => Promise<TRow[]>
): Promise<TRow[]> {
  const rows: TRow[] = [];
  for (const chunk of chunksOf(items, chunkSize)) {
    const chunkRows = await read(chunk);
    for (const row of chunkRows) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Query the org's child usage rows and group them by pack id via the child
 * INVENTORY join (`loadChildInventoryJoin`), so orphaned (null-FK) child usage
 * still rolls up to its plugin. Scoped to the org's sessions, restricted to the
 * requested packs' child identities, and windowed identically to the
 * direct-usage lane.
 *
 * Each usage row is attributed to EXACTLY ONE pack (see
 * `resolveUsagePackId`) — its authoritative `agentComponentId` FK's pack when
 * present, else one deterministic pack from its identity's matched set. That
 * one-row-one-pack partition is what keeps the list rollup honest: because a
 * plugin's `sumPluginChildUsage` adds the invocation/error totals of every
 * candidate pack bucket, a row folded into two of a plugin's candidate packs
 * would be summed twice (whitlockk review). Cross-pack SESSION overlap still
 * de-dupes correctly because `sumPluginChildUsage` unions the session sets.
 */
export async function loadChildUsageByPackId(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  packIds: string[],
  organizationId: string,
  window: UsageWindow = {}
): Promise<Map<string, PackUsageBucket>> {
  if (packIds.length === 0) {
    return new Map<string, PackUsageBucket>();
  }
  const { packIdsByIdentity, packIdByComponentId, identityPrefilter } =
    await loadChildInventoryJoin(db, packIds, organizationId);
  const fkComponentIds = [...packIdByComponentId.keys()];
  if (fkComponentIds.length === 0 && identityPrefilter.length === 0) {
    return new Map<string, PackUsageBucket>();
  }

  const whereFor = (
    prefilterChunk: Prisma.AgentComponentSessionUsageWhereInput[]
  ): Prisma.AgentComponentSessionUsageWhereInput => ({
    componentKind: { in: [...PLUGIN_CHILD_KINDS] },
    // Prefilter to the requested packs' child identities, so an unrelated busy
    // org can't crowd the requested pack out of the read (whitlockk review). The
    // whole prefilter admits either a stable inventory FK or an equality on the
    // ISS-6756 persisted fold (#6584): the FK arm preserves historical usage
    // after an inventory key rename, the folded identity arm preserves null-FK
    // and case/whitespace compatibility (FEA-3239). Each is bound-chunked into
    // its own statements below, so `prefilterChunk` carries one lane's slice.
    OR: prefilterChunk,
    // ISS-6180 (davetho review): drop rows owned by a TOMBSTONED child while
    // keeping the null-FK natural-key fallback — see
    // `usageWithoutTombstonedInventoryWhere` for why the live-only inventory
    // join above does not cover this on its own. Nested under `AND` rather
    // than spread in, because the prefilter owns the top-level `OR` key
    // and a spread would silently replace it.
    AND: [usageWithoutTombstonedInventoryWhere()],
    session: {
      artifact: {
        organizationId,
      },
    },
    // FEA-3160 / FEA-3178: window a plugin's child usage the same way as
    // direct usage, so a plugin's rolled-up invocations/sessions reflect only
    // in-window child activity (and a plugin with no in-window children zeroes
    // out). Both bounds (start/end) apply.
    ...usageWindowWhere(window),
  });
  const readUsage = (
    prefilterChunk: Prisma.AgentComponentSessionUsageWhereInput[]
  ) =>
    db.agentComponentSessionUsage.findMany({
      where: whereFor(prefilterChunk),
      select: {
        // ISS-8932: the primary key, so the slices can be de-duplicated. It is
        // NOT optional here: the FK lane and the identity lane overlap by
        // construction (a row with a live FK whose folded key ALSO matches one
        // of that pack's identity arms is returned by both), so a plain
        // concatenation would double its invocations.
        id: true,
        agentSessionId: true,
        agentComponentId: true,
        componentKind: true,
        componentKey: true,
        invocationCount: true,
        errorCount: true,
        lastInvokedAt: true,
      },
      // Deterministic order so downstream consumers see a stable row sequence
      // (mirrors the detail read at `orderBy: lastInvokedAt desc` with `id` as
      // a unique tiebreak).
      //
      // ISS-6891: no `take`. This read was capped at MAX_ORG_ORPHAN_USAGE_ROWS,
      // ordered globally across every pack the request unioned — so a busy pack
      // crowded a quiet one out of the retained rows and the quiet plugin
      // under-reported its own invocations and sessions, differently depending
      // on which facet assembled the pack set.
      orderBy: [
        { lastInvokedAt: { sort: "desc", nulls: "last" } },
        { id: "asc" },
      ],
    });
  const otherBindCount = countPredicateBindParameters(whereFor([]));
  // ISS-8932: BOTH halves of the prefilter follow the org's child count and
  // nothing upstream caps it, so each is sliced to the statement's measured
  // remaining budget and the halves are issued as separate statements. Their
  // union is the single `OR` #6584 wrote — a row satisfies the combined
  // predicate iff it satisfies one of the lanes — and every other term of the
  // statement is identical, so nothing is admitted or dropped by the split. A
  // `take` here instead would decide which children a plugin's total covers,
  // which is the facet-dependent truncation ISS-6891 removed.
  const fkRows = await readChunked(
    fkComponentIds,
    orArmsPerStatement(otherBindCount, PACK_ID_BIND_WIDTH, 1),
    (idChunk) => readUsage([{ agentComponentId: { in: idChunk } }])
  );
  const identityRows = await readChunked(
    identityPrefilter,
    orArmsPerStatement(otherBindCount, CHILD_PREFILTER_ARM_BIND_WIDTH, 1),
    (prefilterChunk) => readUsage(prefilterChunk)
  );
  const childUsage = new Map(
    [...fkRows, ...identityRows].map((row) => [row.id, row])
  );
  warnOnOversizeChildUsage(childUsage.size, organizationId);

  const byPack = new Map<string, PackUsageBucket>();
  for (const usage of childUsage.values()) {
    const packId = resolveUsagePackId(
      usage,
      packIdsByIdentity,
      packIdByComponentId
    );
    if (packId) {
      foldChildUsageIntoPackBucket(byPack, packId, usage);
    }
  }
  return byPack;
}

/**
 * Attribute one child usage row to exactly one pack. Precedence:
 *  1. its authoritative `agentComponentId` FK's pack, when the FK resolves to a
 *     requested pack's inventory row — the exact pack the writer linked, scoped
 *     to that inventory row's compute target (whitlockk review).
 *  2. otherwise (orphan FK, or FK to a non-requested pack) one deterministic
 *     pack from the row's normalized identity match. A deterministic pick — not
 *     a fold into every candidate pack — so the list rollup's per-pack sum can't
 *     double-count one row across a plugin's candidate packs.
 * Returns null when the row matches no requested pack. Kept as the honest answer
 * for a row whose SQL-folded key admitted it but whose JS fold resolves to a
 * different identity — the residual the ISS-6756 migration records between
 * `lower()` and `toLowerCase()` — rather than crediting it to a pack it does not
 * belong to.
 */
function resolveUsagePackId(
  usage: {
    agentComponentId: string | null;
    componentKind: string;
    componentKey: string | null;
  },
  packIdsByIdentity: Map<string, Set<string>>,
  packIdByComponentId: Map<string, string>
): string | null {
  if (usage.agentComponentId) {
    const fkPackId = packIdByComponentId.get(usage.agentComponentId);
    if (fkPackId) {
      return fkPackId;
    }
  }
  const identity = childIdentityKey(usage.componentKind, usage.componentKey);
  const packs = packIdsByIdentity.get(identity);
  if (!packs) {
    return null;
  }
  return pickDeterministicPackId(packs);
}

/**
 * Deterministically pick one pack id from a child's matched set so a child that
 * appears under several packs is attributed to a stable one (lexicographic
 * min) — request-to-request stable, and never spreading one usage row across
 * multiple candidate-pack buckets.
 */
function pickDeterministicPackId(packs: Set<string>): string | null {
  let picked: string | null = null;
  for (const packId of packs) {
    if (picked === null || packId < picked) {
      picked = packId;
    }
  }
  return picked;
}

/** Accumulate one child usage row into its pack's rolled-up bucket. */
function foldChildUsageIntoPackBucket(
  byPack: Map<string, PackUsageBucket>,
  packId: string,
  usage: {
    agentSessionId: string;
    invocationCount: number;
    errorCount: number;
    lastInvokedAt: Date | null;
  }
): void {
  let bucket = byPack.get(packId);
  if (!bucket) {
    bucket = {
      invocations: 0,
      errors: 0,
      sessionIds: new Set(),
      lastInvokedAt: null,
    };
    byPack.set(packId, bucket);
  }
  bucket.invocations += usage.invocationCount;
  bucket.errors += usage.errorCount;
  bucket.sessionIds.add(usage.agentSessionId);
  if (
    usage.lastInvokedAt &&
    (!bucket.lastInvokedAt || usage.lastInvokedAt > bucket.lastInvokedAt)
  ) {
    bucket.lastInvokedAt = usage.lastInvokedAt;
  }
}

/**
 * FEA-4337: whether an identity `(kind, key)` maps to at least one of the given
 * candidate packs. Used by the plugin DETAIL rollup, whose per-session map is a
 * plain sum (not per-pack), so it counts a child's usage once regardless of how
 * many of the plugin's candidate packs carry that child.
 */
export function buildChildIdentityPackLookup(
  packIdsByIdentity: Map<string, Set<string>>
): (componentKind: string, componentKey: string | null) => boolean {
  return (componentKind, componentKey) =>
    packIdsByIdentity.has(childIdentityKey(componentKind, componentKey));
}

/**
 * The DETAIL-side child-identity lookup: the normalized `packIdsByIdentity`
 * membership map (fed to `buildChildIdentityPackLookup`) PLUS the SQL
 * `identityPrefilter`, so the detail's usage read can restrict to just this
 * plugin's children before its own row ceiling — the same starvation fix as the
 * list rollup (whitlockk review). The detail path attributes each row at most once (a
 * boolean `belongsToPlugin`), so it needs no per-row pack partition, only the
 * prefilter.
 */
export type DetailChildIdentityLookup = {
  packIdsByIdentity: Map<string, Set<string>>;
  identityPrefilter: UsageIdentityPredicate[];
};

/**
 * FEA-4337: the detail-side child-identity lookup (`DetailChildIdentityLookup`).
 * Wraps `loadChildInventoryJoin` for callers that build a per-session map rather
 * than per-pack buckets and so cannot reuse `loadChildUsageByPackId` directly.
 */
export async function loadDetailChildIdentityLookup(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  packIds: string[],
  organizationId: string
): Promise<DetailChildIdentityLookup> {
  if (packIds.length === 0) {
    return {
      packIdsByIdentity: new Map<string, Set<string>>(),
      identityPrefilter: [],
    };
  }
  const { packIdsByIdentity, identityPrefilter } = await loadChildInventoryJoin(
    db,
    packIds,
    organizationId
  );
  return { packIdsByIdentity, identityPrefilter };
}

/**
 * The child-usage rollup for one plugin identity, summed over its candidate pack
 * ids: total invocations + errors, the union of distinct child sessions, and the
 * max child `lastInvokedAt`. A superset of what any single caller assigns — the
 * list view surfaces sessions/lastInvokedAt, the ranking leaderboard surfaces
 * sessions/errorRate — so each call site picks the fields its merged-entry type
 * carries.
 */
export type PluginChildUsageRollup = {
  invocations: number;
  errors: number;
  sessionIds: Set<string>;
  lastInvokedAt: Date | null;
};

/**
 * Sum a plugin's child usage across its candidate pack ids: invocations and
 * errors accumulate, sessions union (a session touching multiple child packs is
 * counted once), and `lastInvokedAt` takes the max. Single source of truth for
 * the per-pack summation shared by both `listForOrg`'s `applyPackRollupToPlugin`
 * and the ranking service's `applyPluginChildUsageRollup`, so the two surfaces
 * roll plugins up identically (including error accounting) rather than drifting
 * across two hand-maintained copies of the same loop.
 */
export function sumPluginChildUsage(
  candidatePackIds: Iterable<string>,
  byPack: Map<string, PackUsageBucket>
): PluginChildUsageRollup {
  let invocations = 0;
  let errors = 0;
  const sessionIds = new Set<string>();
  let lastInvokedAt: Date | null = null;
  for (const packId of candidatePackIds) {
    const bucket = byPack.get(packId);
    if (!bucket) {
      continue;
    }
    invocations += bucket.invocations;
    errors += bucket.errors;
    for (const sid of bucket.sessionIds) {
      sessionIds.add(sid);
    }
    if (
      bucket.lastInvokedAt &&
      (!lastInvokedAt || bucket.lastInvokedAt > lastInvokedAt)
    ) {
      lastInvokedAt = bucket.lastInvokedAt;
    }
  }
  return { invocations, errors, sessionIds, lastInvokedAt };
}

/**
 * Union every plugin identity's candidate pack ids and load the org's child
 * usage grouped by pack id in one query — the shared first half of the plugin
 * child-usage rollup used by both `listForOrg` and the ranking service. With no
 * pack association there is nothing to roll up: returns an empty map and every
 * plugin correctly zeroes out (plugin-own usage is never a real signal).
 */
export async function loadPluginChildUsage(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  plugins: Array<{ packIds: Set<string>; key: string | null }>,
  organizationId: string,
  window: UsageWindow = {}
): Promise<Map<string, PackUsageBucket>> {
  const allPackIds = new Set<string>();
  for (const plugin of plugins) {
    for (const packId of pluginPackCandidates(plugin)) {
      allPackIds.add(packId);
    }
  }

  return allPackIds.size === 0
    ? new Map<string, PackUsageBucket>()
    : await loadChildUsageByPackId(db, [...allPackIds], organizationId, window);
}

/**
 * ISS-5534 (whitlockk review on #4902): the additive `packIds` half of one emitted
 * list row — the parent-pack identity a consumer needs to tell a plugin's
 * rolled-up total apart from the specific child rows it was rolled up FROM.
 *
 * A `plugin` emits the SAME candidate set its rollup summed over
 * ({@link pluginPackCandidates}), so the two can never disagree about what the
 * number covers; every other kind emits the packs the row itself belongs to.
 * Sorted so the wire shape is request-to-request stable, and OMITTED rather than
 * emitted as `[]`/`null` when there is nothing to say, per the repo's skew rule
 * for optional cross-boundary fields.
 *
 * See `AgentComponent.packIds` for how a reader must interpret absence: on a
 * plugin row it means the producer predates the field, on any other kind it
 * means the component belongs to no pack.
 */
export function emitPackIdentity(merged: {
  kind: string;
  key: string | null;
  packIds: Set<string>;
}): { packIds?: string[] } {
  const ids =
    merged.kind === AgentComponentKind.Plugin
      ? pluginPackCandidates(merged)
      : merged.packIds;
  const sorted = [...ids].sort();
  return sorted.length > 0 ? { packIds: sorted } : {};
}

/**
 * ISS-6180 (whitlockk review): "no LIVE inventory row owns this usage" — the
 * usage-only lane's admission test, shared verbatim by the list's
 * `loadOrphanUsageRows` and the detail's `fetchDetailOrphanUsage`.
 *
 * A null FK is the original orphan case: usage synced before its inventory row
 * existed, or the component-sync lane never linked it. A FK still pointing at a
 * TOMBSTONED row is the second, and it only became reachable once the child-usage
 * rollup above scoped itself to live children — every FK-keyed lane is bounded by
 * the ids of an `uninstalledAt: null` inventory read, so such a row belonged to NO
 * lane and its invocations vanished from every surface instead of surfacing once.
 *
 * Both lanes apply it or they disagree about the same component again (ISS-5363):
 * the list would fold a tombstoned child's usage into a synthetic row while its
 * detail page reported a hard zero. It stays DISJOINT from every FK lane, which
 * partitions on exactly the complement — an FK that resolves to a live row.
 */
export function usageWithoutLiveInventoryWhere(): Prisma.AgentComponentSessionUsageWhereInput {
  return {
    OR: [
      { agentComponentId: null },
      { agentComponent: { uninstalledAt: { not: null } } },
    ],
  };
}

/**
 * ISS-6180 (davetho review on #5039): the CHILD-USAGE lane's admission test —
 * "this row is not owned by a TOMBSTONED inventory row". A null FK is admitted,
 * because the natural-key fallback ({@link resolveUsagePackId}) exists precisely
 * to roll an unlinked child's usage up to its plugin; a FK resolving to a LIVE
 * row is admitted as the ordinary case; a FK resolving to a tombstoned row is
 * REJECTED.
 *
 * Scoping `loadChildInventoryJoin` to live children was NOT enough on its own.
 * When a live child and a tombstoned child share one `(kind, key)`, the live row
 * still contributes that identity to `packIdsByIdentity` and to the SQL
 * `identityPrefilter`, so the dead row's usage is admitted by the prefilter, its
 * FK misses the live-only `packIdByComponentId`, and `resolveUsagePackId` falls
 * back to the LIVE sibling's identity — rolling the tombstoned child's
 * invocations into the plugin while {@link usageWithoutLiveInventoryWhere} also
 * emits them as usage-only. One invocation, two places, which is the exact
 * double-count ISS-6180 set out to remove.
 *
 * NOT the complement of {@link usageWithoutLiveInventoryWhere}: the two overlap
 * on a null FK by design. The usage-only lane is a PARTITION member; this is an
 * OVERLAY (a plugin's total is the sum of its children), so a null-FK child row
 * legitimately both rolls up to its plugin and is recovered onto the child's own
 * identity row. Only the tombstoned-FK arm is disjoint, and that is the arm that
 * has to be.
 */
export function usageWithoutTombstonedInventoryWhere(): Prisma.AgentComponentSessionUsageWhereInput {
  return {
    OR: [
      { agentComponentId: null },
      { agentComponent: { uninstalledAt: null } },
    ],
  };
}

/**
 * Report a plugin child-usage read whose result crossed
 * {@link OVERSIZE_CHILD_USAGE_ROWS}.
 *
 * ISS-6891 removed this lane's row cap because the cap was facet-dependent and
 * terminal. Removing a bound without replacing the visibility it carried is how a
 * pathological org becomes a silent timeout, so the signal is kept and the
 * truncation is not — this never changes what the read returns.
 */
function warnOnOversizeChildUsage(
  rowCount: number,
  organizationId: string
): void {
  if (rowCount < OVERSIZE_CHILD_USAGE_ROWS) {
    return;
  }
  log.error("agent_components_child_usage_oversize", {
    organizationId,
    rowCount,
    threshold: OVERSIZE_CHILD_USAGE_ROWS,
  });
}

/**
 * Informational threshold above which a plugin child-usage read is worth an
 * operator's attention. Sized at the former cap, so the org sizes that used to be
 * silently truncated are exactly the ones that now get reported.
 */
const OVERSIZE_CHILD_USAGE_ROWS = MAX_ORG_ORPHAN_USAGE_ROWS;

/**
 * ISS-8932 (whitlockk review on #6611): one plugin DETAIL page's child-usage rows,
 * read in slices narrow enough for one statement's bind budget.
 *
 * The list rollup was bounded first and this lane was not, which left the SAME
 * over-wide `OR` reachable from a single plugin's detail page:
 * {@link loadDetailChildIdentityLookup} returns the complete prefilter, whose arm
 * count follows the plugin's candidate packs' child count, and nothing upstream
 * caps it. The read therefore lives here beside the prefilter and the measured
 * arm width, not at the caller, so a bound cannot be added to one statement and
 * forgotten on the other.
 *
 * RESULT-PRESERVING against the single statement it replaces, cap included:
 *  - The arms PARTITION the rows. A usage row carries exactly ONE
 *    `componentKeyNormalized`, and `loadChildInventoryJoin` emits distinct
 *    `(kind, key)` equalities, so no row satisfies two arms and no slice can
 *    return a row another slice already did. That is why nothing here
 *    de-duplicates, unlike the list rollup, whose FK lane genuinely overlaps.
 *  - The cap is RE-APPLIED over the merged rows, because a per-slice `take`
 *    alone keeps up to `slices × cap`. Re-ranking loses nothing: every row of
 *    the true top-N is inside its own slice's top-N (the rows outranking it
 *    globally include every row outranking it within that slice), so the merged
 *    set is a superset of what one statement would have returned and the slice
 *    below cuts it back to exactly that.
 */
export async function loadDetailChildUsageRows(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  identityPrefilter: UsageIdentityPredicate[],
  organizationId: string
): Promise<DetailChildUsageLanes> {
  const rows: DetailChildUsageRow[] = [];
  let truncated = false;
  for (const where of detailChildUsageStatementWheres(
    identityPrefilter,
    organizationId
  )) {
    const sliceRows = await db.agentComponentSessionUsage.findMany({
      where,
      select: {
        // `id` and `lastInvokedAt` are the `orderBy` key, carried so the
        // merged slices can be re-ranked into the order and the cap one
        // statement would have produced.
        id: true,
        lastInvokedAt: true,
        agentSessionId: true,
        componentKind: true,
        componentKey: true,
        invocationCount: true,
      },
      // Deterministic tail so the cap drops a stable, most-recent-kept subset
      // rather than an arbitrary one that varies request-to-request (whitlockk
      // review).
      orderBy: [
        { lastInvokedAt: { sort: "desc", nulls: "last" } },
        { id: "asc" },
      ],
      take: MAX_ORG_ORPHAN_USAGE_ROWS,
    });
    // ISS-9852: reported beside the `take` it is paired with, the same test
    // `fetchDetailOrphanUsageLanes` makes — a slice with no dedupe between the
    // bound and its rows, so `length === take` exactly means the bound bit.
    truncated ||= sliceRows.length >= MAX_ORG_ORPHAN_USAGE_ROWS;
    // Appended one at a time: a spread passes every element as its own
    // ARGUMENT and throws `RangeError` past the engine's argument limit.
    for (const row of sliceRows) {
      rows.push(row);
    }
  }
  // The merged re-slice is the second place rows are dropped: slices each under
  // the bound can still sum past it.
  const mergedPastCap = rows.length > MAX_ORG_ORPHAN_USAGE_ROWS;
  rows.sort(compareChildUsageRecency);
  return {
    rows: rows.slice(0, MAX_ORG_ORPHAN_USAGE_ROWS),
    truncated: truncated || mergedPastCap,
  };
}

/** One plugin-detail child usage row, as {@link loadDetailChildUsageRows} selects it. */
export type DetailChildUsageRow = {
  id: string;
  lastInvokedAt: Date | null;
  agentSessionId: string;
  componentKind: string;
  componentKey: string;
  invocationCount: number;
};

/**
 * ISS-9852: the plugin detail's bounded child-usage sample plus whether ANY
 * slice was bound by its own `take`. The rows feed the per-session map (session
 * tabs, `usageSessions`); when `truncated` is true they are a floor for the
 * Invocations/Sessions cards, and the caller reads the whole-population totals
 * over {@link detailChildUsageStatementWheres} instead.
 */
export type DetailChildUsageLanes = {
  rows: DetailChildUsageRow[];
  truncated: boolean;
};

/**
 * ISS-9852: the plugin detail's child-usage predicate, ONE per bind-budget slice
 * of the identity prefilter. The row read and the totals aggregate both iterate
 * this list, so a bound cannot be added to one statement and forgotten on the
 * other (ISS-8932). The slices PARTITION the rows — a usage row carries exactly
 * one `componentKeyNormalized` and the arms are distinct equalities — so a
 * per-slice `_sum` is additive across them.
 */
export function detailChildUsageStatementWheres(
  identityPrefilter: readonly UsageIdentityPredicate[],
  organizationId: string
): Prisma.AgentComponentSessionUsageWhereInput[] {
  const whereFor = (
    prefilterChunk: UsageIdentityPredicate[]
  ): Prisma.AgentComponentSessionUsageWhereInput => ({
    componentKind: { in: [...PLUGIN_CHILD_KINDS] },
    // Prefilter to THIS plugin's child identities BEFORE the cap so unrelated
    // org child activity can't fill MAX_ORG_ORPHAN_USAGE_ROWS and starve the
    // requested plugin's detail to zero (whitlockk review). An equality on the
    // ISS-6756 persisted fold admits every case/whitespace variant the caller's
    // `belongsToPlugin` re-match keeps (FEA-3239).
    OR: prefilterChunk,
    // ISS-6180 (davetho review): the SAME tombstoned-FK exclusion the list's
    // `loadChildUsageByPackId` applies. The caller's re-match is identity-only,
    // so without it a tombstoned child sharing a live sibling's `(kind, key)`
    // counts here while the usage-only lane also reports it — and the detail
    // would drift HIGH against a list that had been fixed alone.
    AND: [usageWithoutTombstonedInventoryWhere()],
    session: {
      artifact: {
        organizationId,
      },
    },
  });
  const chunkSize = orArmsPerStatement(
    countPredicateBindParameters(whereFor([])),
    CHILD_PREFILTER_ARM_BIND_WIDTH,
    1
  );
  return chunksOf(identityPrefilter, chunkSize).map(whereFor);
}

/**
 * The JS twin of the detail read's `orderBy` — most recent first, nulls last,
 * primary key as the unique tiebreak. It exists so re-ranking the merged slices
 * cannot disagree with the order each slice was cut by.
 */
function compareChildUsageRecency(
  a: { id: string; lastInvokedAt: Date | null },
  b: { id: string; lastInvokedAt: Date | null }
): number {
  const aTime = a.lastInvokedAt?.getTime() ?? null;
  const bTime = b.lastInvokedAt?.getTime() ?? null;
  if (aTime !== null && bTime !== null && aTime !== bTime) {
    return bTime - aTime;
  }
  if (aTime === null && bTime !== null) {
    return 1;
  }
  if (bTime === null && aTime !== null) {
    return -1;
  }
  return a.id < b.id ? -1 : 1;
}
