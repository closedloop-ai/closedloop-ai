/**
 * @file ISS-9420 (PRD-699) — failure-injection conformance harness for the
 * approved classification standard (PRD-699 Appendix A,
 * `session-sync-classification-verdicts.md`, ratified 2026-08-28).
 *
 * WHAT THIS PROVES. For each desktop→cloud lane the standard names, an HTTP
 * failure is injected into that lane's REAL client — the same factory
 * production wires, with `fetch` replaced — and the behavior class is read off
 * what the lane's own dispatch returned. Nothing here inspects a policy
 * `Record`, a status set, or a source file: a lane that names the right class
 * in a table its dispatch never consults fails these tests, and a lane whose
 * dispatch collapsed to one class fails "every lane's dispatch actually
 * produces at least two classes", which builds its set from returned values
 * rather than from this file's literals.
 *
 * HOW FAR DOWN EACH LANE IS DRIVEN — the claim above is not uniform, and the
 * difference matters when you are deciding what a green here is worth.
 * - **Session metadata**: fully. Injected `fetch` → the real client's
 *   status/code translation → the real `dispatchRejectedAck` → the fold that
 *   ran. Both halves of the decision are executed.
 * - **Invocation parts** and **component inventory**: the real client, end to
 *   end. The component lane's classifier call site (`desktop-components-client`
 *   `postChunk`) is executed, so deleting it reds this suite — and since ISS-8609
 *   that includes its BODY-CODE extraction, because the coded-content 400 cell
 *   reaches ITEM only if the code was read off the response and threaded down.
 *   What this file does NOT cover on that arm is the untrusted-envelope and
 *   unparseable-body refusals: `failureResponse` always emits a well-formed
 *   first-party envelope, so `desktop-components-client-chunking.test.ts` owns
 *   the bodies a proxy or WAF can answer with.
 * - **Transcript control plane**: the client-error → `recordFailure` path, and
 *   only it (ISS-9420). The real client's throw reaches the real
 *   `TranscriptDrainQueue` — `processFile`'s catch, the real `recordFailure`,
 *   the retry budget it persisted — but the executor between them is a test
 *   bridge: `fakeExecutor`'s `syncFile` calls `syncPlan` on a hand-built plan
 *   request, so the real `TranscriptSyncExecutor.syncFile` (egress gate,
 *   `markUploading` claim, size cap, plan preparation, upload) never runs. This
 *   lane is one hop short of the other three in that direction. In the
 *   direction this file is about it is not: nothing here evaluates the lane's
 *   predicate, so deleting the policy consultation inside `recordFailure` reds
 *   this suite. That consultation is a DISJUNCTION, and each half is covered by
 *   its own cells, so neither can be deleted alone and stay green:
 *   `isLaneWideHttpStatus` by every row whose status is off the row-ladder
 *   allow-list, and `isLaneWideTranscriptForbidden` by the two coded-403 rows
 *   carrying a `TranscriptForbiddenCode`. Until those two existed the
 *   right-hand term was unreachable here — every cell left the code undefined,
 *   which that predicate answers `false` — so the whole term could be deleted
 *   with this suite still green.
 *
 * WHY THE EXPECTED TABLE IS WRITTEN OUT BY HAND. The cells below are
 * transcribed from Appendix A, not derived from any module under test. That
 * duplication IS the test — a table computed from the implementation stays
 * green when a member is deleted or the whole standard is emptied. Keep it
 * literal. Do not replace a column with `Object.values(...)` of anything the
 * lanes import.
 *
 * **That matters MORE now, not less (ISS-8614).** Each profile-backed lane reads
 * one `shared/sync-failure-classification.ts` profile, so a single wrong cell in
 * that module would move multiple lanes at once and a suite deriving its
 * expectations from it would move with them. This file is the independent copy
 * those lanes are held to. `sync-failure-classification.test.ts` asks the
 * narrower question this harness cannot — does the module answer what the
 * standard says — and guards that this file's vocabulary still agrees with the
 * module's, which is drift made loud rather than drift shared.
 *
 * THE DIVERGENCE LEDGER IS SHRINK-ONLY. Where a lane does not yet conform, the
 * cell carries a {@link Divergence} naming the class the lane produces TODAY and
 * either the ticket that owns the fix or why it earns none — see that type's
 * `owner` docstring. The assertion runs against the divergence when one
 * is present, so the suite is green on today's tree — and it goes RED the moment
 * the fix lands, because the observed class stops matching the recorded
 * divergence. That red means DELETE the entry, never widen it. A new divergence
 * nobody recorded is a plain failure. Adding an entry to buy a green is the
 * failure mode this file exists to prevent.
 *
 * WHAT THIS DOES NOT COVER — read before citing it as coverage.
 * - **Backoff growth, wall-clock transition, terminal state, and recovery
 *   doors.** This harness asserts the CLASSIFICATION decision, plus the one
 *   session-lane effect the class cannot carry (whether the lane stood down).
 *   The mechanics
 *   behind each class are already pinned per lane by
 *   `agent-session-sync-lane-stall-fold.test.ts`,
 *   `agent-session-sync-transport-error-fold.test.ts`,
 *   `transcript-lane-stall-backoff.test.ts`, and
 *   `agent-component-sync-dead-letter.test.ts`; re-proving them here would
 *   duplicate rather than extend. If PRD-699 §7.2's shared module ever moves
 *   those decisions out of the lanes, they belong here too.
 * - **Transcript S3 presigned PUT** — Appendix A's fourth named exception. It
 *   HAS a decision now (ISS-8608 / PRD-699 F6) and is conformance-tested, in
 *   the sibling file `sync-classification-standard-s3-put.test.ts`. It lives
 *   there rather than here because this file had ~116 logical lines of headroom
 *   against the 1,000-line ceiling; both import the same guards from
 *   `helpers/sync-classification-standard.ts`.
 * - **The routine lane** (`routine-sync-service.ts`, ISS-9617). It postdates the
 *   standard and Appendix A's "what each client can actually receive" table does
 *   not name its route, so this harness would be inventing verdicts for it.
 * - **Retry-After honoring** (F7). It is a schedule, not a class.
 * - **In-band ack reasons on the invocation lane.** Every cell here is a
 *   non-2xx status, so the client's body-parsing arm is never reached and
 *   `invocation-sync-rejection-policy`'s `rejectionBudgetForRow` — which owns
 *   whether `session_missing`, `part_conflict`, `generation_conflict`,
 *   `rate_limited`, and `ingestion_failed` may charge a part — is not driven.
 *   Appendix A blesses that policy as already-correct ("decisions on codes")
 *   and `invocation-sync-rejection-budget.test.ts` pins it; a status-keyed
 *   table cannot reach it.
 * - **The session lane's LaneWide validation carve-out.** A 400 whose
 *   `details.reason` is `schema_version_invalid` / `compute_target_id_invalid`
 *   defers with budgets intact instead of charging. That is a body-level
 *   refinement of an ITEM cell rather than a class of its own, and
 *   `agent-session-sync-chunk-validation-classification.test.ts` owns it.
 * - **The class a THROWN send ultimately lands in.** Appendix A puts a network
 *   throw in ENVIRONMENTAL; on the session lane `applyTransportErrorFold` owns
 *   that decision (ISS-10602: a typed transport throw defers the lane) and
 *   `agent-session-sync-transport-error-fold.test.ts` pins it. What is asserted
 *   here is the client half both lanes own: a network throw must not be
 *   laundered into a row-attributable verdict.
 *
 * No fake timers are installed anywhere in this file, deliberately: nothing here
 * is time-dependent, so there is no clock to leak into a sibling suite. Each
 * observation builds its own client and its own recorder, so no case depends on
 * a latch a predecessor primed and every case passes run alone. The one piece of
 * module-level state any of this touches is `gatewayLog`, a shared append buffer
 * no case here reads. The component client's transition logger is NOT
 * module-level — `createTransitionLogger` closes over its own `lastOutcome` and
 * each observation builds its own client — so it cannot carry state between
 * cases either.
 */
import assert from "node:assert/strict";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  type AgentComponentInvocationSyncPart,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import {
  AgentSessionSyncMode,
  DesktopAgentSessionsSyncErrorCode,
  type SyncedComponent,
} from "@repo/api/src/types/agent-session";
import { TranscriptForbiddenCode } from "@repo/api/src/types/desktop-transcripts";
import { describe, test } from "vitest";
import { ComponentSyncSendOutcome } from "../src/main/agent-sync/agent-component-sync-dead-letter.js";
import type { BoundedFailureFoldConfig } from "../src/main/agent-sync/agent-session-sync-ack-fold.js";
import type { AgentSessionSyncTransportPayload } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  dispatchRejectedAck,
  type RejectedAckDispatchDeps,
  type RejectedAgentSessionsAck,
} from "../src/main/agent-sync/agent-session-sync-rejection-dispatch.js";
import { AgentSessionSyncTransportError } from "../src/main/agent-sync/agent-session-sync-service-helpers.js";
import type { DesktopAgentComponentsPayload } from "../src/main/agent-sync/agent-session-sync-source.js";
import { AGENT_COMPONENT_SYNC_SCHEMA_VERSION } from "../src/main/agent-sync/agent-session-sync-source.js";
import { createDesktopAgentSessionsClient } from "../src/main/agent-sync/desktop-agent-sessions-client.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import { createDesktopAgentComponentInvocationsClient } from "../src/main/dashboard/desktop-agent-component-invocations-client.js";
import { createDesktopComponentsClient } from "../src/main/dashboard/desktop-components-client.js";
import {
  type Cell,
  type Lane,
  type Observation,
  registerLaneConformanceGuards,
  StandardClass,
} from "./helpers/sync-classification-standard.js";
import {
  FUTURE_ERROR_CODE,
  failureResponse,
  ORIGIN,
  SESSION_ID,
  TARGET,
  TOKEN,
} from "./support/sync-conformance-fixtures.js";
import { observeTranscriptLane } from "./support/transcript-conformance-lane.js";

/**
 * {@link Observation} plus the session-lane effect the class cannot carry. Stays
 * here rather than moving to the shared helper with the rest of the vocabulary:
 * `pausedLane` is one lane's mechanism, and a shared type carrying it would
 * invite the other lanes to answer a question they have no notion of.
 *
 * Recorded separately because it is the ONLY thing that distinguishes the two
 * coded 403s: both are ENVIRONMENTAL, so a class-only observation cannot tell
 * them apart and would stay green if the coded branch died.
 */
type SessionObservation = Observation & {
  readonly pausedLane: boolean;
};

// ---------------------------------------------------------------------------
// Session metadata lane — POST /desktop/agent-sessions/sync
// ---------------------------------------------------------------------------
/** Appendix A's session worksheet plus route-specific and platform-injected statuses. */
const SESSION_CELLS: readonly Cell[] = [
  {
    status: 400,
    code: DesktopAgentSessionsSyncErrorCode.ValidationFailed,
    label: "400 validation_failed",
    standard: StandardClass.Item,
  },
  { status: 413, label: "413 payload too large", standard: StandardClass.Item },
  {
    status: 401,
    label: "401 unauthenticated",
    standard: StandardClass.Environmental,
  },
  {
    status: 403,
    code: DesktopAgentSessionsSyncErrorCode.FeatureDisabled,
    label: "403 feature_disabled",
    standard: StandardClass.Environmental,
  },
  {
    status: 403,
    code: DesktopAgentSessionsSyncErrorCode.TargetNotOwned,
    label: "403 target_not_owned",
    standard: StandardClass.Environmental,
  },
  {
    status: 403,
    label: "403 uncoded (pre-FEA-3425 server)",
    standard: StandardClass.Environmental,
  },
  {
    status: 404,
    label: "404 deploy skew / recovery route missing",
    standard: StandardClass.Environmental,
  },
  {
    status: 408,
    label: "408 timeout",
    standard: StandardClass.Environmental,
  },
  {
    status: 409,
    label: "409 pending",
    standard: StandardClass.Item,
  },
  {
    status: 429,
    label: "429 rate limited",
    standard: StandardClass.Environmental,
  },
  {
    status: 500,
    label: "500 ingestion_failed",
    standard: StandardClass.Environmental,
  },
  { status: 502, label: "502 platform", standard: StandardClass.Environmental },
  { status: 503, label: "503 platform", standard: StandardClass.Environmental },
  { status: 504, label: "504 platform", standard: StandardClass.Environmental },
  {
    status: 418,
    label: "unrecognized 4xx, uncoded",
    standard: StandardClass.Environmental,
    coversUnknownDefault: true,
  },
  {
    status: 599,
    label: "unrecognized 5xx, uncoded",
    standard: StandardClass.Environmental,
    coversUnknownDefault: true,
  },
  {
    status: 418,
    code: FUTURE_ERROR_CODE,
    label: "unrecognized status naming a code this build cannot map",
    standard: StandardClass.Environmental,
    coversUnknownDefault: true,
  },
  // The cell that proves this lane CONSULTS the shared module (ISS-8614). Every
  // other status here is one the client's own reason chain already names, so a
  // lane that deleted its classifier call would still answer them all correctly.
  // 422 is Appendix A's ITEM row and the chain names nothing for it: before the
  // conversion it fell to the blanket `ingestion_failed` defer.
  {
    status: 422,
    label: "422 (Appendix A ITEM, named by no reason this route sends)",
    standard: StandardClass.Item,
  },
  // The counterfactual for the cell above, and the reason ISS-8595's check runs
  // BEFORE the module's answer on this lane. Appendix A's status table says ITEM
  // for 422, but its CLASS definitions put a version skew in ENVIRONMENTAL, and
  // a code no build in this repo declares is that skew on the wire. Transcribed
  // from those definitions rather than the status row, so it is not a
  // divergence: this is the standard's own answer for a rejection this build
  // cannot classify. Swap the two checks back and this cell observes ITEM — a
  // terminal, dead-letter-charging verdict reached from a reason nobody read.
  {
    status: 422,
    code: FUTURE_ERROR_CODE,
    label: "422 naming a code this build cannot map (skew, not the row)",
    standard: StandardClass.Environmental,
  },
];

/**
 * Records which fold the dispatch ran, and nothing else. Deliberately NOT the
 * collaborator-ORDER harness in `agent-session-sync-rejection-dispatch.test.ts`:
 * that file asks "did every reason reach its exact collaborators, in order";
 * this one asks the single coarser question the standard is about — was a
 * per-row budget charged. Two questions, two shapes; folding them together
 * would make each answer the other's, which is the trap this file is built
 * against.
 *
 * SO ON THIS LANE THE CLASS *IS* THE BUDGET MEASUREMENT: `class` below is
 * derived from `charged` and from nothing else, which is exactly Appendix A's
 * decision rule ("charge nothing to the item — every item would fail
 * identically") stated as behavior. There is deliberately no second assertion
 * over a `chargesRowBudget` field: one read against `charged ? ITEM : ENV` and
 * another against `charged` are the same statement written twice, and no
 * SESSION_CELLS entry could red one without the other. The independent read is
 * {@link SessionObservation.pausedLane}, which comes off a different
 * collaborator (`pauseForFeatureDisabled`) than the fold.
 */
function sessionDispatchRecorder(): {
  deps: RejectedAckDispatchDeps;
  read: () => Omit<SessionObservation, "defect"> & { defect: string | null };
} {
  let charged = false;
  let deferred = false;
  let paused = false;
  // `countsToward: false` is a defer that merely rides the bounded fold's
  // plumbing (`transport_unavailable`); it charges nothing, so reading it as a
  // charge would misreport that class as ITEM.
  const chargeFold = (config: BoundedFailureFoldConfig): void => {
    if (config.countsToward === false) {
      deferred = true;
      return;
    }
    charged = true;
    config.counter.set(SESSION_ID, (config.counter.get(SESSION_ID) ?? 0) + 1);
  };
  const deps: RejectedAckDispatchDeps = {
    nextRetryAfterMs: new Map(),
    applyBoundedFold: chargeFold,
    validationFailureDeps: () => ({
      counter: new Map<string, number>(),
      recoverableDeadLetterCountFor: () => 0,
      markForBisection: () => undefined,
      clearBisectionFlag: () => undefined,
      applyBoundedFold: chargeFold,
      logInfo: () => undefined,
      formatBytes: (bytes: number) => String(bytes),
    }),
    applyLaneStallFold: () => {
      deferred = true;
      return Promise.resolve();
    },
    transportTimeoutFoldPolicy: () => ({
      counter: new Map<string, number>(),
      maxConsecutive: 5,
      reason: DesktopAgentSessionsAckReason.TransportTimeout,
      recoverable: true,
      backoffMs: 30_000,
      recordOutboxOnDefer: false,
    }),
    deferLaneEnvironmental: () => {
      deferred = true;
      return {
        stalledSinceMs: 0,
        elapsedMs: 0,
        nextAttemptAtMs: 0,
        opened: true,
        givenUp: false,
        gaveUpAtMs: null,
      };
    },
    noteLaneAnswered: () => undefined,
    noteTransportLoss: () => undefined,
    pauseForFeatureDisabled: () => {
      deferred = true;
      paused = true;
    },
    logInfo: () => undefined,
    logWarn: () => undefined,
  };
  return {
    deps,
    read: () => ({
      class: charged ? StandardClass.Item : StandardClass.Environmental,
      pausedLane: paused,
      defect:
        charged || deferred
          ? null
          : "the dispatch neither charged nor deferred — a rejection that reaches no fold is the hot-retry defect, not a class",
    }),
  };
}

function sessionBatch(): AgentSessionSyncTransportPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "batch-1",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 0,
    sessions: [],
  };
}

/**
 * Drive the session lane end to end: injected `fetch` → the real HTTP client's
 * status/code translation → the real rejection dispatch → the fold that ran.
 */
async function observeSessionLane(cell: Cell): Promise<SessionObservation> {
  const client = createDesktopAgentSessionsClient({
    fetch: () => Promise.resolve(failureResponse(cell)),
    getAccessToken: () => Promise.resolve(TOKEN),
    getApiOrigin: () => ORIGIN,
  });
  const ack = await client.sendBatch(sessionBatch(), TARGET);
  if (ack.accepted) {
    return {
      class: StandardClass.Environmental,
      pausedLane: false,
      defect: "the client resolved a failure response to an ACCEPTED ack",
    };
  }
  const recorder = sessionDispatchRecorder();
  await dispatchRejectedAck(
    {
      ack: ack satisfies RejectedAgentSessionsAck,
      ids: [SESSION_ID],
      syncMode: AgentSessionSyncMode.Incremental,
      payloadBytes: 1024,
      multiPartEnvelope: false,
    },
    recorder.deps
  );
  return recorder.read();
}

// ---------------------------------------------------------------------------
// Invocation parts lane — POST /desktop/agent-sessions/invocations/sync
// ---------------------------------------------------------------------------

const INVOCATION_CELLS: readonly Cell[] = [
  { status: 400, label: "400 validation", standard: StandardClass.Item },
  { status: 413, label: "413 payload too large", standard: StandardClass.Item },
  {
    status: 401,
    label: "401 unauthenticated",
    standard: StandardClass.Environmental,
  },
  {
    status: 403,
    label: "403 policy/ownership",
    standard: StandardClass.Environmental,
  },
  {
    status: 408,
    label: "408 intermediary timeout",
    standard: StandardClass.Environmental,
  },
  {
    status: 429,
    label: "429 rate limited",
    standard: StandardClass.Environmental,
  },
  { status: 500, label: "500 server", standard: StandardClass.Environmental },
  { status: 503, label: "503 platform", standard: StandardClass.Environmental },
  {
    status: 501,
    label: "501 protocol_unsupported",
    standard: StandardClass.ProtocolAbsent,
  },
  {
    status: 418,
    label: "unrecognized 4xx",
    standard: StandardClass.Environmental,
    coversUnknownDefault: true,
  },
  {
    status: 599,
    label: "unrecognized 5xx",
    standard: StandardClass.Environmental,
    coversUnknownDefault: true,
  },
  {
    status: 404,
    label: "404 deploy skew",
    standard: StandardClass.Environmental,
  },
  // The divergence here is DELETED rather than edited, per the ledger rule: this
  // lane used to read 410 as protocol absence, and ISS-8614's conversion dropped
  // that as dead policy (Appendix A verified 410 unreachable on every route), so
  // the cell now conforms. Kept as a cell because the status is still classified.
  {
    status: 410,
    label: "410 gone (unreachable on every route)",
    standard: StandardClass.Environmental,
  },
  // PRD-699 v2 (amended 2026-09-09) assigns 422 ITEM on every route. This lane
  // inherits it from the default table — the profile holds no 422 entry. The
  // invocation-parts route does not emit one today, so the cell pins what an
  // already-installed build would do if it started: a part rejected as invalid
  // reaches the permanent counter instead of the environmental retry it took
  // before ISS-8614.
  {
    status: 422,
    label: "422 validation rejection (Appendix A ITEM, inherited)",
    standard: StandardClass.Item,
  },
];

function invocationPart(): AgentComponentInvocationSyncPart {
  return {
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    externalSessionId: SESSION_ID,
    externalGenerationId: "a".repeat(64),
    sourceUpdatedAt: "2026-09-06T00:00:00.000Z",
    dataRevision: 1,
    sourceSequence: 1,
    partIndex: 0,
    partCount: 1,
    partHash: "b".repeat(64),
    items: [],
  };
}

async function observeInvocationLane(cell: Cell): Promise<Observation> {
  const client = createDesktopAgentComponentInvocationsClient({
    fetch: () => Promise.resolve(failureResponse(cell)),
    getAccessToken: () => Promise.resolve(TOKEN),
    getApiOrigin: () => ORIGIN,
    getComputeTargetId: () => TARGET,
  });
  const result = await client.syncPart(invocationPart());
  if (result.kind === "unavailable") {
    // Flat retry, no charge, remedy is an upgrade — Appendix A's third class.
    return { class: StandardClass.ProtocolAbsent, defect: null };
  }
  if (result.kind === "retry") {
    // Deferred with the part's budget intact.
    return { class: StandardClass.Environmental, defect: null };
  }
  if (result.ack.accepted) {
    return {
      class: StandardClass.Environmental,
      defect: "the client resolved a failure response to an ACCEPTED ack",
    };
  }
  // A synthesized permanent ack is what spends this lane's per-part budget.
  return {
    class: StandardClass.Item,
    defect:
      result.ack.reason ===
      AgentComponentInvocationSyncRejectReason.ValidationFailed
        ? null
        : `a synthesized permanent ack named ${String(result.ack.reason)} rather than the rejection it stands for`,
  };
}

// ---------------------------------------------------------------------------
// Component inventory lane — POST /desktop/components/sync
// ---------------------------------------------------------------------------

const COMPONENT_CELLS: readonly Cell[] = [
  { status: 413, label: "413 batch too large", standard: StandardClass.Item },
  {
    status: 400,
    label:
      "400 UNCODED (named exception: read as skew — old server, shared helper)",
    standard: StandardClass.Environmental,
  },
  // ISS-8609 gave this route a code vocabulary, so the two arms of its 400 are
  // separable on the wire; both are driven through the REAL client here.
  //
  // Read what each cell is worth. The CONTENT cell is the causal one: 400's
  // ledger deviation answers ENVIRONMENTAL, so it can only reach ITEM if
  // `postChunk` really extracted the code and `classifyComponentSyncHttpStatus`
  // really passed it down — delete either and this cell reds. The SKEW cell is
  // deliberately NOT claimed as that proof: an uncoded 400 already defers, so it
  // agrees with the row above. What it pins is that coding the skew did not move
  // it off ENVIRONMENTAL, which is the compatibility half of the criterion.
  //
  // Both code strings are hand-written, like every other literal in this file.
  {
    status: 400,
    code: "schema_version_unsupported",
    label:
      "400 schema_version_unsupported (coded skew: an API deploy clears it)",
    standard: StandardClass.Environmental,
  },
  {
    status: 400,
    code: "validation_failed",
    label: "400 validation_failed (coded content: the batch's own fault)",
    standard: StandardClass.Item,
  },
  {
    status: 401,
    label: "401 unauthenticated",
    standard: StandardClass.Environmental,
  },
  {
    status: 403,
    label: "403 policy/ownership",
    standard: StandardClass.Environmental,
  },
  {
    status: 404,
    label: "404 deploy skew",
    standard: StandardClass.Environmental,
  },
  {
    status: 408,
    label: "408 intermediary timeout",
    standard: StandardClass.Environmental,
  },
  {
    status: 429,
    label: "429 rate limited",
    standard: StandardClass.Environmental,
  },
  { status: 500, label: "500 server", standard: StandardClass.Environmental },
  { status: 503, label: "503 platform", standard: StandardClass.Environmental },
  {
    status: 418,
    label: "unrecognized 4xx",
    standard: StandardClass.Environmental,
    coversUnknownDefault: true,
  },
  {
    status: 599,
    label: "unrecognized 5xx",
    standard: StandardClass.Environmental,
    coversUnknownDefault: true,
  },
  {
    status: 409,
    label: "409 (unreachable on this route)",
    standard: StandardClass.Environmental,
  },
  // NOT a divergence, and NOT the sibling of 409 above. Appendix A lists 422 as
  // unreachable on every route; for THIS route that is wrong. 422 is the
  // components route's primary validation rejection — `route.ts` answers it for
  // every parse failure that is not pure schema-version skew, and
  // `route.test.ts` drives it and records that the desktop's status-only
  // dead-letter of it is the intended behavior (ISS-7978). Charging the poison
  // budget is what lets a malformed batch clear the keyset boundary instead of
  // head-of-line-blocking the inventory, which is what ISS-4542 exists to
  // prevent. So PRD-699 C1's shrink applies to 409 ONLY; folding 422 in with it
  // would strand a permanently-invalid batch on an environmental defer forever.
  {
    status: 422,
    label: "422 validation rejection",
    standard: StandardClass.Item,
  },
];

/** One minimal inventory row, so the client actually issues a chunk POST. */
function componentBatch(): DesktopAgentComponentsPayload {
  const component: SyncedComponent = {
    externalId: "component-1",
    componentKind: "mcp",
    componentKey: "server",
    harness: null,
    name: null,
    version: null,
    description: null,
    sourceUrl: null,
    installPath: null,
    packId: null,
    scope: null,
    projectPath: null,
    metadata: null,
    content: "",
    contentHash: null,
    firstSeenAt: "2026-09-06T00:00:00.000Z",
    lastSeenAt: "2026-09-06T00:00:00.000Z",
    uninstalledAt: null,
  };
  return {
    schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
    batchId: "batch-1",
    syncMode: AgentSessionSyncMode.Incremental,
    componentCount: 1,
    components: [component],
  };
}

async function observeComponentLane(cell: Cell): Promise<Observation> {
  const client = createDesktopComponentsClient({
    fetch: () => Promise.resolve(failureResponse(cell)),
    getAccessToken: () => Promise.resolve(TOKEN),
    getApiOrigin: () => ORIGIN,
    getComputeTargetId: () => TARGET,
  });
  const result = await client.sync(componentBatch());
  if (result.outcome === ComponentSyncSendOutcome.Accepted) {
    return {
      class: StandardClass.Environmental,
      defect: "the client resolved a failure response as accepted",
    };
  }
  // `BatchRejected` is the only outcome that charges the poison budget toward a
  // dead-letter (see its docstring); `LaneFailure` pauses without charging.
  return {
    class:
      result.outcome === ComponentSyncSendOutcome.BatchRejected
        ? StandardClass.Item
        : StandardClass.Environmental,
    defect: null,
  };
}

// ---------------------------------------------------------------------------
// Transcript control plane — POST /desktop/transcripts/{sync-plan,complete,skip}
// ---------------------------------------------------------------------------

const TRANSCRIPT_CELLS: readonly Cell[] = [
  {
    status: 400,
    label: "400 (8 KiB deterministic control body)",
    standard: StandardClass.Item,
  },
  { status: 413, label: "413 payload too large", standard: StandardClass.Item },
  {
    status: 409,
    label: "409 StaleUpload (named exception: ITEM ladder with re-plan)",
    standard: StandardClass.Item,
  },
  {
    status: 401,
    label: "401 unauthenticated",
    standard: StandardClass.Environmental,
  },
  {
    status: 429,
    label: "429 rate limited",
    standard: StandardClass.Environmental,
  },
  { status: 500, label: "500 server", standard: StandardClass.Environmental },
  {
    status: 503,
    label: "503 store outage",
    standard: StandardClass.Environmental,
  },
  {
    status: 599,
    label: "unrecognized 5xx",
    standard: StandardClass.Environmental,
    coversUnknownDefault: true,
  },
  {
    status: 403,
    code: TranscriptForbiddenCode.NotOwned,
    label: "403 transcript_target_not_owned",
    standard: StandardClass.Environmental,
  },
  {
    status: 403,
    code: TranscriptForbiddenCode.PolicyDisabled,
    label: "403 transcript_policy_disabled",
    standard: StandardClass.Environmental,
  },
  {
    status: 403,
    label: "403 bare (named exception: conflates ownership + PolicyDisabled)",
    standard: StandardClass.Environmental,
    divergence: {
      observed: StandardClass.Item,
      owner:
        "ISS-10002 (PRD-699 Phase 1 #8's tail) — ISS-8599 landed the CODED 403 on both sides; what is left is the bare one from a server predating it, which keeps the ladder until that compatibility window closes. `TRANSCRIPT_CONTROL_ROUTE_PROFILE` records the same wait as a ledger entry.",
    },
  },
  {
    status: 408,
    label: "408 intermediary timeout",
    standard: StandardClass.Environmental,
  },
  {
    status: 404,
    label: "404 deploy skew",
    standard: StandardClass.Environmental,
  },
  {
    status: 418,
    label: "unrecognized 4xx",
    standard: StandardClass.Environmental,
    coversUnknownDefault: true,
  },
  // PRD-699 v2's amended 422 row, inherited from the default table rather than
  // held as a ledger entry. The control route does not emit one today, so this
  // pins what an already-installed build would do if it started: the row ladder,
  // not the lane-wide freeze the deleted `TRANSCRIPT_ROW_LADDER_STATUSES`
  // allow-list gave every status outside `{400, 403, 409, 413}`.
  {
    status: 422,
    label: "422 validation rejection (Appendix A ITEM, inherited)",
    standard: StandardClass.Item,
  },
];

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const LANES: readonly Lane[] = [
  {
    name: "session metadata",
    cells: SESSION_CELLS,
    observe: observeSessionLane,
  },
  {
    name: "invocation parts",
    cells: INVOCATION_CELLS,
    observe: observeInvocationLane,
  },
  {
    name: "component inventory",
    cells: COMPONENT_CELLS,
    observe: observeComponentLane,
  },
  {
    name: "transcript control plane",
    cells: TRANSCRIPT_CELLS,
    observe: observeTranscriptLane,
  },
];

describe("PRD-699 Appendix A classification conformance", () => {
  registerLaneConformanceGuards(LANES);
});

describe("PRD-699 Appendix A: what a bare status cannot carry", () => {
  test("session lane: a status this build already decides is not re-read from a code it cannot map", async () => {
    // Appendix A's mixed-failure case, and the classifier-test rule's: a known
    // signature (the status) arrives beside an unrelated unrecognized one (a
    // newer server's code). The status-earned class must win, or a rolling
    // deploy silently reclassifies every 400 and 429 in the fleet.
    //
    // "Already decides" is the statuses the ROUTE NAMES, and only those — every
    // cell below is one of them. A status the build reaches only through
    // Appendix A's DEFAULT table is the opposite case, and the 422 pair in
    // SESSION_CELLS is where it is pinned: there the unmappable code wins,
    // because a verdict about the row must not be guessed from a reason nobody
    // could read.
    const mixed: readonly Cell[] = [
      {
        status: 400,
        code: FUTURE_ERROR_CODE,
        label: "400 beside an unmappable code",
        standard: StandardClass.Item,
      },
      {
        status: 429,
        code: FUTURE_ERROR_CODE,
        label: "429 beside an unmappable code",
        standard: StandardClass.Environmental,
      },
      {
        status: 403,
        code: FUTURE_ERROR_CODE,
        label: "403 beside an unmappable code",
        standard: StandardClass.Environmental,
      },
    ];
    for (const cell of mixed) {
      const observed = await observeSessionLane(cell);
      assert.equal(observed.defect, null, cell.label);
      assert.equal(
        observed.class,
        cell.standard,
        `${cell.label}: an unmappable code overrode a classification the status had already earned`
      );
    }
  });

  test("session lane: the two coded 403s share a class but not a terminal behavior", async () => {
    // Appendix A refinement 1: "where a machine-readable `code` exists, decide
    // on the code, never the bare status". Both 403 codes are ENVIRONMENTAL, so
    // the class table above cannot tell them apart — only `feature_disabled`
    // stands the whole lane down, and if that branch died a class-only
    // assertion would still pass. This is the assertion that notices.
    const cases: readonly { code: string | undefined; pauses: boolean }[] = [
      { code: DesktopAgentSessionsSyncErrorCode.FeatureDisabled, pauses: true },
      { code: DesktopAgentSessionsSyncErrorCode.TargetNotOwned, pauses: false },
      { code: undefined, pauses: false },
    ];
    for (const { code, pauses } of cases) {
      const label = `403 ${code ?? "uncoded"}`;
      const observed = await observeSessionLane({
        status: 403,
        ...(code ? { code } : {}),
        label,
        standard: StandardClass.Environmental,
      });
      assert.equal(observed.defect, null, label);
      assert.equal(
        observed.class,
        StandardClass.Environmental,
        `${label}: a 403 must never charge a row for a condition no row caused`
      );
      assert.equal(
        observed.pausedLane,
        pauses,
        pauses
          ? `${label}: a capability-off server must stand the lane down, not just defer the batch`
          : `${label}: only feature_disabled may stand the lane down — pausing on an ownership miss strands every other session too`
      );
    }
  });

  test("session lane: a network throw is not laundered into a rejection ack", async () => {
    // The class a throw ultimately lands in is decided by the service's
    // transport-error fold (see the file header); what the CLIENT must never do
    // is answer a dropped connection with an ack that blames the payload.
    const client = createDesktopAgentSessionsClient({
      fetch: () => Promise.reject(new TypeError("fetch failed")),
      getAccessToken: () => Promise.resolve(TOKEN),
      getApiOrigin: () => ORIGIN,
    });
    await assert.rejects(
      () => client.sendBatch(sessionBatch(), TARGET),
      AgentSessionSyncTransportError,
      "a network failure must propagate as a typed transport throw, not resolve to a rejection ack"
    );
  });

  test("invocation lane: a network throw defers rather than synthesizing a permanent ack", async () => {
    const client = createDesktopAgentComponentInvocationsClient({
      fetch: () => Promise.reject(new TypeError("fetch failed")),
      getAccessToken: () => Promise.resolve(TOKEN),
      getApiOrigin: () => ORIGIN,
      getComputeTargetId: () => TARGET,
    });
    const result = await client.syncPart(invocationPart());
    assert.equal(
      result.kind,
      "retry",
      "a dropped connection is environmental — a synthesized permanent ack would dead-letter the part at DL@5"
    );
  });
});
