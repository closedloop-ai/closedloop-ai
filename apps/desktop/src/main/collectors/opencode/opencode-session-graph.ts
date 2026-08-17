/**
 * @file opencode-session-graph.ts
 * @description The `parent_id` session-graph primitives shared by the two
 * OpenCode nesting lanes: the collector's local roll-up
 * (`opencode-subagent-fold.ts`) and the cloud archive projection
 * (`../../transcript-sync/opencode-materializer.ts`).
 *
 * The lanes stay independent by design — one folds children into the parent's
 * `subagents[]`, the other files each child as its own
 * `subagent:<childId>.jsonl` under the root's directory — but they must agree on
 * WHICH session is a child and WHICH root owns it, or the same `opencode.db`
 * nests one way locally and another way in the archive. `collectors/AGENTS.md`
 * states that parity requirement ("do not 'fix' one lane alone"); this module
 * makes it structural rather than a pair of comments asking each copy to track
 * the other. Both lanes previously carried a byte-identical walk (ISS-4649
 * finding 7 memoized the collector's; ISS-5337 memoized the materializer's and
 * extracted the result here).
 *
 * Sharing the CODE is only half of that guarantee: an answer that depends on the
 * order the caller happens to walk its sessions in is not shared behavior, and
 * the two lanes seed `rootCache` from different loops. Every function here is
 * therefore a pure function of `parentById` and the id asked about, including on
 * a malformed CYCLE — see {@link resolveRootRawId}.
 *
 * Pure string/map logic — no I/O, no session types, no imports.
 */

/** The `opencode-` prefix `loadSessionsFromDb` stamps on every `sessionId`. */
export const OPENCODE_SESSION_ID_PREFIX = "opencode-";

/** Raw opencode id from an `opencode-<id>` externalSessionId (or the id itself). */
export function rawSessionId(sessionId: string): string {
  return sessionId.startsWith(OPENCODE_SESSION_ID_PREFIX)
    ? sessionId.slice(OPENCODE_SESSION_ID_PREFIX.length)
    : sessionId;
}

/**
 * A session is a CHILD (subagent) when its `parent_id` names another session
 * that we also parsed. A parent pointing at itself, a missing parent, or a
 * parent id we did not parse is treated as a root (documented fallback — every
 * unlinked session stays a top-level session).
 */
export function isChildSession(
  rawId: string,
  parentById: ReadonlyMap<string, string | null>
): boolean {
  const parent = parentById.get(rawId);
  return parent != null && parent !== rawId && parentById.has(parent);
}

/**
 * Resolve a session's ROOT raw id by walking `parent_id` up the linkage.
 * Cycle/missing-parent safe: an unknown parent or a cycle stops the walk, so a
 * malformed graph never loops or throws.
 *
 * MEMOIZED per pass via `rootCache` (ISS-4649 finding 7, `collectors/AGENTS.md`
 * parent-scan caching). Without it the chain is re-walked from scratch for every
 * child, so a deep or wide graph costs O(n·d) with no reuse between siblings
 * sharing a parent. Every id visited on a walk resolves to the SAME root, so the
 * whole traversed chain is cached at once and the amortized cost is O(n).
 *
 * A CYCLE resolves to the lexicographically smallest id ON that cycle, which is
 * a function of `parentById` alone. The memo is not what makes that stable:
 * memoizing only froze whichever answer the FIRST walk produced, and which walk
 * ran first is the CALLER's iteration order — the collector seeds the cache from
 * its folded-root pass, the materializer from its write pass over
 * `load.sessions`. Two lanes walking the same linkage in different orders would
 * otherwise pick different roots for the same cycle, which is exactly the
 * cross-lane disagreement this module exists to rule out. Callers must still
 * scope `rootCache` to one pass — `parentById` is rebuilt from `opencode.db`
 * each time, and a cache outliving it could answer with a root the linkage no
 * longer has.
 */
export function resolveRootRawId(
  rawId: string,
  parentById: ReadonlyMap<string, string | null>,
  rootCache: Map<string, string>
): string {
  const cached = rootCache.get(rawId);
  if (cached !== undefined) {
    return cached;
  }
  const chainIndexById = new Map<string, number>();
  const chain: string[] = [];
  let current = rawId;
  let root = rawId;
  for (;;) {
    const memo = rootCache.get(current);
    if (memo !== undefined) {
      root = memo;
      break;
    }
    const cycleStart = chainIndexById.get(current);
    if (cycleStart !== undefined) {
      root = smallestCycleMember(chain, cycleStart, current);
      break;
    }
    chainIndexById.set(current, chain.length);
    chain.push(current);
    const parent = parentById.get(current);
    if (parent == null || parent === current || !parentById.has(parent)) {
      root = current;
      break;
    }
    current = parent;
  }
  for (const id of chain) {
    rootCache.set(id, root);
  }
  return root;
}

/**
 * The cycle's stable representative: the lexicographically smallest id from
 * `chain[cycleStart..]`, which is exactly the set of ids on the cycle (`chain`
 * before `cycleStart` is the tail that LED INTO it and is not part of it).
 *
 * A total order over the members is what makes the answer a function of the
 * GRAPH rather than of where the walk started: entering `a → b → a` at `a`
 * yields chain `[a, b]` and entering at `b` yields `[b, a]`, and both minimize
 * to the same id.
 */
function smallestCycleMember(
  chain: readonly string[],
  cycleStart: number,
  entry: string
): string {
  let smallest = entry;
  for (let index = cycleStart; index < chain.length; index += 1) {
    const id = chain[index];
    if (id !== undefined && id < smallest) {
      smallest = id;
    }
  }
  return smallest;
}
