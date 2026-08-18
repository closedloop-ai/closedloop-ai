/**
 * @file db-host-identity-publisher.ts
 * @description ISS-6243 — the SENDING half of the db host's user identity.
 *
 * `getUserIdentity` must answer SYNCHRONOUSLY inside the child runtime, so the
 * db host serves it from a cache that main is responsible for filling
 * (db-host-protocol.ts). Main filled it exactly once, in the Init message — and
 * on a cold start that snapshot is `null` BY CONSTRUCTION, because the identity
 * resolver returns null on a cache miss and warms `/me` in the background.
 * `DbHostClient.setUserIdentity` existed but had no production caller, so the
 * cache stayed null for the whole process lifetime and every writer in the child
 * stamped a null `user_id`/`organization_id`.
 *
 * This publisher is the missing push. It is edge-triggered and value-deduped on
 * the `(userId, organizationId)` PAIR: a change must reach the child promptly
 * because a stale identity attributes sessions to the wrong person, while an
 * unchanged identity must not generate traffic. It never invents an identity —
 * a signed-out machine publishes `null`, which is what makes the existing
 * unattributed affordance keep rendering instead of a wrong name.
 *
 * It supersedes ISS-6168's `startDbHostIdentityWatch` poll, which existed only
 * because the resolver exposed no completion signal. It carries that watch's one
 * load-bearing invariant forward — the baseline is what the child OPENED with,
 * never the publisher's own first read — while covering the transitions a
 * fire-once poll could not: sign-out, an org switch that keeps the user id, and
 * anything after the first push.
 */
import { sameUserIdentity } from "../../util/user-identity.js";
import type { DbHostUserIdentity } from "./db-host-protocol.js";

export type DbHostIdentityPublisher = {
  /**
   * Record the identity the child was actually OPENED with (the exact value
   * handed to `dbHost.start`), so the first {@link sync} measures against what
   * the child holds.
   *
   * ISS-6168's lesson, kept: the baseline must NOT be this publisher's own first
   * read. The resolver can warm between `dbHost.start` and the child reporting
   * ready, and a baseline taken from a read inside that window records an
   * identity as published that the child was never told — skipping the push on
   * exactly the cold boots that need it.
   */
  seedFromChildOpen: (identity: DbHostUserIdentity) => void;
  /** Re-read the live identity and push it to the child only if it changed. */
  sync: () => void;
  /**
   * Drop every piece of retained state and latch the publisher inert, so an
   * identity notification that races the db-host teardown can no longer push
   * into a client that is closing.
   */
  stop: () => void;
};

/**
 * "This publisher has not pushed anything yet" — distinct from `null`, which is
 * the real identity of a signed-out machine. See {@link createDbHostIdentityPublisher}.
 */
const UNPUBLISHED = Symbol("db-host-identity-unpublished");

export type DbHostIdentityPublisherOptions = {
  /** Reads the live identity — the same accessor the Init snapshot was taken from. */
  getIdentity: () => DbHostUserIdentity;
  /** Pushes an identity to the db-host child. */
  setIdentity: (identity: DbHostUserIdentity) => void;
};

export function createDbHostIdentityPublisher(
  options: DbHostIdentityPublisherOptions
): DbHostIdentityPublisher {
  // UNKNOWN, not `null`. What the child holds is genuinely unknown until either
  // `seedFromChildOpen` records what it opened with or this publisher has pushed
  // once, and `null` is a real identity value — a signed-out machine. Seeding
  // with `null` collapses those two distinct states: when Init carried a real
  // user who then signs out before Ready, the first sync reads `null`, dedupes
  // against the `null` seed, and the child keeps the signed-out user for its
  // whole lifetime. Until the baseline is known, a sync publishes rather than
  // assumes.
  let published: DbHostUserIdentity | typeof UNPUBLISHED = UNPUBLISHED;
  let stopped = false;
  // Both identity sources notify from inside their own read path, so `sync()`
  // can re-enter through `getIdentity()`. Dropping the inner call is correct
  // rather than merely safe: the outer call reads after the source has settled,
  // so it is the one that observes — and publishes — the final value.
  let syncing = false;

  const sync = (): void => {
    if (stopped || syncing) {
      return;
    }
    syncing = true;
    try {
      const identity = options.getIdentity();
      if (published !== UNPUBLISHED && sameUserIdentity(published, identity)) {
        return;
      }
      options.setIdentity(identity);
      published = identity;
    } catch {
      // Reading the identity means reading a credential, which can fail (an
      // unreadable secrets store). Leave `published` untouched so the next
      // notification retries, rather than recording an identity the child was
      // never actually told about.
    } finally {
      syncing = false;
    }
  };

  return {
    seedFromChildOpen(identity: DbHostUserIdentity): void {
      if (stopped) {
        return;
      }
      published = identity;
    },
    sync,
    stop(): void {
      stopped = true;
      published = UNPUBLISHED;
    },
  };
}
