import {
  type CloudReadReadinessSnapshot,
  cloudReadLaneOwesWork,
  totalCloudReadDeadLettered,
  totalCloudReadItemsRemaining,
} from "../../shared/cloud-read-readiness-contract";
import { DesktopAuthStatus } from "../../shared/contracts";
import { SyncLaneDrainState } from "../../shared/sync-burndown-contract";

/**
 * Which app-core stack the desktop renderer runs (PLN-1138 D-E).
 *
 * The two modes are never unioned: a surface reads the local SQLite source or
 * the org-scoped cloud API, never both merged.
 *
 * Consumed by `DesktopAppCoreProvider` (PLN-1138 Phase 2): the mode selects the
 * per-mode QueryClient and the Sessions read source (cloud → the shared HTTP
 * source over the D-G bridge; local → the SQLite source over IPC), swapping them
 * together on a login / logout / connectivity change. The `scope`-keyed cache
 * keeps the two sets isolated. (Agent components, trace comments, and Dashboard
 * insights stay local in both modes until later phases migrate them.)
 */
export const DesktopAppCoreMode = {
  /**
   * Signed out, mid-sign-in, offline, or the local→cloud backlog has not drained
   * yet: read the local SQLite source over IPC. Also the
   * authenticated-but-offline degradation (PRD-461 D3 / AC-3.3) — own data from
   * the local DB rather than stale cloud rows.
   */
  Local: "local",
  /** Authenticated, online, and caught up: read the cloud API through the D-G fetch bridge. */
  Cloud: "cloud",
} as const;

export type DesktopAppCoreMode =
  (typeof DesktopAppCoreMode)[keyof typeof DesktopAppCoreMode];

/**
 * Why the reader is NOT on the cloud (ISS-5477), or why it is on the cloud
 * before the backlog finished.
 *
 * These are the distinctions `.claude/logical/` requires the UI to keep apart.
 * Collapsing "still uploading" into "nothing here" is precisely the defect: an
 * empty cloud result during a drain is UNKNOWN, never zero.
 */
export const CloudReadCutoverBlocker = {
  /** Signed out or mid-handshake. The cloud has no session to read under. */
  NotAuthenticated: "not_authenticated",
  /** Authenticated but offline — the pre-existing PRD-461 D3 degradation. */
  Offline: "offline",
  /**
   * The burn-down has not produced a sample yet (boot, no db host, reporter
   * stopped). Not knowing whether the cloud has the user's data is not the same
   * as knowing it does.
   */
  ReadinessUnknown: "readiness_unknown",
  /** The initial parse/import backlog is still running. */
  ImportPending: "import_pending",
  /** At least one sync lane is actively still owing the cloud work. */
  SyncDraining: "sync_draining",
  /**
   * A lane emptied its queue by GIVING UP. `drained_with_dead_letters` is not
   * caught up — cutting over on it silently loses exactly the rows that failed.
   */
  SyncGaveUp: "sync_gave_up",
  /**
   * No lane is actively draining, but at least one cannot establish that it owes
   * nothing: it is not running with work (or an unmeasurable remainder) still on
   * its books. An unmeasured remainder is not a zero remainder.
   */
  SyncNotEstablished: "sync_not_established",
} as const;
export type CloudReadCutoverBlocker =
  (typeof CloudReadCutoverBlocker)[keyof typeof CloudReadCutoverBlocker];

/**
 * The hysteresis latch (ISS-5477 acceptance: "new local work after a cutover
 * does not bounce the read source back and forth").
 *
 * **Policy: the cutover is one-way for the life of an authenticated session.**
 * Once the reader has legitimately reached the cloud, later local work — which
 * re-arms the burn-down to `draining`, exactly as ISS-5387 designed it to —
 * does NOT send it back to Local. Two reasons, and both are about not making
 * things worse:
 *
 *  1. **The failure mode is asymmetric.** Before the first drain the cloud holds
 *     nothing at all, so reading it shows an empty app. After it, the cloud has the
 *     corpus and is merely missing the newest rows — a staleness, not a
 *     disappearance. Bouncing back to Local to fix minutes-old staleness costs
 *     far more than it buys.
 *  2. **A mode flip is not free.** `DesktopAppCoreModeStack` rebuilds the
 *     QueryClient per mode, so every flip drops the cache and refetches from
 *     empty. Flapping between the two on every newly-captured session would make
 *     the app visibly worse than either steady state.
 *
 * The latch is dropped when the session ends (`NotAuthenticated` clears it), so
 * a sign-out / account switch re-arms the full gate for the next user. Going
 * offline does NOT clear it: the reader falls back to Local on connectivity
 * alone, and regaining it returns straight to the cloud rather than re-running a
 * gate that already passed.
 */
export const CloudReadCutoverLatch = {
  /** No cutover has happened yet this session. The gate is live. */
  None: "none",
  /** The backlog genuinely drained at least once. */
  Drained: "drained",
  /** The bounded fail-open tripped; the cutover happened WITHOUT a drain. */
  FailedOpen: "failed_open",
} as const;
export type CloudReadCutoverLatch =
  (typeof CloudReadCutoverLatch)[keyof typeof CloudReadCutoverLatch];

/**
 * How long the readiness fingerprint may stand completely still before the gate
 * fails open and lets the reader onto the cloud anyway.
 *
 * **Why a stall clock and not a wall clock.** ISS-5346 bounded its readiness
 * gates on elapsed time because the signals it waited for either arrive in
 * milliseconds or never. This backlog is not like that: a real first-run corpus
 * legitimately takes many minutes, and an elapsed-time bound would fire in the
 * middle of a healthy drain and put the user back on the empty cloud view this
 * ticket exists to remove. So the bound measures *absence of movement* instead —
 * see `cloudReadReadinessFingerprint`, which deliberately excludes the sample
 * timestamp so a re-stamped-but-identical sample cannot masquerade as progress
 * (the ISS-5347 "activity is not progress" lesson).
 *
 * **Why five minutes.** The burn-down samples once a minute, so anything under
 * ~3 samples cannot tell a slow lane from a wedged one. Five consecutive samples
 * with zero movement in ANY direction — no lane state change, no queue getting
 * shorter *or longer*, no import completing — is a wedge, a permanently
 * dead-lettered lane, or a lane whose gate will never open. Trading "data
 * disappears" for "stuck on Local forever" is not a fix, so at that point the
 * reader is let through with {@link CloudReadCutoverLatch.FailedOpen} recorded,
 * and the read-source badge says so: the cloud view may be incomplete, N items
 * are still local, and M were given up on.
 */
export const CLOUD_READ_CUTOVER_STALL_FAIL_OPEN_MS = 300_000;

/** The resolved read-source decision, and everything the UI needs to explain it. */
export type CloudReadCutoverDecision = {
  mode: DesktopAppCoreMode;
  /**
   * Why the cloud is not (or was not) fully ready. Non-null on Cloud too, when
   * the reader is there via the latch or the fail-open while work is still owed.
   */
  blocker: CloudReadCutoverBlocker | null;
  /** The reader is on the cloud WITHOUT the backlog having drained. */
  failedOpen: boolean;
  /** The latch to carry into the next evaluation. */
  latch: CloudReadCutoverLatch;
  /** Items still owed across every lane; `null` when a lane cannot measure its own. */
  itemsRemaining: number | null;
  /** Items every lane has collectively abandoned. */
  deadLetteredCount: number;
  /**
   * ISS-5714: the BACKLOG axis of the cutover on its own — "does the cloud hold
   * this machine's history?" — with connectivity deliberately excluded.
   *
   * `mode` answers a strictly narrower question: "should this renderer read the
   * cloud RIGHT NOW", which additionally folds in `isOnline`. Sessions wants
   * `mode`; Branches wants this, because its cache legitimately keeps serving
   * canonical cloud rows through an offline window (PLN-1138 D-E) and only the
   * backlog can make a cloud read WRONG rather than merely unreachable.
   *
   * Separating the two is what stops the surfaces disagreeing on the axis that
   * matters: before ISS-5714 Branches read the cloud on identity completeness
   * alone, so a still-draining machine rendered a populated `Local` Sessions
   * page beside an empty `Cloud (partial)` Branches page. Both now consult ONE
   * decision, so THE BACKLOG can never be answered two ways in one app.
   *
   * **That is a claim about the backlog axis only, deliberately.** Two narrower
   * axes can still put the surfaces on different stores, and neither is this
   * field's to settle: connectivity (Sessions drops to Local offline; Branches
   * keeps serving its cached cloud rows — see the caller) and identity
   * completeness (`canonicalBranchesIdentityKey` additionally requires an
   * organization id that `resolveCloudReadCutover` never looks at). Both are
   * covered as KNOWN-divergent states in `read-source-cross-surface-parity`.
   *
   * `false` whenever the cloud demonstrably does not have the corpus yet, and
   * whenever nobody is signed in. With no network the backlog cannot be
   * re-measured, so both offline paths report what this session already
   * established — `true` only if the reader had already REACHED the cloud, by a
   * drain or by the bounded fail-open (`latch !== None`; `FailedOpen` counts,
   * because the corpus is there either way and the shortfall is what
   * `failedOpen` itself announces). The compatibility fail-open for a preload
   * with no readiness channel applies ONLINE only, for the same reason: offline
   * with an empty cache it would park Branches on an unreachable cloud forever.
   */
  cloudHoldsHistory: boolean;
};

export type DesktopAppCoreModeInput = {
  /** Live main-process auth status, mirrored by `DesktopAuthProvider`. */
  status: DesktopAuthStatus;
  /**
   * Renderer connectivity. Phase 2 will source this from `navigator.onLine`,
   * which Chromium keeps current in the renderer (no IPC needed). Coarse by
   * construction: it reports whether the machine has a network interface, not
   * whether the cloud API is reachable. A cloud read that fails despite
   * `isOnline` still surfaces as a normal `ApiError` — this signal picks the
   * stack, it doesn't promise the request will succeed.
   */
  isOnline: boolean;
  /**
   * ISS-5477: the desktop→cloud backlog's readiness, projected from the ISS-5387
   * burn-down. `null` before the first IPC read resolves — which is UNKNOWN
   * readiness, so it keeps the reader local exactly like an undrained lane does.
   */
  readiness: CloudReadReadinessSnapshot | null;
  /**
   * True when this renderer's preload has no readiness channel at all, so a
   * reading can NEVER arrive — as opposed to `readiness: null`, which means one
   * has simply not arrived YET. Compatibility only: a renderer whose preload
   * predates the channel must not be stranded on Local waiting for an answer
   * that cannot come. Defaults to `false`.
   */
  readinessUnavailable?: boolean;
  /** The hysteresis latch carried from the previous evaluation. */
  latch: CloudReadCutoverLatch;
  /**
   * How long the readiness fingerprint has been unchanged, in ms. `null` before
   * any reading has been taken. Compared against
   * {@link CLOUD_READ_CUTOVER_STALL_FAIL_OPEN_MS}.
   */
  unchangedForMs: number | null;
};

/**
 * The single rule for which stack is active.
 *
 * Three conditions, and ISS-5477 added the third. Only a durable session
 * (`authenticated`) reaches the cloud: every transient sign-in status
 * (`opening_browser`, `awaiting_redirect`, `exchanging`) and every terminal
 * signed-out status (`signed_out`, `refresh_failed`, `loading`) stays local, so
 * the stack never flips mid-handshake. Mirrors the token rule in
 * `DesktopAuthProvider` — the auth port surfaces a token only when
 * `authenticated`, so no other status could authenticate a cloud read anyway.
 *
 * The third condition is the fix for "signing in makes a user's data
 * disappear": authentication moved the read source to a cloud that had not yet
 * received a single row, so a populated app became an empty one and stayed
 * unusable until the upload backlog drained. Authentication alone is no longer
 * sufficient — see {@link resolveCloudReadCutover}.
 */
export function resolveDesktopAppCoreMode(
  input: DesktopAppCoreModeInput
): DesktopAppCoreMode {
  return resolveCloudReadCutover(input).mode;
}

/**
 * The full read-source decision: the mode plus why.
 *
 * Order is load-bearing, and mirrors `classifyLaneDrainState`'s discipline:
 * liveness before queue depth, and "gave up" never reported as "caught up".
 */
export function resolveCloudReadCutover(
  input: DesktopAppCoreModeInput
): CloudReadCutoverDecision {
  const totals = readinessTotals(input.readiness);

  if (input.status !== DesktopAuthStatus.Authenticated) {
    // Ending the session drops the latch: the next user gets the full gate.
    return {
      mode: DesktopAppCoreMode.Local,
      blocker: CloudReadCutoverBlocker.NotAuthenticated,
      failedOpen: false,
      latch: CloudReadCutoverLatch.None,
      // No cloud identity, so there is no workspace copy to speak of.
      cloudHoldsHistory: false,
      ...totals,
    };
  }

  // A preload without the readiness channel can never answer, so holding this
  // renderer on Local would strand it there rather than merely delay it to the
  // stall fail-open. Fail open immediately to the pre-channel behaviour.
  if (input.readinessUnavailable) {
    return {
      mode: input.isOnline
        ? DesktopAppCoreMode.Cloud
        : DesktopAppCoreMode.Local,
      blocker: input.isOnline ? null : CloudReadCutoverBlocker.Offline,
      failedOpen: false,
      // ISS-5714: RECORD the cutover this branch performs. Reaching the cloud
      // here is a fail-open by definition — no drain was ever measured, because
      // this preload cannot measure one — and leaving the latch at `None` meant
      // the one bit of history this path produces was thrown away, so a later
      // evaluation could not tell "already reading the cloud" from "never got
      // there". Only the online pass cuts over, so only it latches.
      latch: input.isOnline ? CloudReadCutoverLatch.FailedOpen : input.latch,
      // Compatibility fail-open: a preload that can never answer must not
      // strand Branches on Local any more than it strands the mode — but only
      // while online, or once this session already reached the cloud (the latch
      // above), in which case its cache is warm and worth keeping. An offline
      // COLD start has neither: claiming the cloud holds the history there
      // parks Branches on a paused, empty read beside a populated Sessions
      // page, which is this ticket's exact symptom via the compatibility path.
      cloudHoldsHistory:
        input.isOnline || input.latch !== CloudReadCutoverLatch.None,
      ...totals,
    };
  }

  if (!input.isOnline) {
    // The pre-existing offline degradation, unchanged. The latch survives so
    // regaining connectivity returns straight to the cloud.
    return {
      mode: DesktopAppCoreMode.Local,
      blocker: CloudReadCutoverBlocker.Offline,
      failedOpen: false,
      latch: input.latch,
      // The backlog cannot be re-measured with no network, so report what this
      // session already established rather than guessing in either direction.
      cloudHoldsHistory: input.latch !== CloudReadCutoverLatch.None,
      ...totals,
    };
  }

  const blocker = resolveBacklogBlocker(input.readiness);
  if (blocker === null) {
    return {
      mode: DesktopAppCoreMode.Cloud,
      blocker: null,
      failedOpen: false,
      latch: CloudReadCutoverLatch.Drained,
      cloudHoldsHistory: true,
      ...totals,
    };
  }

  if (input.latch !== CloudReadCutoverLatch.None) {
    // Hysteresis: this session already reached the cloud. New local work does
    // not send it back.
    return {
      mode: DesktopAppCoreMode.Cloud,
      blocker,
      failedOpen: input.latch === CloudReadCutoverLatch.FailedOpen,
      latch: input.latch,
      // Already cut over this session: the cloud holds the corpus and is merely
      // missing the newest rows (see `CloudReadCutoverLatch`).
      cloudHoldsHistory: true,
      ...totals,
    };
  }

  if (
    input.unchangedForMs !== null &&
    input.unchangedForMs >= CLOUD_READ_CUTOVER_STALL_FAIL_OPEN_MS
  ) {
    return {
      mode: DesktopAppCoreMode.Cloud,
      blocker,
      failedOpen: true,
      latch: CloudReadCutoverLatch.FailedOpen,
      // The bounded fail-open puts every surface on the cloud together; being
      // short there is what `failedOpen` itself announces.
      cloudHoldsHistory: true,
      ...totals,
    };
  }

  return {
    mode: DesktopAppCoreMode.Local,
    blocker,
    failedOpen: false,
    latch: CloudReadCutoverLatch.None,
    // The measured backlog says the cloud does NOT have this machine's history
    // yet. Every surface stays local together — the ISS-5714 parity invariant.
    cloudHoldsHistory: false,
    ...totals,
  };
}

/**
 * Which backlog condition blocks the cutover, or `null` when the cloud genuinely
 * holds what this machine has.
 *
 * Precedence is deliberate: an actively draining lane is the most accurate thing
 * to say, a lane that gave up is the most important, and "cannot establish"
 * covers the rest. Only `drained` clears.
 */
function resolveBacklogBlocker(
  readiness: CloudReadReadinessSnapshot | null
): CloudReadCutoverBlocker | null {
  if (readiness === null || readiness.sampledAtIso === null) {
    return CloudReadCutoverBlocker.ReadinessUnknown;
  }
  if (!readiness.importComplete) {
    return CloudReadCutoverBlocker.ImportPending;
  }
  if (readiness.lanes.length === 0) {
    // A sample that measured no lanes has not established that nothing is owed.
    return CloudReadCutoverBlocker.SyncNotEstablished;
  }

  let sawGaveUp = false;
  let sawNotEstablished = false;
  for (const lane of readiness.lanes) {
    if (lane.state === SyncLaneDrainState.Draining) {
      return CloudReadCutoverBlocker.SyncDraining;
    }
    if (lane.state === SyncLaneDrainState.DrainedWithDeadLetters) {
      sawGaveUp = true;
      continue;
    }
    if (lane.state === SyncLaneDrainState.RemainingUnknown) {
      sawNotEstablished = true;
      continue;
    }
    if (laneIsStoppedWithWorkOutstanding(lane)) {
      sawNotEstablished = true;
    }
  }
  if (sawGaveUp) {
    return CloudReadCutoverBlocker.SyncGaveUp;
  }
  return sawNotEstablished ? CloudReadCutoverBlocker.SyncNotEstablished : null;
}

/**
 * A lane that is not running blocks the cutover only when it still has work — or
 * cannot say whether it does.
 *
 * `never_started` / `idle_not_running` with a measured, empty queue owes the
 * cloud nothing, and waiting for a lane whose gate is shut (transcript upload
 * turned off, a closed org policy) would wait forever. But a stopped lane
 * holding rows is stranded local work, and a stopped lane that cannot measure
 * its remainder is unknown — both must keep the reader local until the bounded
 * fail-open decides otherwise.
 */
function laneIsStoppedWithWorkOutstanding(lane: {
  state: SyncLaneDrainState;
  itemsRemaining: number | null;
  deadLetteredCount: number;
  unmeasuredRows: number;
}): boolean {
  const stopped =
    lane.state === SyncLaneDrainState.NeverStarted ||
    lane.state === SyncLaneDrainState.IdleNotRunning;
  if (!stopped) {
    return false;
  }
  // ISS-5768: the "does this lane owe anything" half is now the shared
  // predicate, so the cutover gate and the History Sync indicator cannot drift
  // into disagreeing about what an owed item is.
  return cloudReadLaneOwesWork(lane);
}

function readinessTotals(readiness: CloudReadReadinessSnapshot | null): {
  itemsRemaining: number | null;
  deadLetteredCount: number;
} {
  if (readiness === null) {
    return { itemsRemaining: null, deadLetteredCount: 0 };
  }
  return {
    itemsRemaining: totalCloudReadItemsRemaining(readiness),
    deadLetteredCount: totalCloudReadDeadLettered(readiness),
  };
}
