/**
 * @file retained-compute-target-identity.ts
 * @description ISS-8691: the compute-target identity the session sync lane
 * sends under, retained across a socket drop.
 *
 * Identity is hello-derived (PLN-1437 D6), so before this the lane could only
 * name a target while the socket was up — `cloudStatus.state === "online"`. On a
 * client whose socket flaps that is most of the time: the 2026-08-31 incident
 * measured one target holding a connection for 44.7s and then re-dialling ~15
 * minutes later, ~36 times a day, because the relay was tearing it down on
 * `ping timeout`. The data write itself is an ordinary authenticated HTTP POST
 * and needs none of that, so a healthy HTTP path sat idle waiting on a socket
 * that was down — sessions reached the cloud 15-60 minutes late (p50 7.5 min /
 * p90 46.6 min against a 0.1 / 3.4 baseline).
 *
 * The id is retained, never invented: only a value the cloud actually handed us
 * is ever returned. It is bound to the identity that minted it — ISS-8702:
 * user + organization + apiOrigin + targetId — and re-checked on every read, so
 * an account switch, a sign-out, or an environment switch invalidates it without
 * any subscription to get wrong — the mismatch IS the reset. That matters because
 * the alternative (clearing on an auth event) fails open: a missed event leaves
 * one account's target id in place while another account is signed in, which is
 * exactly what `main/sync/AGENTS.md` invariant 2 forbids.
 *
 * That check covers the LIVE id as well as the retained one (davetho, #6351).
 * Identity is hello-derived, and an account switch is precisely the event that
 * produces no new hello, so "the socket is up" was never evidence that the id on
 * it belongs to whoever is signed in now. The binding is what decides — and the
 * adapter below adopts an unattributed live id the first time it CAN attribute
 * one, because a hello can land before first-party auth and a connection left
 * unbound darks the lane on its first drop.
 *
 * A retained id can still be STALE — the target could have been revoked while we
 * were offline. That case is already terminal-safe: the server's ownership check
 * answers `target_not_owned`, which defers with every retry budget intact and
 * never dead-letters (`agent-session-sync-rejection-dispatch.ts`). So the cost of
 * a stale id is one rejected batch, and the cost of having no id at all was every
 * batch for the length of the outage.
 *
 * ISS-8702 — the apiOrigin half. Marisol, 2026-08-31: "Retain identity as user +
 * organization + apiOrigin + targetId. When apiOrigin changes, invalidate the
 * retained target ID and resolve/register a target against the new origin; never
 * present an ID minted by origin A to origin B."
 *
 * The origin is stored WITH the id at the hello that minted it, never re-read at
 * resolve time, and that ordering is the whole point. Two windows need it, one
 * durable and one narrow. DURABLE: after an environment switch the RETAINED id
 * is all the lane has until the socket reconnects — and if it never does (no
 * credential for the new origin, or it is unreachable) that is indefinite.
 * NARROW: `restartCloudSocket()` calls `agentSessionSync.refresh()` BEFORE
 * `cloudSocket.restart()`, and settings already say origin B by then, so that
 * one synchronous refresh reads the last ONLINE status — which still names
 * origin A's target. `restart()` clears it a moment later (`stop()`, then
 * `start()`, which reaches `notifyStatus({ state: "idle" })` before its first
 * await), so the stale live status is real but brief; the retained one is not.
 * In both windows a resolver that re-read the origin from settings would stamp
 * A's id as B's and hand it over; comparing against the key the id was MINTED
 * under sees it for what it is.
 *
 * WHAT THIS SCOPES, exactly: `resolve`, and therefore the adapter's
 * `computeTargetId` — the session lane's write target and the Sessions list's
 * outbox key — and, since ISS-9003, `cloudReadComputeTargetId`'s persisted
 * fallback. It does NOT scope `onlineComputeTargetId`, a raw strict-online read
 * with eight other consumers whose only exposure is the narrow window above.
 *
 * ISS-9003 — the persisted half. The saved `lastComputeTargetId` recorded no
 * origin, so the one window `resolve` cannot see stayed open: after a restart
 * nothing is retained in memory, the saved id is all the persisted-fallback
 * accessor has, and an environment switch made it present origin A's id to origin B for
 * as long as the profile stayed pointed at B. The saved config now carries the
 * minting key beside the id (`lastComputeTargetEnvironmentKey`), stamped by the
 * same `remember` that records the in-memory one so the two cannot disagree, and
 * `persistedTargetForOrigin` applies the same refusal. `remember` RETURNS that
 * pair rather than letting a caller assemble it, because an id persisted apart
 * from its key is precisely the defect.
 *
 * Invalidation is by REPLACEMENT, not by clearing: the foreign record is the
 * evidence, so dropping it would let the very next read re-adopt that same stale
 * live id under the new origin. The reconnect that an origin change already
 * triggers registers a target against the new origin, and the hello that hands
 * back a DIFFERENT id is what replaces the record — so where the profile moves
 * both origins together the mismatch is a transient refusal with a resolution
 * path behind it.
 *
 * Only a different id, though (whitlockk, #6527). The relay mints against its own
 * environment and `relayOrigin` is a separate setting — so an apiOrigin-only
 * save restarts that same socket and re-acks the same id. `remember` therefore
 * keeps the recorded minting key on a re-ack instead of stamping the current
 * origin on it. An install left pointed at relay A while its apiOrigin says B
 * never receives a B-minted id, and the refusal there lasts as long as that
 * pairing does — which is the invariant, not a gap in it: repointing
 * `relayOrigin` at B is what mints a target B owns.
 *
 * ISS-9081 — the ack now STATES its minting origin, so that whole paragraph is
 * the fallback rather than the rule. `mintingApiOrigin` (`compute-target.ts`)
 * carries the API that actually resolved the target — the relay's
 * `CLOSEDLOOP_API_URL`, or the direct API server's own `NEXT_PUBLIC_API_URL`
 * (ISS-9152) — and where it is present it is recorded verbatim, outranking
 * both the current origin and the re-ack heuristic above. That closes the leak
 * #6527 could only name: a re-register INSIDE origin A hands back a fresh
 * A-minted id that the different-id heuristic read as a registration against
 * B. The field is optional in both directions — an older sender states nothing
 * and an older desktop drops it — so its absence has to leave every branch
 * below exactly as
 * it was, and an origin too malformed to name is treated as no statement rather
 * than as a null key, which would be "elsewhere" to every origin and dark the
 * lane indefinitely.
 *
 * The identity-null windows (a hello before first-party auth, and signed out)
 * can compute the origin half of that key but not the account half, so the
 * origin half is enforced there and the account half defers to the adoption in
 * `resolve`. The lane is NOT darked in those windows: the live hello-derived id
 * is returned exactly as it was before this ticket, and only the RETAINED id —
 * which already required an identity — stays unavailable until one exists.
 */

import type { DesktopAuthStatus, SavedConfig } from "../../shared/contracts.js";
import { normalizeEnvironmentKey } from "../../shared/environment-key.js";
import {
  type CloudSocketStatus,
  type OnlineCloudSocketStatus,
  resolveOnlineComputeTargetId,
} from "../cloud/cloud-protocol.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  type SignedInUserIdentity,
  sameUserIdentity,
} from "../util/user-identity.js";
import { isHttpAgentSessionSyncReady } from "./agent-session-sync-transport.js";

export type RetainedComputeTargetIdentity = {
  /**
   * Record the target id the cloud just handed us, bound to the identity that
   * minted it: the account, and the environment key of the origin it came from.
   * An id with no account attached is recorded but never handed out — the record
   * is what makes it recognisable as origin A's later.
   *
   * ISS-9081: `mintingApiOrigin` is the origin the ACK stated, and it wins over
   * `apiOrigin` — the one we happen to be pointed at — whenever it is present
   * and nameable. Absent (an older sender, or one that cannot name its own API)
   * the recording is exactly what it was before that field existed.
   */
  remember(
    identity: SignedInUserIdentity | null,
    apiOrigin: string,
    targetId: string,
    mintingApiOrigin?: string
  ): string | null;
  /**
   * The compute target the sync lane should send under: the live id, else the
   * retained one — and in both cases only when it was minted against the origin
   * we are talking to now AND belongs to the identity signed in right now.
   *
   * NOT pure: adopting an unattributed live id happens here, and deliberately
   * so. Adoption must run AFTER the origin gate or it re-stamps a foreign id
   * with the environment we are talking to now, and an `adopt()` the caller had
   * to sequence itself is exactly how that ordering gets lost — it is the shape
   * this module already had, one layer up, when the gate was added.
   */
  resolve(
    identity: SignedInUserIdentity | null,
    apiOrigin: string,
    onlineTargetId: string | null
  ): string | null;
  /**
   * ISS-11467: why the LAST {@link RetainedComputeTargetIdentity.resolve} refused
   * a live id, or null when it did not refuse one.
   *
   * Recorded BY `resolve` rather than re-derived by a second predicate, because
   * the two gates it reports on are stateful and ordered — a copy of them here
   * would be a second source of truth for "owned" and would drift the moment
   * either gate moved.
   *
   * It exists because the refusals the local guard absorbs are the ones ISS-11426
   * used to learn about from the server's 403, and a caller that wants to keep
   * offering the relink needs to tell a FOREIGN ACCOUNT (relinking is the remedy)
   * from an ISS-8702 origin mismatch (transient, and relinking would do nothing).
   */
  lastLiveTargetRefusal(): ComputeTargetRefusalReason | null;
  /** Drop the retained id (cloud egress disabled, or a hard reset). */
  forget(): void;
};

export function createRetainedComputeTargetIdentity(): RetainedComputeTargetIdentity {
  /**
   * The retained target and the identity it was minted under. `identity` is null
   * in the hello-before-auth and signed-out windows; `environmentKey` is not,
   * which is why the origin half of the key is enforceable there and the account
   * half is not. A null `environmentKey` is an UNPARSEABLE apiOrigin — absent,
   * not a value, and so never equal to another absent one.
   */
  let retained: {
    identity: SignedInUserIdentity | null;
    environmentKey: string | null;
    targetId: string;
  } | null = null;
  /**
   * The recorded id was minted somewhere other than the environment we are
   * talking to now. An unknown origin counts as elsewhere: two different
   * unparseable origins both normalize to null, and treating that as a match
   * would disable this gate exactly when we cannot name the environment.
   */
  const isMintedElsewhere = (environmentKey: string | null): boolean =>
    retained !== null &&
    (environmentKey === null || retained.environmentKey !== environmentKey);
  /** Already attributed to an account, so re-binding would re-attribute it. */
  const isIdentityBound = (targetId: string): boolean =>
    retained?.targetId === targetId && retained.identity !== null;
  /**
   * ISS-11467: the reason the most recent `resolve` refused a live id. A single
   * slot, overwritten on every resolve including the ones that refuse nothing, so
   * it always describes the read a caller just made rather than an older one.
   */
  let lastRefusal: ComputeTargetRefusalReason | null = null;
  const belongsToAnotherAccount = (
    identity: SignedInUserIdentity | null
  ): boolean =>
    retained?.identity != null &&
    identity != null &&
    !sameUserIdentity(retained.identity, identity);
  return {
    remember(identity, apiOrigin, targetId, mintingApiOrigin) {
      const previous = retained;
      const currentKey = normalizeEnvironmentKey(apiOrigin);
      // ISS-9081: the stated minting origin, when the sender stated a nameable
      // one. This is the whole point of the field — every branch below is a
      // heuristic standing in for a fact the ack could not carry, so a stated
      // origin supersedes all of them, re-ack included.
      //
      // An unparseable one degrades to absent rather than being recorded as
      // null: a null key is "elsewhere" to every origin, so recording it would
      // dark the lane indefinitely because a peer spelled a field oddly, which
      // the cross-repo rule forbids.
      const statedKey = mintingApiOrigin
        ? normalizeEnvironmentKey(mintingApiOrigin)
        : null;
      // A peer that states an origin we cannot parse is the one case here that
      // is neither "no statement" nor a usable one, and swallowing it makes a
      // relay misconfiguration indistinguishable from an older build. Logged at
      // `remember` rather than at the refusal in `resolve`, which runs on every
      // lane tick; this runs once per hello.
      //
      // Truncated AND `JSON.stringify`d because the value is unbounded,
      // unvalidated peer input on its way into a line-oriented sink (whitlockk,
      // #6587): raw, an embedded newline forges a log line and an embedded
      // ESC rewrites the console around it. `JSON.stringify` escapes every
      // C0 control, the quote, and the backslash, so the origin lands as one
      // inert, quoted token that still reads as what the peer actually sent.
      if (mintingApiOrigin && statedKey === null) {
        gatewayLog.warn(
          "agent-sync",
          `hello ack stated an unparseable mintingApiOrigin, falling back to the current origin: targetId=${targetId}, stated=${JSON.stringify(mintingApiOrigin.slice(0, 100))}`
        );
      }
      // ISS-9081 (marisolashgrove, #6587): the DISAGREEMENT gets a line too, and it
      // is the one that ends in a dark lane. A stated origin that is not the one
      // this profile posts to makes `resolve` refuse the target it just recorded
      // — `isMintedElsewhere` is true and the live id IS the recorded one — for
      // as long as the pairing lasts. Unlike the ISS-8702 refusal it warns
      // beside, no operator action need precede it: the relay's
      // `CLOSEDLOOP_API_URL` and this profile's `apiOrigin` are set
      // independently, so a redeploy on either side can open it. Both halves are
      // in hand here, once per hello, which is the difference between grepping
      // one line and reproducing a stalled sync lane from scratch.
      //
      // Compared as KEYS, not as raw strings, so a differing spelling of the
      // same environment (case, a trailing slash, a default port) is not noise.
      if (statedKey !== null && statedKey !== currentKey) {
        gatewayLog.warn(
          "agent-sync",
          `hello ack stated a minting origin this profile does not post to, so the target is refused until they agree: targetId=${targetId}, stated=${JSON.stringify(statedKey)}, current=${JSON.stringify(currentKey)}`
        );
      }
      // ISS-8702 (whitlockk, #6527): with NO stated origin, a re-ack of an id we
      // ALREADY hold is the same target from the same relay, not a registration
      // against a new origin — the relay resolves against its OWN environment
      // (`CLOSEDLOOP_API_URL`) and `relayOrigin` is a separate setting, so an
      // apiOrigin-only profile save restarts that same socket and re-acks the
      // same id. Stamping the current origin on it there would launder origin
      // A's id as origin B's, which is the presentation ISS-8702 refuses.
      //
      // A DIFFERENT id was the only re-stamp signal an unstated ack afforded,
      // and it is a heuristic, not proof of a new environment (marisolashgrove,
      // #6527): `resolveRelayHelloTarget` falls through from `updateOwned(id,
      // org, user)` to `register()` whenever that misses — row deleted
      // cloud-side, org switch, changed machineName — minting a fresh id in the
      // SAME environment. `statedKey` above is what settles that case when the
      // relay names its origin; this branch is what happens when it does not.
      const reAcked =
        previous !== null && previous.targetId === targetId ? previous : null;
      retained = {
        // ISS-8691: a null identity must never ERASE an account binding. A hello
        // can re-land while signed out — the socket carries its own credential —
        // and dropping the owner there let the NEXT account adopt the previous
        // account's target, which is the cross-account path this module exists to
        // close. It may still record the origin, which needs no account.
        identity: identity ?? reAcked?.identity ?? null,
        environmentKey:
          statedKey ?? (reAcked ? reAcked.environmentKey : currentKey),
        targetId,
      };
      // ISS-9003: the key this ladder settled on, so the saved config can be
      // stamped with the same answer instead of re-deriving it and drifting.
      return retained.environmentKey;
    },
    resolve(identity, apiOrigin, onlineTargetId) {
      const environmentKey = normalizeEnvironmentKey(apiOrigin);
      // ISS-8702: the origin gate, and it runs FIRST — before the adoption
      // below, which would otherwise re-stamp a foreign id with the environment
      // we are talking to now. It gates the LIVE id too whenever that id is the
      // recorded one, because the refresh `restartCloudSocket()` fires before
      // restarting the socket still reads origin A's online status. The refusal
      // is transient: the reconnect that same switch triggers replaces this
      // record with one minted under the new origin. A live id we have NEVER
      // recorded is not covered — the adoption below supersedes the foreign
      // record with it, on the same DIFFERENT-id heuristic `remember` uses and
      // carrying the same residual: a same-environment re-register is adopted
      // under the current origin rather than refused.
      //
      // ISS-9081: the adoption below has no ack to read, so it can only stamp
      // the current origin — and `onCloudSocketStatus` refreshes the sync lanes
      // BEFORE it calls `remember`, so one resolve per online transition reaches
      // a brand-new id ahead of its statement. That is why a stated origin has
      // to overrule the re-ack branch in `remember` rather than defer to it: the
      // record it corrects is often one this adoption just wrote. The window is
      // that single read, and the id it hands back is refused from the next one
      // on.
      if (
        isMintedElsewhere(environmentKey) &&
        (onlineTargetId === null || onlineTargetId === retained?.targetId)
      ) {
        lastRefusal = ComputeTargetRefusalReason.MintedElsewhere;
        return null;
      }
      // ISS-8691 (davetho, #6351): a hello can land BEFORE first-party auth —
      // the socket authenticates on its own credential — so the eager bind in
      // `onCloudSocketStatus` has no one to attribute the id to. Left that way,
      // the connection is never account-bound and the FIRST drop darks the lane
      // until another hello: the outage this module exists to end, reached by a
      // different door. Adopting it on the first read that HAS an identity fixes
      // that, and cannot widen anything — while the socket is up this id is what
      // the lane already sends under.
      //
      // Only when it is not already account-bound. Re-binding on every read
      // would re-attribute a live target to whoever signed in most recently,
      // which is exactly the cross-account case the check below refuses.
      if (onlineTargetId && !isIdentityBound(onlineTargetId)) {
        retained = { identity, environmentKey, targetId: onlineTargetId };
      }
      // ISS-8691 (davetho, #6351): the owner check gates the LIVE id too. It
      // used to sit behind an early `return onlineTargetId`, so an account
      // switch that left the socket up kept naming the previous account's hello
      // target until the next hello — identity is hello-derived, and no hello is
      // what an account switch produces. The server refuses that batch as
      // `target_not_owned` so nothing crosses accounts, but the new account paid
      // a deferral per batch for a mismatch visible right here.
      //
      // Only a KNOWN-foreign id is refused: with no account recorded we cannot
      // say who the live id belongs to, and guessing "not this account" there
      // would dark the lane on the ordinary hello-before-auth start-up.
      if (belongsToAnotherAccount(identity)) {
        lastRefusal = ComputeTargetRefusalReason.ForeignAccount;
        return null;
      }
      lastRefusal = null;
      if (onlineTargetId) {
        return onlineTargetId;
      }
      return retained?.identity && identity ? retained.targetId : null;
    },
    lastLiveTargetRefusal() {
      return lastRefusal;
    },
    forget() {
      retained = null;
      lastRefusal = null;
    },
  };
}

/** The live application state this adapter re-reads on every call. */
export type SessionSyncIdentitySources = {
  /** The signed-in account, or null when signed out. */
  getIdentity: () => SignedInUserIdentity | null;
  getAuthStatus: () => DesktopAuthStatus;
  /**
   * ISS-8702: the environment being talked to right now. Read live on every
   * resolve so a switch is seen immediately; the origin a target was MINTED
   * under is the one stored with it, and it is the two that are compared.
   */
  getApiOrigin: () => string;
  /** Live relay connection state; the hello-derived target lives on it. */
  getCloudStatus: () => CloudSocketStatus;
};

export type SessionSyncIdentityAdapter = {
  /** The compute target the session lane writes under, live or retained. */
  computeTargetId(): string | null;
  /**
   * ISS-9164 (whitlockk, #6867): the same target, but only while an account is
   * actually signed in.
   *
   * `computeTargetId` deliberately hands back the LIVE hello-derived id through
   * the identity-null windows — the socket carries its own credential, so a
   * hello can land before first-party auth and the sync lane must not dark on
   * it. A caller that stamps the id on an UNAUTHENTICATED request cannot take
   * that trade: there is no session behind the request to scope it, so the id
   * would outlive the one it belonged to. Signed out this resolves null, which
   * the updater feed reads as the general ring.
   */
  authenticatedComputeTargetId(): string | null;
  /** Strict-online hello-derived target: non-null only while the socket is up. */
  onlineComputeTargetId(): string | null;
  /**
   * Cloud reads run while the relay socket is reconnecting, so this falls back
   * to the profile-scoped last-known target — they still need one for the API to
   * resolve local session ids to cloud artifacts.
   *
   * ISS-9003: it takes the persisted PAIR, not a bare id, so the fallback cannot
   * be handed an id without the origin that minted it. Null when the saved key
   * does not name the environment this profile posts to now.
   */
  cloudReadComputeTargetId(
    persisted: PersistedComputeTarget | null
  ): string | null;
  /** Lane-1 readiness: a live session plus a nameable compute target. */
  isHttpReady(): boolean;
  /**
   * ISS-8687: the three identity reads `observability-lane-router.ts` gates on,
   * supplied together because they must agree. `isHttpReady` already answers
   * from the RETAINED id, so pairing it with a resolver drawn from a different
   * source is what produces a gate that reports ready while the id resolves
   * null — the spin this module exists to prevent, one lane over.
   *
   * `getRetainedComputeTargetId` is this module's live-else-retained
   * `computeTargetId`, not a retained-only read; it is named for the guarantee
   * the router needs (an id that survives a socket drop), and the superset is
   * deliberate.
   */
  observabilityLaneIdentity(): {
    isHttpReady: () => boolean;
    getComputeTargetId: () => string | null;
    getRetainedComputeTargetId: () => string | null;
  };
  /**
   * Bind a freshly hello-derived target to the account signed in now and the
   * origin that minted it. Called from the online transition, which is the one
   * moment both are known to describe this id.
   *
   * Takes the online status rather than a bare id so the ack's stated minting
   * origin (ISS-9081) travels with the id it describes; separating them is how
   * a caller ends up stamping one id with another's origin.
   *
   * ISS-9003: and it RETURNS what the saved config must store — the id plus the
   * key this bind settled on — for the mirror-image reason. A caller that
   * assembled that pair itself would be re-deriving the origin half, which is
   * how the durable copy ends up disagreeing with the in-memory one.
   */
  remember(
    online: Pick<OnlineCloudSocketStatus, "targetId" | "mintingApiOrigin">
  ): PersistedComputeTarget;
  /**
   * ISS-11467: why the last {@link SessionSyncIdentityAdapter.computeTargetId}
   * refused a live id, or null when it did not. See the inner method for why this
   * is recorded rather than re-derived, and why the two reasons must stay apart.
   */
  lastLiveTargetRefusal(): ComputeTargetRefusalReason | null;
  /** Drop the retained target (cloud egress disabled, or a hard reset). */
  forget(): void;
};

/**
 * The one owner of "which compute target does the session sync lane write
 * under, and may it write at all". Kept together because the two answers must
 * agree: a readiness predicate that says yes while the id resolver says null
 * spins the lane, and one that says no while an id is available is the ISS-8691
 * defect itself. Callers hold this instead of re-deriving either half.
 */
export function createSessionSyncIdentityAdapter(
  sources: SessionSyncIdentitySources
): SessionSyncIdentityAdapter {
  const retained = createRetainedComputeTargetIdentity();
  const online = () => resolveOnlineComputeTargetId(sources.getCloudStatus());
  const computeTargetId = () =>
    retained.resolve(sources.getIdentity(), sources.getApiOrigin(), online());
  const isHttpReady = () =>
    isHttpAgentSessionSyncReady({
      authStatus: sources.getAuthStatus(),
      hasComputeTargetIdentity: computeTargetId() !== null,
    });
  // `isHttpReady` is already exactly "an account is signed in AND a target
  // resolves", so the gate is read from it rather than re-derived here; the
  // second `computeTargetId()` is the same idempotent read (its adoption is
  // no-op once bound), not a second derivation of the answer.
  const authenticatedComputeTargetId = () =>
    isHttpReady() ? computeTargetId() : null;
  return {
    computeTargetId,
    authenticatedComputeTargetId,
    onlineComputeTargetId: online,
    cloudReadComputeTargetId: (persisted) =>
      online() ?? persistedTargetForOrigin(persisted, sources.getApiOrigin()),
    isHttpReady,
    observabilityLaneIdentity: () => ({
      isHttpReady,
      getComputeTargetId: online,
      getRetainedComputeTargetId: computeTargetId,
    }),
    remember: (online) => ({
      lastComputeTargetId: online.targetId,
      lastComputeTargetEnvironmentKey: retained.remember(
        sources.getIdentity(),
        sources.getApiOrigin(),
        online.targetId,
        online.mintingApiOrigin
      ),
    }),
    lastLiveTargetRefusal: () => retained.lastLiveTargetRefusal(),
    forget: () => retained.forget(),
  };
}

/**
 * ISS-9003: the two saved-config fields the persisted fallback reads, taken
 * together. An id and the origin it was minted under are one fact, and the
 * defect this closes is exactly what happens when a caller can pass the first
 * without the second.
 */
export type PersistedComputeTarget = Pick<
  SavedConfig,
  "lastComputeTargetId" | "lastComputeTargetEnvironmentKey"
>;

/**
 * ISS-9003: the persisted fallback, gated by the origin the id was minted under
 * — the same rule `resolve` applies to the retained id, reaching the window
 * `resolve` structurally cannot: after a restart there is no in-memory record to
 * compare against, so a saved id with no origin of its own was presented to
 * whatever environment the profile happened to be pointed at.
 *
 * An UNSTAMPED saved config (written before the field existed, or by a build
 * that never set it) is REFUSED, not trusted once. Both readings were open and
 * this one is chosen deliberately: the cost of refusing is bounded and
 * self-healing — the next hello stamps the pair and the fallback returns, so it
 * lasts one reconnect — while the cost of
 * trusting is a cross-environment write that looks correct. It also keeps ONE
 * rule instead of two, since `isMintedElsewhere` already reads an unnameable
 * origin as elsewhere.
 *
 * Both sides go through `normalizeEnvironmentKey`, so a profile that saved a raw
 * origin rather than a key — a differing spelling, a trailing slash, a default
 * port — is not refused for having moved when it did not. Anything unnameable
 * normalizes to null, and null is never equal to a nameable current key, so the
 * fail direction is closed.
 *
 * It is NOT the type check for a value that is JSON off disk, though: `new URL()`
 * stringifies its argument, so a non-string stamp can still normalize to a real
 * key (whitlockk, #7142). That is rejected at the load boundary instead —
 * `sanitizeSavedConfig` drops a pair with a non-string half — so what reaches
 * here is the string-or-absent the parameter type already claims.
 */
function persistedTargetForOrigin(
  persisted: PersistedComputeTarget | null,
  apiOrigin: string
): string | null {
  const currentKey = normalizeEnvironmentKey(apiOrigin);
  const mintedKey = normalizeEnvironmentKey(
    persisted?.lastComputeTargetEnvironmentKey
  );
  if (currentKey === null || mintedKey !== currentKey) {
    return null;
  }
  return persisted?.lastComputeTargetId ?? null;
}

/**
 * ISS-11467: why a live compute target was refused locally, when it was.
 *
 * The two must never be folded together. `ForeignAccount` is the condition
 * ISS-11426's relink exists for — this machine is presenting a target the signed-in
 * account does not own, and the person can fix it. `MintedElsewhere` is the
 * ISS-8702 origin gate, which is transient by construction (the reconnect the
 * same profile change triggers replaces the record) and which relinking would not
 * change; offering a relink for it would be a prompt for a condition that clears
 * itself.
 */
export const ComputeTargetRefusalReason = {
  ForeignAccount: "foreign_account",
  MintedElsewhere: "minted_elsewhere",
} as const;
export type ComputeTargetRefusalReason =
  (typeof ComputeTargetRefusalReason)[keyof typeof ComputeTargetRefusalReason];
