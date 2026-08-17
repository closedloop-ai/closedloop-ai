/**
 * ISS-4707 — bound the `session.ingestion.policy_denied` emission at the single
 * org-policy choke point (`isOrgSessionSyncPolicyEnabled`).
 *
 * That choke point is ANDed in front of every session-ingest boundary and, per
 * ISS-4543, emits `session.ingestion.policy_denied` on every DENIED lookup. Two
 * of the callers reach it with no limiter in front (the trace-comment routes)
 * or before their own limiter runs (transcript authorization), so an
 * authenticated member of a policy-off org can replay those paths and drive an
 * UNBOUNDED stream of denial metrics — inflating Datadog volume and any
 * denial-count alert. The allow/deny answer never depends on the metric, so
 * throttling the emission is safe.
 *
 * This throttle collapses a burst of denials for the same `(orgId, reason)` into
 * ONE emitted event per fixed window: the FIRST denial in a window emits, the
 * rest are counted and suppressed. The count is not lost — it is flushed as an
 * aggregate rollup on the first emit of the NEXT window for that key, so the
 * additive `sum(count)` a Datadog monitor computes still reflects the true
 * denial volume rather than a throttled undercount (whenever the fleet keeps
 * retrying, which is exactly the replay/abuse case this bounds).
 *
 * No suppressed count is dropped, even under memory pressure: when the hard
 * max-entry cap evicts the least-recently-used key, any count it had suppressed
 * is flushed through `onFlush` first, so a two-key rollover order or a cap
 * eviction can never discard the pending rollup for another key.
 *
 * Serverless constraint (apps/api/AGENTS.md "Serverless Routes and State"):
 * this is a process-local, best-effort abuse-control map. It keys on the stable
 * `(orgId, reason)` principal — never an ephemeral connection id — and bounds
 * memory with a hard max-entry LRU cap, mirroring `FixedWindowRateLimiter`. The
 * per-window rollover is resolved lazily when a key is next touched, and stale
 * keys are reclaimed by LRU eviction on insertion, so a suppressed replay is
 * O(1) rather than a full-map sweep. On a serverless fleet each instance dedups
 * independently, so the aggregate emitted across instances is preserved; a
 * single hot instance can no longer be replayed into an unbounded emit stream.
 */

import {
  emitSessionIngestionPolicyDeniedAggregate,
  type SessionIngestionDenialReason,
} from "./session-ingestion-metrics";

export const SESSION_INGESTION_POLICY_DENIED_WINDOW_MS = 60_000;
export const SESSION_INGESTION_POLICY_DENIED_MAX_ENTRIES = 10_000;

/** Composite-key delimiter. Reason values are fixed snake_case tokens, so `|` cannot collide with a key part. */
const KEY_DELIMITER = "|";

type ThrottleEntry = {
  /** When the current window ends; a denial at or after this resets the window. */
  resetAt: number;
  /** Denials suppressed in the CURRENT window after the first (which emitted). */
  suppressedCount: number;
};

/**
 * The decision returned for one denial.
 *
 * - `emit`: whether THIS denial should emit its own `count: 1` event (true only
 *   for the first denial in a window).
 * - `flushedSuppressedCount`: when a fresh window opens, the number of denials
 *   suppressed in the just-closed window for this key, to be emitted as an
 *   aggregate rollup so no denial is dropped from the additive counter. `0`
 *   when nothing was suppressed or the window did not roll over.
 */
export type PolicyDeniedThrottleDecision = {
  emit: boolean;
  flushedSuppressedCount: number;
};

const EMIT_FIRST: PolicyDeniedThrottleDecision = {
  emit: true,
  flushedSuppressedCount: 0,
};

const SUPPRESS: PolicyDeniedThrottleDecision = {
  emit: false,
  flushedSuppressedCount: 0,
};

/**
 * Called when the max-entry cap evicts a key that still holds suppressed
 * denials, so the pending rollup is emitted as an aggregate instead of being
 * discarded. `suppressedCount` is always positive.
 */
export type PolicyDeniedFlushHandler = (
  orgId: string,
  reason: SessionIngestionDenialReason,
  suppressedCount: number
) => void;

export type SessionIngestionPolicyDeniedThrottleOptions = {
  windowMs?: number;
  maxEntries?: number;
  /**
   * Sink for suppressed counts flushed by LRU eviction. Defaults to a no-op so
   * a caller that does not wire it up simply loses the eviction-flush (never
   * throws); the production instance below wires it to the aggregate emitter.
   */
  onFlush?: PolicyDeniedFlushHandler;
};

/**
 * Per-(org, reason) fixed-window throttle for the policy-denied metric. Entries
 * live in a `Map`, never as object properties, so a crafted `orgId` cannot
 * reach `__proto__`/`constructor` — no prototype-pollution surface. The `Map`
 * preserves insertion order, which the eviction path uses as an LRU proxy:
 * touching a key re-inserts it at the tail (see `touch`), so the head is always
 * the least-recently-used key.
 */
export class SessionIngestionPolicyDeniedThrottle {
  private readonly entries = new Map<string, ThrottleEntry>();
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly onFlush: PolicyDeniedFlushHandler | undefined;

  constructor(options: SessionIngestionPolicyDeniedThrottleOptions = {}) {
    this.windowMs =
      options.windowMs ?? SESSION_INGESTION_POLICY_DENIED_WINDOW_MS;
    this.maxEntries =
      options.maxEntries ?? SESSION_INGESTION_POLICY_DENIED_MAX_ENTRIES;
    this.onFlush = options.onFlush;
  }

  /**
   * Record one denial and decide whether it emits. The caller has already
   * denied before calling this, and emits based only on the returned decision,
   * so a throttling bug can never change the allow/deny answer.
   *
   * The hot suppressed-replay path is O(1): it never scans the map. Per-window
   * rollover is resolved lazily for THIS key, and stale keys are reclaimed by
   * LRU eviction when a new key is inserted — so one key's rollover order can
   * never discard another key's pending suppressed count.
   */
  record(
    orgId: string,
    reason: SessionIngestionDenialReason,
    now: number
  ): PolicyDeniedThrottleDecision {
    const key = buildKey(orgId, reason);
    const current = this.entries.get(key);

    if (!current) {
      this.entries.set(key, {
        resetAt: now + this.windowMs,
        suppressedCount: 0,
      });
      this.evictOverflow();
      return EMIT_FIRST;
    }

    if (now >= current.resetAt) {
      const flushedSuppressedCount = current.suppressedCount;
      current.resetAt = now + this.windowMs;
      current.suppressedCount = 0;
      this.touch(key, current);
      return flushedSuppressedCount > 0
        ? { emit: true, flushedSuppressedCount }
        : EMIT_FIRST;
    }

    current.suppressedCount += 1;
    this.touch(key, current);
    return SUPPRESS;
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * Move a just-accessed key to the tail so the Map's head stays the
   * least-recently-used key for `evictOverflow`.
   */
  private touch(key: string, entry: ThrottleEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  /**
   * Enforce the hard max-entry cap by evicting least-recently-used keys. An
   * evicted key that still holds suppressed denials is flushed through
   * `onFlush` so its count reaches the additive counter rather than being
   * dropped.
   */
  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value;
      if (oldest === undefined) {
        return;
      }
      const [oldestKey, oldestEntry] = oldest;
      this.entries.delete(oldestKey);
      if (oldestEntry.suppressedCount > 0 && this.onFlush) {
        const { orgId, reason } = splitKey(oldestKey);
        this.onFlush(orgId, reason, oldestEntry.suppressedCount);
      }
    }
  }
}

function buildKey(orgId: string, reason: SessionIngestionDenialReason): string {
  return `${orgId}${KEY_DELIMITER}${reason}`;
}

/**
 * Inverse of `buildKey`. The reason is a fixed snake_case token with no
 * delimiter, so the LAST delimiter splits org (which may itself contain none)
 * from reason unambiguously.
 */
function splitKey(key: string): {
  orgId: string;
  reason: SessionIngestionDenialReason;
} {
  const delimiterIndex = key.lastIndexOf(KEY_DELIMITER);
  return {
    orgId: key.slice(0, delimiterIndex),
    reason: key.slice(delimiterIndex + 1) as SessionIngestionDenialReason,
  };
}

/**
 * Process-local shared throttle for the production choke point. Ephemeral per
 * serverless instance by design; tests construct their own instance to control
 * time and window bounds.
 */
export const sessionIngestionPolicyDeniedThrottle =
  new SessionIngestionPolicyDeniedThrottle({
    onFlush: emitSessionIngestionPolicyDeniedAggregate,
  });
