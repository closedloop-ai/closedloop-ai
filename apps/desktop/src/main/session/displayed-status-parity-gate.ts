/**
 * ISS-4556 / ISS-4559 — the main-process resolver for the
 * `sessions-displayed-status-parity` Labs flag.
 *
 * The two consumers (`mapListItem`'s row status and `matchesStatusFilter`) are
 * pure leaves inside the 2,000-line `shared-agent-sessions-api.ts`, which owns no
 * settings store and is under a shrink-only size grandfather. Threading a boolean
 * down that path would grow it; instead the composition root registers the
 * store-backed resolver here once at startup and the leaves read it through this
 * module, so each stays directly testable by overriding the resolver.
 *
 * Mirrors `local-session-pr-gate.ts` (ISS-4922), which solved the same problem
 * for the same file.
 *
 * Fails CLOSED: until the composition root registers a resolver — and in every
 * fake/legacy caller and test that never does — the gate reads `false`, which is
 * today's ungated behavior and the flag's registry default.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The registered resolver. Replaced once, by the composition root. */
let resolveGate: () => boolean = () => false;

/**
 * Bind the gate to the real settings store. Called once from the desktop
 * composition root; a later call replaces the previous resolver (the store is a
 * singleton, so this only happens across a full service rebuild).
 */
export function setDisplayedStatusParityResolver(
  resolver: () => boolean
): void {
  resolveGate = resolver;
}

/**
 * ISS-4556: the decision in force for the CURRENT read, when one is scoped.
 *
 * The gate has many leaf readers — the row status (`mapListItem`), the Status
 * facet (`matchesStatusFilter`), the Status sort key (`sessionSortKey`), the SQL
 * count predicate — and a single Sessions read calls them once PER ROW and per
 * sort comparison, across `await` boundaries. Read live each time, one read could
 * mix derivations: if the settings-store resolver threw transiently mid-fold (it
 * swallows the error to `false`) or the user flipped the Labs switch while the
 * page was loading, rows folded before the change carried `waiting`/`stale` and
 * rows after carried raw `active`, and the Status sort then ranked some at 0 and
 * others at 1/4 under one header click. That is the per-read incoherence the
 * cloud half fixes with its memoized per-viewer decision
 * (`resolveDisplayedStatusParity`); this is the desktop equivalent.
 *
 * `AsyncLocalStorage` rather than a threaded parameter, for the reason the module
 * header already gives: the leaves live inside a shrink-only grandfathered file,
 * and widening four signatures to carry a boolean would grow it. It also keeps
 * concurrent reads isolated from each other, which a module-level snapshot
 * variable would not.
 *
 * The scope is opened at the IPC read boundary
 * (`agent-dashboard-shared-read-ipc.ts`), not inside `getSharedAgentSessions`,
 * because the cohort is wider than the list: the `pageData` channel resolves the
 * list, the usage aggregate, and the facet-scoped counts for ONE screen from
 * separate modules. Scoping inside the list read would leave the cards above the
 * table free to resolve the gate independently — the same split the cloud memo's
 * docstring calls out.
 *
 * WHAT IS SCOPED, precisely: the four MULTI-ROW Sessions channels — `list`,
 * `usage`, `analytics`, `pageData` (asserted by
 * `test/shared-read-ipc-parity-scope.test.ts`). The `detail` channel is
 * deliberately NOT scoped: it maps exactly one row, so `mapListItem` reads the
 * gate exactly once and there is no intra-read cohort that could disagree with
 * itself — a scope there would pin a decision nothing else in that read consults.
 *
 * That leaves one divergence this module does NOT claim to fix, stated here so
 * the omission is not mistaken for coverage: a detail read and the list read
 * behind it are SEPARATE IPC calls, so if the resolver answers differently
 * between them the drawer can badge `Active` while the row it was opened from
 * badges `Stale`. No per-read scope closes that — scoping `detail` would give it
 * its own decision resolved at its own instant, and the two calls would still
 * disagree. This pins each read INTERNALLY; agreement ACROSS reads is a
 * different problem with a different fix.
 */
const parityScope = new AsyncLocalStorage<boolean>();

/**
 * Resolve the gate ONCE and pin it for everything `run` does, including across
 * its `await`s. Every {@link isDisplayedStatusParityEnabled} call inside sees
 * that one decision, so a read's rows, facet, and sort order cannot disagree.
 *
 * Unscoped callers are unaffected — they keep reading the resolver live.
 */
export function withDisplayedStatusParityScope<T>(run: () => T): T {
  return parityScope.run(readGate(), run);
}

/**
 * Whether the Local lane should derive the row status and the Status facet from
 * the DISPLAYED-status projection. Inside a
 * {@link withDisplayedStatusParityScope} this serves that read's pinned decision;
 * outside one it resolves live.
 */
export function isDisplayedStatusParityEnabled(): boolean {
  return parityScope.getStore() ?? readGate();
}

/**
 * The live resolver read. Never throws into a list read: a resolver that fails is
 * treated as OFF (today's behavior) rather than collapsing the Sessions list.
 */
function readGate(): boolean {
  try {
    return resolveGate();
  } catch {
    return false;
  }
}
