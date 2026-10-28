/**
 * @file agent-session-sync-pass-identity.ts
 * @description ISS-8116 — the PASS-level half of the identity guard ISS-7988
 * established inside the persisted-cursor hydration.
 *
 * ISS-6067 and ISS-7988 both exist for one fact: a compute-target/account switch
 * changes the sync identity WITHOUT bumping `sourceStateGeneration`. Every
 * post-await check in the session sync pass carried the generation alone, so
 * none of them could see the switch they most exist to catch. Worse than rare:
 * `resolveAgentSessionSyncSourceKey` folds the `monitoredActivity` capability
 * into the key, so a hello-ack renegotiation moves the identity and moves it
 * back with no account switch at all.
 *
 * Hoisted into its own module rather than written inline for the reason
 * ISS-7988 hoisted its own guard: `agent-session-sync-service.ts` is a
 * shrink-only grandfathered hotspot (root AGENTS.md), and a predicate that lives
 * behind an injected seam can be EXECUTED against synthetic inputs instead of
 * merely inspected.
 */

/** The three live readings one pass-scoped guard is built from. */
export type SyncPassIdentityInputs = {
  /**
   * Pass token + source-state generation + `started`. Everything a `stop()` or
   * `resetSourceState()` invalidates — and nothing an identity switch does.
   */
  isActivePass: () => boolean;
  /** Transport readiness + consent tier; orthogonal to identity. */
  shouldRun: () => boolean;
  /**
   * The identity the service would resolve RIGHT NOW.
   *
   * MUST read the live compute target (`SessionSyncCapability.sourceKey`), NOT
   * the service's `hydratedSourceKey`. The hydration ASSIGNS that field
   * mid-pass, so a recheck against it would compare the captured key with itself
   * and could never fire — a guard that is present, green, and inert.
   * `SessionDispositionDeps.readSourceKey` is exactly that field, which is why
   * it is the wrong reading for this seam (ISS-7988, restated by ISS-8116).
   */
  readLiveSourceKey: () => string | null;
};

/** The two predicates a pass hands to its own continuations. */
export type SyncPassIdentityGuard = {
  /** The identity resolved when the pass claimed the lane. */
  capturedSourceKey: string | null;
  /**
   * Active pass AND unchanged identity, WITHOUT `shouldRun()`.
   *
   * For the one continuation that must survive a readiness drop: an ack for a
   * batch the server already accepted still has to be folded, or the rows are
   * re-uploaded on the next connection. It still may not be folded under a
   * DIFFERENT identity, because folding it clears outbox rows and advances a
   * cursor keyed to whoever is live now.
   */
  isCurrentSourceIdentity: () => boolean;
  /** {@link isCurrentSourceIdentity} AND `shouldRun()`. The pass-wide default. */
  isCurrentSourceState: () => boolean;
};

/**
 * Capture the pass's identity once and return the guards its continuations use.
 *
 * Neither half of the pair subsumes the other, and ISS-6067 proved that by
 * counterfactual: {@link SyncPassIdentityInputs.isActivePass} catches a `stop()`
 * or a source reset, in which the live identity is unchanged and the key
 * comparison sees nothing; the key comparison catches the account/compute-target
 * switch, which leaves the generation untouched.
 *
 * A `null` captured key (no compute target negotiated yet) is compared exactly
 * like any other value, deliberately: a null → identity transition mid-pass is
 * the ISS-6067 cross-target hazard by its most direct route, because state
 * seeded while no identity was attached is state the arriving identity inherits.
 */
export function createSyncPassIdentityGuard(
  inputs: SyncPassIdentityInputs
): SyncPassIdentityGuard {
  const capturedSourceKey = inputs.readLiveSourceKey();
  const isCurrentSourceIdentity = () =>
    inputs.isActivePass() && inputs.readLiveSourceKey() === capturedSourceKey;
  return {
    capturedSourceKey,
    isCurrentSourceIdentity,
    isCurrentSourceState: () => isCurrentSourceIdentity() && inputs.shouldRun(),
  };
}
