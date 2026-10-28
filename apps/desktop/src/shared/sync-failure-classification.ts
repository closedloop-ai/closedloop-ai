/**
 * @file sync-failure-classification.ts
 * @description Where a desktop→cloud sync lane turns a failed response into a
 * behavior class (PRD-699 Appendix A, ratified 2026-08-28; ISS-8614).
 *
 * Each profile-backed lane reads it through a thin lane-side adapter that folds
 * the class onto that lane's own effect —
 * `agent-component-sync-classification.ts`, `transcript-sync-types.ts`'s
 * `isLaneWideHttpStatus`, and the two sync clients under `main/agent-sync/` and `main/dashboard/` — because
 * the CLASS is shared and the effect never is.
 *
 * Four independent status→verdict tables used to answer this question and
 * disagreed — 11 tickets on budget misclassification and two data-loss incidents
 * (ISS-6883→ISS-6909; ISS-7730, 40,634 events), both the same shape: an
 * ENVIRONMENTAL condition laundered into a per-row terminal verdict the cloud
 * then recorded as authoritative.
 *
 * VALUES AND ONE PURE DECISION, nothing else. The MECHANICS each class implies —
 * which budget is charged, how long the lane stands down, when a row is
 * dead-lettered — stay in the lanes under `main/`, exactly as
 * `sync-lane-contract.ts` (PLN-1562 WS1) split its outbox vocabulary from
 * `main/sync/durable-outbox.ts`. It sits in `shared/` and imports only VALUE
 * modules — a sibling here, plus the API package's wire error codes a `codes` map
 * has to be keyed by (ISS-8609) — so a renderer-side reader stays possible
 * without a later move.
 *
 * NOT this module's business: a 2xx. {@link classifySyncFailure} answers "given
 * that this attempt FAILED, whose fault is it", and a caller reaching it with a
 * success status is asking the wrong question: an unusable 2xx body is its own
 * status-less failure, never a verdict from here (ISS-9894).
 */
import { DesktopAgentSessionsSyncErrorCode } from "@repo/api/src/types/agent-session";
import { DesktopComponentsSyncRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import { SyncLaneId } from "./sync-burndown-contract.js";

/**
 * Appendix A's three behavior classes, and the whole set.
 *
 * - `ENVIRONMENTAL` — the condition is about the world, not the payload: an
 *   outage, a denial, a timeout, a version skew. Defer WITHOUT charging any
 *   per-item budget and without advancing a cursor past the item; every item
 *   would fail identically, so charging one is charging the wrong thing.
 * - `ITEM` — the server attributes the failure to THIS payload and would reject
 *   it again unchanged. Charge the item's budget so a genuine poison row is
 *   eventually set aside instead of head-of-line-blocking the lane.
 * - `PROTOCOL-ABSENT` — the peer does not speak this protocol version at all.
 *   Flat retry, no charge; the remedy is an upgrade, not a backoff curve.
 *
 * PRD-699 §7.2's prose names four (`environmental-defer` / `charge` /
 * `permanent` / `unavailable`); those are EFFECTS a lane produces from a class,
 * not classes. Three here, matching ISS-8614's body and the independent
 * conformance harness.
 */
export const SyncFailureClass = {
  Environmental: "ENVIRONMENTAL",
  Item: "ITEM",
  ProtocolAbsent: "PROTOCOL-ABSENT",
} as const;
export type SyncFailureClass =
  (typeof SyncFailureClass)[keyof typeof SyncFailureClass];

/**
 * Every HTTP status Appendix A assigns a default class to. Adding a member here
 * fails `tsc` until {@link APPENDIX_A_DEFAULT} names it — which is the point:
 * a `ReadonlySet<number>` or a bare array of the same members compiles fine when
 * a status is added and then falls silently to the hardwired default.
 */
export type AppendixAStatus =
  | 400
  | 401
  | 403
  | 404
  | 408
  | 409
  | 410
  | 413
  | 422
  | 429
  | 500
  | 501
  | 502
  | 503
  | 504;

/**
 * Appendix A's default status→class mapping, transcribed from the ratified
 * standard.
 *
 * 422 is ITEM per PRD-699 v2 (amended 2026-09-09): v1 listed it unreachable on
 * every route, which is false for the component-inventory route, where it is the
 * primary validation rejection. Reading it as ENVIRONMENTAL would strand a
 * permanently-invalid batch on a defer forever.
 *
 * A status ABSENT from this record is not a gap to fill defensively — it is a
 * status the standard never assigned, and {@link classifySyncFailure} answers
 * ENVIRONMENTAL for it by construction (ISS-9695). That tail must stay reachable
 * only by omission; enumerating "unknown" statuses here is what makes a default
 * need an edit per new status.
 */
const APPENDIX_A_DEFAULT: Record<AppendixAStatus, SyncFailureClass> = {
  400: SyncFailureClass.Item,
  401: SyncFailureClass.Environmental,
  403: SyncFailureClass.Environmental,
  404: SyncFailureClass.Environmental,
  408: SyncFailureClass.Environmental,
  409: SyncFailureClass.Environmental,
  410: SyncFailureClass.Environmental,
  413: SyncFailureClass.Item,
  422: SyncFailureClass.Item,
  429: SyncFailureClass.Environmental,
  500: SyncFailureClass.Environmental,
  501: SyncFailureClass.ProtocolAbsent,
  502: SyncFailureClass.Environmental,
  503: SyncFailureClass.Environmental,
  504: SyncFailureClass.Environmental,
};

/**
 * The lookup {@link classifySyncFailure} reads, DERIVED from the exhaustive
 * record above rather than written out beside it. A second hand-written list of
 * the same members is a list that compiles when the record gains one.
 */
const APPENDIX_A_DEFAULT_BY_STATUS: ReadonlyMap<number, SyncFailureClass> =
  new Map(
    Object.entries(APPENDIX_A_DEFAULT).map(([status, failureClass]) => [
      Number(status),
      failureClass,
    ])
  );

/**
 * A status this route classifies against Appendix A's default.
 *
 * Every one is DEBT. Appendix A's own rule is "coded reasons where they exist,
 * statuses otherwise", so a route whose status has to stand in for a reason is a
 * route that has not coded its errors yet, and `resolvedBy` names the ticket
 * that will. There is deliberately NO permanent variant and no "route property"
 * kind: PLN-1960 v2 exists to reverse exactly that from v1, because a permanent
 * kind entrenches the disagreement this module was built to delete.
 *
 * Deleting an entry is the definition of done for the ticket it names.
 */
export type StatusDeviation = {
  /** What this route answers for the status instead of the default. */
  readonly class: SyncFailureClass;
  /** Why the route cannot answer the default today. */
  readonly because: string;
  /** The ISS slug that codes this condition away. Never blank, never "untracked". */
  readonly resolvedBy: string;
};

/** One route's classification policy. */
export type RouteProfile = {
  readonly lane: SyncLaneId;
  /**
   * The route's machine-readable error vocabulary, where it has one. Consulted
   * FIRST — Appendix A's rule — so a rolling deploy that starts coding a status
   * changes the verdict without an edit here.
   */
  readonly codes?: ReadonlyMap<string, SyncFailureClass>;
  readonly statusDeviations: ReadonlyMap<number, StatusDeviation>;
};

/**
 * `POST /desktop/components/sync`.
 *
 * 409 carries no entry: PRD-699 C1 verified it unreachable on this route, and a
 * dead policy is not debt — it is deleted. 422 carries none either, because the
 * amended Appendix A default already says ITEM for it; the two are NOT siblings,
 * and folding 422 into C1's shrink is the mistake C1 was corrected to prevent.
 *
 * ISS-8609 gave this route a code vocabulary, so its 400 is no longer decided by
 * the status alone — see `codes`, and the narrowed 400 entry it leaves behind.
 */
export const COMPONENT_INVENTORY_ROUTE_PROFILE: RouteProfile = {
  lane: SyncLaneId.ComponentInventory,
  /**
   * ISS-8609. `schema_version_unsupported` is the route's SKEW rejection, which
   * an API deploy clears and no retry of the same rows ever can.
   * `validation_failed` is the route attributing the batch to itself, and it
   * means that on WHATEVER status carries it — the 422 today, a 400 from a
   * differently-coded server tomorrow — because a coded reason outranks a status
   * by Appendix A's own rule.
   */
  codes: new Map([
    [
      DesktopComponentsSyncRestErrorCode.SchemaVersionUnsupported,
      SyncFailureClass.Environmental,
    ],
    [
      DesktopComponentsSyncRestErrorCode.ValidationFailed,
      SyncFailureClass.Item,
    ],
  ]),
  statusDeviations: new Map([
    [
      400,
      {
        class: SyncFailureClass.Environmental,
        because:
          "A COMPATIBILITY RESIDUAL since ISS-8609, no longer the blanket skew rule it replaced: the route's own skew 400 now carries `schema_version_unsupported` and is answered by `codes` above, one rung higher. What is left uncoded at this status is a skew 400 from a server predating that deploy, plus the two shared desktop write-lane helpers that still send a message where a code belongs — `requireComputeTargetId` (an id read off the relay hello ack, so ITEM would turn lane state into permanent local data loss) and `readBoundedJsonBody`'s `Invalid JSON body`. Widening this to the standard's ITEM default would dead-letter a whole inventory on the strength of no wire signal at all.",
        resolvedBy: "ISS-10090",
      },
    ],
  ]),
};

/**
 * `POST /desktop/agent-sessions/invocations/sync`.
 *
 * No deviations: 404, 410 and 501 all take Appendix A's defaults. 404 needs no
 * entry because the route emits no 404 of its own — its only refusal is the 501
 * carrying `protocol_unsupported`, PROTOCOL-ABSENT by default — so a 404 here is
 * the route not being there, which is ENVIRONMENTAL. 410 is unreachable on every
 * route. The profile stays, empty, because every lane ships exactly one.
 */
export const INVOCATION_PARTS_ROUTE_PROFILE: RouteProfile = {
  lane: SyncLaneId.InvocationParts,
  statusDeviations: new Map<number, StatusDeviation>(),
};

/**
 * `POST /desktop/agent-sessions/sync`.
 *
 * The PR-ref chunking handshake can answer 409 while a multi-part sequence is
 * still assembling. That is a protocol-progress response about the current row,
 * not a deployment or connectivity outage, so it stays on the row ladder until
 * the route sends a machine-readable code for it.
 *
 * Its ACK REASONS are a finer vocabulary than the three classes and stay in the
 * lane: `ack_timeout`, `rate_limited` and `ingestion_failed` are all
 * ENVIRONMENTAL, so the class cannot pick between them and must not try.
 *
 * The session lane reads 403 codes through its ACK adapter.
 *
 * 404 has no entry here. A missing session-sync route is a platform/deploy skew
 * under Appendix A's default ENVIRONMENTAL class.
 */
export const SESSION_METADATA_ROUTE_PROFILE: RouteProfile = {
  lane: SyncLaneId.SessionMetadata,
  codes: new Map([
    [
      DesktopAgentSessionsSyncErrorCode.FeatureDisabled,
      SyncFailureClass.Environmental,
    ],
    [DesktopAgentSessionsSyncErrorCode.TargetNotOwned, SyncFailureClass.Item],
  ]),
  statusDeviations: new Map([
    [
      409,
      {
        class: SyncFailureClass.Item,
        because:
          "The PR-ref chunking handshake can answer a bare 409 while the final fragment is still pending. That is protocol progress for this session rather than a lane-wide outage, and the route sends a message rather than a stable code, so the status must carry the row-ladder verdict until the conflict is coded.",
        resolvedBy: "ISS-10008",
      },
    ],
  ]),
};

/**
 * `POST /desktop/transcripts/{sync-plan,complete,skip}` — the CONTROL plane, not
 * the presigned S3 PUT. The upload arm is refined by S3's own `<Code>` in
 * `main/transcript-sync/transcript-s3-put-classification.ts` (ISS-8608); it
 * composes with this profile at the call site and never replaces it.
 *
 * Both entries are the same shape — a route helper that emits a MESSAGE where a
 * code belongs (`forbiddenResponse` before ISS-8599, `conflictResponse` still),
 * so the status is standing in for a reason the wire never carried.
 */
export const TRANSCRIPT_CONTROL_ROUTE_PROFILE: RouteProfile = {
  lane: SyncLaneId.TranscriptArchive,
  statusDeviations: new Map([
    [
      403,
      {
        class: SyncFailureClass.Item,
        because:
          "A BARE 403 conflates an ownership miss with an org-policy denial, and ISS-8599 gave the server a `TranscriptForbiddenCode` for exactly that reason — the CODED ones are already routed to the environmental arm by `isLaneWideTranscriptForbidden`. What is left is the uncoded 403 from a server predating that split, and widening it would change behaviour against every unpatched server in the fleet on the strength of no signal.",
        resolvedBy: "ISS-10002",
      },
    ],
    [
      409,
      {
        class: SyncFailureClass.Item,
        because:
          "409 is `StaleUpload` on this route — a protocol PROGRESS signal answered by re-planning on the next attempt, so the row ladder is the right net for a persistent one, where Appendix A's default defers it. It is status-keyed because `conflictResponse` sends a human-readable message and no code, and `postControl` throws before reading the body for every status but 403, so nothing on the wire could carry the reason even if the server sent one.",
        resolvedBy: "ISS-10001",
      },
    ],
  ]),
};

/** Every profile this module ships, so the ledger can be counted. */
export const SYNC_ROUTE_PROFILES: readonly RouteProfile[] = [
  COMPONENT_INVENTORY_ROUTE_PROFILE,
  INVOCATION_PARTS_ROUTE_PROFILE,
  SESSION_METADATA_ROUTE_PROFILE,
  TRANSCRIPT_CONTROL_ROUTE_PROFILE,
];

/**
 * How many status deviations the ledger is allowed to hold, in total, today.
 *
 * STATUS deviations only — a `codes` entry is never debt and is deliberately
 * outside this budget. A deviation exists because the route sends no reason and
 * the status must stand in for one; a code IS the reason, so mapping it is the
 * thing that retires debt rather than a form of it.
 *
 * SHRINK-ONLY, and the mechanical form of §7.2's "refuse an uncoded new error
 * class at review time": adding an entry reds the suite until someone raises
 * this deliberately, and coding one away reds it until someone lowers it. Same
 * discipline as the biome grandfather list and the conformance harness's
 * divergence ledger — without it this module is the fifth table with better
 * documentation.
 */
export const STATUS_DEVIATION_BUDGET = 4;

/**
 * Classify a FAILED sync attempt for one route.
 *
 * Resolution order, and no other: **coded reason → status deviation → Appendix A
 * default → hardwired ENVIRONMENTAL.** Codes first is Appendix A's rule. The
 * hardwired tail is what ISS-9695 proved must be reachable by OMISSION rather
 * than enumerated, so a status no build has ever seen defers instead of being
 * guessed as the item's fault.
 *
 * `code` is the body's top-level machine-readable reason where the route sends
 * one. A code this build cannot map is not a signal — it falls through to the
 * status, so a newer server's vocabulary never silently reclassifies a status
 * this build already decides.
 */
export function classifySyncFailure(
  profile: RouteProfile,
  status: number,
  code?: string
): SyncFailureClass {
  const coded = code === undefined ? undefined : profile.codes?.get(code);
  if (coded !== undefined) {
    return coded;
  }
  const deviation = profile.statusDeviations.get(status);
  if (deviation !== undefined) {
    return deviation.class;
  }
  return (
    APPENDIX_A_DEFAULT_BY_STATUS.get(status) ?? SyncFailureClass.Environmental
  );
}

/**
 * Appendix A's default for one status, or `null` where the standard assigns it
 * none. Exported for the ledger's liveness guard, which has to be able to say
 * "this deviation records the standard's own answer, so it is not a deviation".
 */
export function appendixADefaultFor(status: number): SyncFailureClass | null {
  return APPENDIX_A_DEFAULT_BY_STATUS.get(status) ?? null;
}

/** Every status Appendix A assigns a default class to, derived from the record. */
export function appendixAStatuses(): readonly number[] {
  return [...APPENDIX_A_DEFAULT_BY_STATUS.keys()];
}

/**
 * Whether a class says the FAILING ITEM is at fault, and so may spend that
 * item's own budget toward a terminal state.
 *
 * A restatement of the vocabulary, not a lane mechanic — HOW MUCH budget, how
 * long the lane stands down, and when a row is set aside all stay in the lanes.
 * What it buys is one copy: four lanes ask this exact question to fold three
 * classes onto a two-valued effect, and four hand-written `!== ITEM` tests are
 * four places a fourth class lands silently on the non-charging arm. Deferring
 * forever on a class nobody mapped is not the safe answer it looks like — it is
 * an unbounded hold with no terminal path.
 *
 * Exhaustive `Record`, so that fourth member reds `tsc` here first.
 */
const CHARGES_ITEM_BUDGET: Record<SyncFailureClass, boolean> = {
  [SyncFailureClass.Environmental]: false,
  [SyncFailureClass.Item]: true,
  [SyncFailureClass.ProtocolAbsent]: false,
};

/** See {@link CHARGES_ITEM_BUDGET}. */
export function chargesItemBudget(failureClass: SyncFailureClass): boolean {
  return CHARGES_ITEM_BUDGET[failureClass];
}
