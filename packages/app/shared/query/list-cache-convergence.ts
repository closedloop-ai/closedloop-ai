/**
 * @file list-cache-convergence.ts
 * @description ISS-9553 — the ONE declared contract for how a list surface's
 * caches converge after a sync or mutation.
 *
 * ## The failure this exists to make impossible
 *
 * Each domain owns a query-key object (`agentSessionKeys`, `branchesKeys`) and a
 * live bridge that invalidates a HAND-WRITTEN list of prefixes from it. Nothing
 * tied the two together, so every cache family added to a key object shipped
 * uninvalidated until someone noticed and patched the bridge by hand — the
 * bridges' own docstrings record that sequence (FEA-4157 for session page-data,
 * the B6 follow-up for the branch KPI cards). A family the bridge does not name
 * still resolves, still reports `status: "success"`, and still renders: the
 * reader sees pre-sync rows in a view that looks settled. That is the false
 * settled state, and a hand-maintained list cannot prevent the next one.
 *
 * A contract declared over `keyof` the key object can. Every family must carry a
 * disposition, so adding one without classifying it fails `tsc` rather than
 * shipping stale; and the bridges DERIVE their invalidation set from the
 * disposition instead of restating it, so a family classified as converging is
 * invalidated by construction.
 *
 * ## Why prefix coverage is checked at runtime and not assumed
 *
 * TanStack Query invalidates by prefix match, so `{ queryKey: lists() }` reaches
 * `list(scope, filters)` only while `list()` still literally begins with
 * `lists()`. That is a positional property of the key arrays, not something the
 * types express: moving a segment (say, hoisting `scope` ahead of the read-type
 * prefix) keeps both functions well-typed and compiling while silently severing
 * every invalidation aimed at that family. {@link isQueryKeyPrefixOf} lets each
 * slice's contract test assert the match it depends on.
 */

/** A cache key, or the leading segments of one. */
export type QueryKeyPrefix = readonly unknown[];

/**
 * What one query-key family does when a live change event flushes.
 *
 * - `root` — the namespace prefix every other family extends. Never invalidated
 *   on its own; doing so would sweep the deliberately excluded families too.
 * - `always` — re-fetched on EVERY flush. The family's rows or aggregates derive
 *   from the synced corpus, so any change can move them.
 * - `broad-only` — invalidated wholesale only when a change is BROAD; a scoped
 *   change invalidates the individual entity keys underneath it instead.
 * - `excluded` — deliberately never invalidated by a change event. Requires a
 *   reason, because an unexplained exclusion is indistinguishable from the
 *   oversight this contract exists to catch.
 */
export const CacheConvergence = {
  Root: "root",
  Always: "always",
  BroadOnly: "broad-only",
  Excluded: "excluded",
} as const;
export type CacheConvergence =
  (typeof CacheConvergence)[keyof typeof CacheConvergence];

/**
 * One family's disposition. A family is either a PREFIX carrying a disposition,
 * or an EXACT key wholly addressed by another family's prefix — in which case it
 * names that prefix (`coveredBy`) and inherits its behavior rather than
 * declaring a second, driftable one.
 */
export type CacheConvergenceRule<TFamily extends string = string> =
  | { readonly prefix: typeof CacheConvergence.Root }
  | { readonly prefix: typeof CacheConvergence.Always }
  | { readonly prefix: typeof CacheConvergence.BroadOnly }
  | {
      readonly prefix: typeof CacheConvergence.Excluded;
      readonly reason: string;
    }
  | { readonly coveredBy: TFamily };

/**
 * A total classification of a query-key object. The mapped type is what makes a
 * newly added family a compile error instead of a silently stale surface: the
 * `-?` strips optionality so every key of `TKeys` must be present.
 *
 * `coveredBy` is narrowed to the key object's OWN family names for the same
 * reason. A bare `string` there would let a typo (`"lsit"`) or a surviving
 * reference to a renamed sibling type-check while naming a prefix that does not
 * exist — reintroducing, through the contract meant to prevent it, a family that
 * nothing invalidates.
 */
export type CacheConvergenceContract<TKeys extends object> = {
  readonly [K in keyof TKeys]-?: CacheConvergenceRule<
    Extract<keyof TKeys, string>
  >;
};

/** True when `key` begins with every segment of `prefix`, as TanStack matches. */
export function isQueryKeyPrefixOf(
  prefix: QueryKeyPrefix,
  key: QueryKeyPrefix
): boolean {
  if (prefix.length > key.length) {
    return false;
  }
  return prefix.every((segment, index) => Object.is(segment, key[index]));
}

/**
 * Resolve a key-object member to a prefix array. Members are either raw arrays
 * (`all`) or zero-argument factories (`lists()`).
 *
 * The declared arity is the load-bearing check. An entity-keyed factory invoked
 * with no arguments does NOT fail — `list(scope, filters)` happily returns
 * `[..., undefined, undefined]`, an array that type-checks, passes an
 * `Array.isArray` guard, and then matches no cache entry at all. That is the
 * silent no-op this contract exists to prevent, so a member declaring
 * parameters is rejected as a misclassification instead.
 */
function resolvePrefix(familyName: string, member: unknown): QueryKeyPrefix {
  if (Array.isArray(member)) {
    return member;
  }
  if (typeof member === "function" && member.length === 0) {
    const resolved = (member as () => unknown)();
    if (Array.isArray(resolved)) {
      return resolved;
    }
  }
  throw new TypeError(
    `Query-key family "${familyName}" is classified as an invalidation prefix but cannot address a cache subtree. A prefix family must be a key array or a ZERO-ARGUMENT factory returning one; an entity-keyed factory invoked without its arguments yields a key full of \`undefined\` that matches nothing.`
  );
}

/**
 * Memoized resolutions, keyed by contract object then disposition.
 *
 * A slice's contract and key object are module-level singletons, so a resolution
 * is a pure function of them and can be computed once. The cache is what lets
 * the derivation be LAZY without paying for laziness on every flush: resolving
 * per call is required (see the note on each slice's exported resolver — a
 * module-scope derivation breaks partially mocked hooks modules at import), and
 * this keeps that from becoming repeated work on the invalidation path.
 *
 * A `WeakMap` so a contract that goes out of scope takes its entry with it,
 * rather than pinning it for the process lifetime.
 */
const resolvedPrefixCache = new WeakMap<
  object,
  Map<string, readonly QueryKeyPrefix[]>
>();

/**
 * The prefixes a bridge must invalidate for the requested disposition.
 *
 * Bridges call this instead of listing prefixes inline, so a family newly
 * classified `always` is picked up without touching the bridge — which is the
 * whole point: the classification, not the bridge, is the source of truth.
 */
export function convergingPrefixes(
  keys: Readonly<Record<string, unknown>>,
  contract: Readonly<Record<string, CacheConvergenceRule>>,
  disposition:
    | typeof CacheConvergence.Always
    | typeof CacheConvergence.BroadOnly
): readonly QueryKeyPrefix[] {
  const cached = resolvedPrefixCache.get(contract)?.get(disposition);
  if (cached) {
    return cached;
  }

  const prefixes: QueryKeyPrefix[] = [];
  for (const [familyName, rule] of Object.entries(contract)) {
    if ("prefix" in rule && rule.prefix === disposition) {
      prefixes.push(resolvePrefix(familyName, keys[familyName]));
    }
  }

  // Cached only after every family resolved. A throw above leaves nothing
  // behind, so a partially mocked key object fails identically on every call
  // rather than poisoning the cache with a half-built set.
  let byDisposition = resolvedPrefixCache.get(contract);
  if (!byDisposition) {
    byDisposition = new Map();
    resolvedPrefixCache.set(contract, byDisposition);
  }
  byDisposition.set(disposition, prefixes);
  return prefixes;
}

/**
 * The prefix each `coveredBy` family claims to sit under, resolved to an actual
 * key array. Read from the contract rather than restated, so a slice's coverage
 * test exercises the declared relationship instead of a hand-written pair that
 * would keep agreeing after the declaration changed.
 *
 * Throws when a `coveredBy` names a family that is not itself a prefix — the
 * types stop a name that does not exist, but not one that points at another
 * `coveredBy` entry, which would leave both covered by nothing.
 *
 * Throws for a `coveredBy` aimed at the `root` family too (davetho review).
 * `root` IS a prefix, and the widest one, so a family naming it reads as
 * maximally covered while being the one target that converges on nothing: the
 * root is deliberately never invalidated, precisely so it cannot sweep the
 * excluded families under it. A new exact family pointed there would type-check
 * and satisfy the prefix-geometry check — its key really does begin with the
 * root — and still never converge after a flush, which is the exact defect this
 * contract exists to make impossible. `excluded` is NOT rejected here: it is a
 * deliberate disposition carrying a reason, so inheriting it is a declared
 * choice rather than an invisible one.
 */
export function coveringPrefixes(
  keys: Readonly<Record<string, unknown>>,
  contract: Readonly<Record<string, CacheConvergenceRule>>
): ReadonlyMap<string, QueryKeyPrefix> {
  const covering = new Map<string, QueryKeyPrefix>();
  for (const [familyName, rule] of Object.entries(contract)) {
    if (!("coveredBy" in rule)) {
      continue;
    }
    const target = contract[rule.coveredBy];
    if (!(target && "prefix" in target)) {
      throw new TypeError(
        `Query-key family "${familyName}" declares coveredBy "${rule.coveredBy}", which is not a prefix family. A covering family must carry a prefix disposition, or neither is invalidated by anything.`
      );
    }
    if (target.prefix === CacheConvergence.Root) {
      throw new TypeError(
        `Query-key family "${familyName}" declares coveredBy "${rule.coveredBy}", the namespace root. The root is deliberately never invalidated — sweeping it would take the excluded families with it — so a family covered by it converges on nothing while still matching every prefix check. Name the family that actually converges, or classify this one directly.`
      );
    }
    covering.set(
      familyName,
      resolvePrefix(rule.coveredBy, keys[rule.coveredBy])
    );
  }
  return covering;
}

/**
 * Every family classified `excluded`, with its reason. Exposed so a slice's
 * contract test can pin the exclusions by name: an exclusion is the one
 * disposition that produces no observable invalidation, so nothing else would
 * notice a family being quietly moved into it.
 */
export function excludedFamilies(
  contract: Readonly<Record<string, CacheConvergenceRule>>
): ReadonlyMap<string, string> {
  const excluded = new Map<string, string>();
  for (const [familyName, rule] of Object.entries(contract)) {
    if ("prefix" in rule && rule.prefix === CacheConvergence.Excluded) {
      excluded.set(familyName, rule.reason);
    }
  }
  return excluded;
}
