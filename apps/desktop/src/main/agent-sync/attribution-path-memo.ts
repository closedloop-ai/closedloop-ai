/**
 * @file attribution-path-memo.ts
 * @description ISS-5272 — a process-lifetime, bounded, TTL'd, single-flight memo
 * for the `path → org/repo` git-remote resolution behind session attribution.
 *
 * Every attribution consumer (sync hydration, the usage/analytics folds, the
 * Repository facet, the repo-scoped id scan) builds a FRESH
 * `SessionAttributionResolverCache`, so on the measured corpus (4,336 sessions,
 * 1,238 distinct cwds) `git remote get-url origin` was re-spawned once per cwd
 * per call site — 37.6% of the db-host profile sat in `spawn`. This memo sits
 * UNDER those per-call caches so the same cwd costs one spawn per TTL window
 * across all of them.
 *
 * It deliberately does NOT change precedence. A memo entry IS a real live
 * resolution of that exact path, just up to one TTL old, so `live → stored →
 * branch-provenance` and the FEA-3555 durable write-back keep working exactly as
 * before; staleness is bounded by the TTL and self-heals on the next miss.
 *
 * Shape follows `cost/anthropic-keychain.ts`'s `hasKeychainCredentialCached`:
 * injected `now`, asymmetric present/absent TTLs, a MAX_ENTRIES bound and a
 * reset seam. It diverges from that precedent in three deliberate ways:
 *   - eviction is LRU, not clear-on-overflow. Keychain caps at 8 entries; a
 *     full flush against 1,238 distinct cwds would fire constantly and erase the
 *     win this module exists to produce.
 *   - an in-flight map collapses OVERLAPPING resolutions of one key to a single
 *     spawn (the db-host does not await prior requests, so a completed-values-
 *     only memo would still let a fan-out all miss and all spawn). Same shape as
 *     `cloud/desktop-cloud-github-hydration.ts`'s `pending` map, including
 *     evicting a REJECTED entry so a later caller retries instead of inheriting
 *     the failure forever.
 *   - only a `NoOrigin` outcome is memoized as a negative. A transient spawn
 *     failure (ENOENT/EAGAIN/EMFILE/timeout) leaves the key unmemoized, or it
 *     would degrade live-first precedence to the stale stored value for the
 *     whole negative-TTL window (C2).
 *
 * The key is the ALS git-binary override plus the path, NOT the resolved git
 * path: `getOverrideBinaryPaths()` is a plain AsyncLocalStorage read, whereas
 * `getResolvedGitPath()` runs ~10-30 blocking `accessSync` calls per lookup —
 * re-importing on every HIT the synchronous cost this module removes. A hit must
 * stay pure bookkeeping.
 *
 * Invalidation is TTL-bounded only: there is deliberately no db-host clear op
 * (the cached values are absolute-path → repo-identity facts, independent of
 * which cloud identity is syncing, and a fire-and-forget clear across the IPC
 * boundary is the ISS-4620/ISS-4818 crash class).
 */
import {
  type RepoFullNameOutcome,
  RepoFullNameStatus,
  resolveRepoFullNameOutcomeAsync,
} from "../../server/operations/git-helpers.js";
import { getOverrideBinaryPaths } from "../../server/operations/symphony-loop.js";
import { createColdReadGate } from "../collectors/parsing/cold-read-gate.js";
import { yieldDbHostLoop } from "../database/db-host/yield-db-host-loop.js";

/**
 * How long a RESOLVED `org/repo` is trusted. Must outlive one workload (the
 * measured `nav-sessions` is ~123s plus five paginates) or the win never lands,
 * yet stay short enough that a durably written stale name self-heals in minutes.
 */
export const ATTRIBUTION_MEMO_TTL_PRESENT_MS = 300_000;

/**
 * How long an ABSENT origin is trusted. Much shorter than the present TTL so a
 * freshly cloned or `git init`ed worktree starts resolving quickly.
 */
export const ATTRIBUTION_MEMO_TTL_ABSENT_MS = 30_000;

/**
 * Entry cap before LRU eviction. >=3x the 1,238 distinct cwds measured on the
 * reference corpus, so a real machine never evicts a live working set.
 */
export const ATTRIBUTION_MEMO_MAX_ENTRIES = 4096;

/**
 * Permits for concurrent `git remote get-url origin` spawns. Strictly below
 * `SYNCED_SESSION_HYDRATE_CHUNK_SIZE` (200) — a cap at the chunk size would
 * preserve the spawn storm while still satisfying a naive "never exceeds the
 * cap" assertion.
 */
export const ATTRIBUTION_SPAWN_CONCURRENCY = 8;

/**
 * Iterations between cooperative yields in the serial attribution folds. Well
 * below the 1,238 distinct cwds, so a real corpus yields ~19x per fold instead
 * of zero once this memo turns the per-row `execFile` await (today's accidental
 * poll-phase turn) into a microtask-only resolution.
 */
export const ATTRIBUTION_YIELD_INTERVAL = 64;

/** Where a resolved `org/repo` came from on this call. */
export const AttributionRepoSource = {
  /** A real `git remote get-url origin` spawn ran for this call. */
  Live: "live",
  /** Served from a still-valid memo entry; no process was spawned. */
  Memo: "memo",
} as const;
export type AttributionRepoSource =
  (typeof AttributionRepoSource)[keyof typeof AttributionRepoSource];

export type AttributionRepoResolution = {
  repositoryFullName: string | null;
  source: AttributionRepoSource;
};

/** Injectable miss loader; defaults to the real classifying git resolver. */
export type AttributionRepoLoader = (
  repoPath: string
) => Promise<RepoFullNameOutcome>;

/**
 * Dedicated spawn gate. It reuses the `createColdReadGate` FACTORY but NOT the
 * process-wide `coldReadGate` singleton: that one exists so cold Copilot-chat
 * and transcript reads bound each other's heap peaks at width 2, and routing a
 * 200-cwd spawn fan-out through its permits would starve the interactive
 * live-hook ingest path. It is instantiated HERE, next to the miss loader it
 * wraps, so it can never take a permit for a per-call or memo hit — and so the
 * database-side caller does not have to import a gate back across the module
 * boundary it already depends on.
 */
let attributionSpawnGate = createColdReadGate(ATTRIBUTION_SPAWN_CONCURRENCY);

/** Permits currently held by attribution spawns. Observability/test seam. */
export function readAttributionSpawnGateActive(): number {
  return attributionSpawnGate.active;
}

type AttributionMemoEntry = { value: string | null; expiresAt: number };

/** Insertion-ordered, so the first key is the least recently used. */
const memo = new Map<string, AttributionMemoEntry>();

/** Keys with a spawn currently in flight, collapsing overlapping callers. */
const inFlight = new Map<string, Promise<string | null>>();

let yieldCount = 0;

/**
 * Resolve `repoPath` to its `org/repo`, serving a still-valid memo entry when
 * one exists and otherwise running (or joining) exactly one gated spawn.
 *
 * Deliberately NOT an `async function`: the memo lookup, the in-flight join and
 * the gate ACQUISITION all happen synchronously on the caller's turn, so a
 * caller that launches N resolutions in one synchronous loop takes exactly
 * `ATTRIBUTION_SPAWN_CONCURRENCY` permits, not N.
 *
 * Permit acquisition is synchronous; the LOAD is not. `ColdReadGate.run` awaits
 * its acquire, so the first `git` spawn starts a microtask after the call. That
 * is invisible in production (every caller awaits anyway) but means a test must
 * flush microtasks before counting dispatched loads — the permit count is the
 * only quantity observable in the launching turn.
 */
export function resolveAttributionRepoFullName(
  repoPath: string,
  now: number = Date.now(),
  load: AttributionRepoLoader = resolveRepoFullNameOutcomeAsync
): Promise<AttributionRepoResolution> {
  const key = attributionMemoKey(repoPath);
  const cached = memo.get(key);
  if (cached && cached.expiresAt > now) {
    // LRU touch: re-inserting moves the key to the end of the iteration order.
    memo.delete(key);
    memo.set(key, cached);
    return Promise.resolve({
      repositoryFullName: cached.value,
      source: AttributionRepoSource.Memo,
    });
  }
  return startAttributionResolution(key, repoPath, now, load).then(
    (repositoryFullName) => ({
      repositoryFullName,
      source: AttributionRepoSource.Live,
    })
  );
}

/**
 * ISS-5272 (C3): force a LIVE resolution of `repoPath`, ignoring any valid memo
 * entry, and refresh the memo with the result.
 *
 * The durable write-back may persist a memo-sourced name. If the remote changed
 * inside the TTL and the worktree is then deleted before the TTL expires, live
 * resolution returns null forever and the stored-fallback branch would trust the
 * stale name permanently — the "next post-TTL live resolution corrects it"
 * self-heal never runs. Revalidating before persisting a memo-sourced value that
 * DISAGREES with the stored one closes that hole. It still joins an in-flight
 * spawn for the same key, so it can never double-spawn a path already resolving.
 */
export function revalidateAttributionRepoFullName(
  repoPath: string,
  now: number = Date.now(),
  load: AttributionRepoLoader = resolveRepoFullNameOutcomeAsync
): Promise<string | null> {
  const key = attributionMemoKey(repoPath);
  return startAttributionResolution(key, repoPath, now, load);
}

/**
 * ISS-5272 (M3/C5): a cooperative-yield cadence for the serial attribution
 * folds. Call the returned tick at the TOP of the loop body, before any
 * `continue` — the rows that `continue` (null repository) are exactly the ones
 * this memo turns into microtask-only resolutions, so a tail-positioned bump
 * would skip the yield on precisely the corpus that needs it.
 *
 * Yields are counted so a test can assert an ABSOLUTE cadence over a real
 * all-negative corpus rather than merely that some yielding happens.
 */
export function createAttributionYieldCadence(
  interval: number = ATTRIBUTION_YIELD_INTERVAL,
  yieldTo: () => Promise<void> = yieldDbHostLoop
): () => Promise<void> {
  let sinceYield = 0;
  return async () => {
    sinceYield += 1;
    if (sinceYield < interval) {
      return;
    }
    sinceYield = 0;
    yieldCount += 1;
    await yieldTo();
  };
}

/** Total cooperative yields taken by attribution folds since the last reset. */
export function readAttributionYieldCount(): number {
  return yieldCount;
}

/** Zero the yield counter. Test seam; production never resets it. */
export function resetAttributionYieldCount(): void {
  yieldCount = 0;
}

/**
 * Drop the memo, any in-flight entries, and the spawn gate. Test-only seam;
 * production relies on the TTL.
 *
 * The gate is REPLACED rather than drained because a permit is released only by
 * its task settling. A test that observes the cap necessarily leaves loads
 * unsettled, so a surviving gate would carry those permits into every later
 * test and eventually wedge the suite shut — a 120s timeout that looks like a
 * hang in the innocent test rather than a leak in the one that caused it.
 */
export function resetAttributionPathMemo(): void {
  memo.clear();
  inFlight.clear();
  attributionSpawnGate = createColdReadGate(ATTRIBUTION_SPAWN_CONCURRENCY);
}

/**
 * Scope the memo to the ACTIVE git-binary override so a value resolved under one
 * `AsyncLocalStorage` override is never served to another. Reading the override
 * is a plain store read; resolving it to a real binary path is not, and must not
 * happen on the hit path.
 *
 * The two halves are joined with a NUL escape, the one byte that cannot occur
 * in either a binary path or a repo path, so no override/path pair can collide
 * with a different pair. It is written as an ESCAPE, never as a literal byte:
 * a raw NUL makes the whole source file read as binary to `grep`, `file`, and
 * every review/diff tool that samples for one.
 */
function attributionMemoKey(repoPath: string): string {
  return `${getOverrideBinaryPaths()?.git ?? ""}\u0000${repoPath}`;
}

/**
 * Join the in-flight spawn for `key`, or start one under the dedicated gate.
 * A settled promise is evicted from the in-flight map either way, so a rejection
 * cannot poison the key: the next caller starts a fresh resolution.
 */
function startAttributionResolution(
  key: string,
  repoPath: string,
  now: number,
  load: AttributionRepoLoader
): Promise<string | null> {
  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }
  const started = attributionSpawnGate
    .run(() => load(repoPath))
    .then((outcome) => {
      inFlight.delete(key);
      if (outcome.status !== RepoFullNameStatus.SpawnFailed) {
        rememberAttributionResolution(key, outcome.repoFullName, now);
      }
      return outcome.repoFullName;
    })
    .catch((error: unknown) => {
      inFlight.delete(key);
      throw error;
    });
  inFlight.set(key, started);
  return started;
}

/**
 * Store a resolution, evicting the least recently used entry once the memo is at
 * its cap. A present value gets the long TTL, an absent one the short TTL.
 */
function rememberAttributionResolution(
  key: string,
  value: string | null,
  now: number
): void {
  memo.delete(key);
  if (memo.size >= ATTRIBUTION_MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next();
    if (!oldest.done) {
      memo.delete(oldest.value);
    }
  }
  const ttl =
    value === null
      ? ATTRIBUTION_MEMO_TTL_ABSENT_MS
      : ATTRIBUTION_MEMO_TTL_PRESENT_MS;
  memo.set(key, { value, expiresAt: now + ttl });
}
