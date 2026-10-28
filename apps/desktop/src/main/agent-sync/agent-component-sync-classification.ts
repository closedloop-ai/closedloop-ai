/**
 * @file agent-component-sync-classification.ts
 * @description The component-inventory lane's fold from Appendix A's behavior
 * class onto its own send outcome (ISS-8614).
 *
 * A sibling of `agent-component-sync-dead-letter.ts` rather than a section of
 * it: the decision is now the shared module's, only the fold onto
 * {@link ComponentSyncSendOutcome} is this lane's, and the dead-letter file is a
 * grandfather-free 1,100-line module that must not grow.
 */
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { DesktopComponentsSyncRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import {
  COMPONENT_INVENTORY_ROUTE_PROFILE,
  classifySyncFailure,
  SyncFailureClass,
} from "../../shared/sync-failure-classification.js";
import { ComponentSyncSendOutcome } from "./agent-component-sync-dead-letter.js";
import { syncReasonForHttpStatus } from "./sync-lane-cloud-health.js";

/**
 * Every Appendix A class folded onto this lane's send outcomes.
 *
 * `ENVIRONMENTAL` and `PROTOCOL-ABSENT` both answer `LaneFailure`: this lane has
 * no third effect, and both mean pause without advancing the cursor or charging
 * the budget. Collapsing them here rather than in the shared module keeps the
 * distinction available to the lanes that DO act on it.
 *
 * Exhaustive over {@link SyncFailureClass} rather than a ternary on `ITEM`,
 * because a ternary's else-arm absorbs a fourth class in silence: it would never
 * charge the boundary budget, and the lane would defer forever on a class nobody
 * mapped. Written this way, a fourth member reds `tsc` here first.
 */
const SEND_OUTCOME_BY_FAILURE_CLASS: Record<
  SyncFailureClass,
  ComponentSyncSendOutcome
> = {
  [SyncFailureClass.Environmental]: ComponentSyncSendOutcome.LaneFailure,
  [SyncFailureClass.Item]: ComponentSyncSendOutcome.BatchRejected,
  [SyncFailureClass.ProtocolAbsent]: ComponentSyncSendOutcome.LaneFailure,
};

/**
 * Classify a failed response from `POST /desktop/components/sync` into a send
 * outcome. A 2xx is `Accepted`. Otherwise the shared classifier decides, and
 * only Appendix A's `ITEM` — the batch's own fault, and it would be rejected
 * again unchanged — becomes `BatchRejected`, the single outcome that charges the
 * boundary budget toward a dead-letter.
 *
 * `code` is the body's top-level machine-readable reason where the server sent
 * one (ISS-8609). OPTIONAL because a server predating that deploy sends none —
 * and a code this build cannot map is no signal either. Both fall through to the
 * status, which still answers today's fold, so a coded skew defers, a coded
 * content rejection charges the budget, and a bare 400 behaves exactly as before.
 */
export function classifyComponentSyncHttpStatus(
  status: number,
  code?: string
): ComponentSyncSendOutcome {
  if (status >= 200 && status < 300) {
    return ComponentSyncSendOutcome.Accepted;
  }
  return SEND_OUTCOME_BY_FAILURE_CLASS[
    classifySyncFailure(COMPONENT_INVENTORY_ROUTE_PROFILE, status, code)
  ];
}

/**
 * The route codes whose REASON differs from what their status alone would say.
 *
 * Sparse on purpose: a code absent here has nothing to add over the status, so
 * it falls through rather than being given a reason nobody chose. Only
 * `schema_version_unsupported` needs an entry today, and it needs one badly —
 * ISS-8609 made skew separable from a content rejection on the wire, and
 * `syncReasonForHttpStatus` would have thrown that distinction away one layer
 * later by answering `validation_failed` for both, on the single channel a lane
 * give-up is ever observed on.
 *
 * A `Map`, not an object literal, because the key is a SERVER-SUPPLIED string
 * off a failure body that a proxy or WAF can author. A plain `{}` resolves
 * `__proto__` to `Object.prototype` and `constructor` / `toString` / `valueOf`
 * to functions, all truthy, so `?? syncReasonForHttpStatus(status)` would never
 * fire and the lane would emit a value outside {@link SyncReason} on the wire
 * instead of degrading to the status. Same reason
 * `COMPONENT_INVENTORY_ROUTE_PROFILE.codes` is one.
 */
const SYNC_REASON_BY_ERROR_CODE: ReadonlyMap<string, SyncReason> = new Map([
  [
    DesktopComponentsSyncRestErrorCode.SchemaVersionUnsupported,
    SyncReason.ProtocolUnsupported,
  ],
]);

/**
 * The reason a failed component-sync response reports, refined by the body's
 * code where the server sent one.
 *
 * Status-keyed is the FALLBACK, not the rule, for the same reason
 * {@link classifyComponentSyncHttpStatus} consults the code first: a status that
 * stands in for a reason is a status that cannot tell two causes apart. An
 * unknown or absent code degrades to exactly the pre-ISS-8609 answer.
 */
export function componentSyncReasonFor(
  status: number,
  code?: string
): SyncReason {
  const coded =
    code === undefined ? undefined : SYNC_REASON_BY_ERROR_CODE.get(code);
  return coded ?? syncReasonForHttpStatus(status);
}
