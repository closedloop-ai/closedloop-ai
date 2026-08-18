import type { ApiResult } from "@repo/api/src/types/common";
import type {
  ComputeTarget,
  CreateDesktopCommandInput,
} from "@repo/api/src/types/compute-target";
import {
  MEMBER_PACK_INSTALL_OPERATION_ID,
  MEMBER_PACK_INSTALL_PATH,
  MemberPackInstallDispatchReason,
  MemberPackInstallDispatchState,
  type MemberPackInstallResponse,
} from "@repo/api/src/types/member-pack-install";
import { log } from "@repo/observability/log";
import { buildTelemetryTraceContext } from "@repo/observability/telemetry/context";
import type { NextResponse } from "next/server";
import {
  CommandSigningRequirementStatus,
  resolveCommandSigningRequirement,
} from "@/lib/compute-target-signing-eligibility";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  errorResponse,
  notFoundResponse,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import {
  dispatchRelayCommandToRelay,
  type RelayDispatchResult,
  toRelayOperation,
} from "./relay-command-helpers";
import { computeTargetsService } from "./service";

/**
 * Member self-service pack install dispatch (FEA-4082, hardened in FEA-4164).
 *
 * Authorizes that the requesting member OWNS the target node
 * (`findOwnedById` — an org-scoped, owner-only lookup with NO org-share
 * fallback, so a member can never push an install to another member's node or a
 * merely org-shared node), then reuses the existing command-dispatch plumbing
 * (`desktopCommandStore` + `dispatchRelayCommandToRelay`) to push a pack-install
 * gateway operation through the relay to that node.
 *
 * Fail-closed and honest about state (FEA-4164 hardening of wongk's review):
 *
 *  1. Delivered != acked. A relay `delivered:true` only proves the socket emit
 *     reached a connected node; it does NOT prove the node accepted or ran the
 *     install. Transport-only delivery is therefore surfaced as `Pending` (the
 *     install is in flight on the node — the UI follows the node's command-event
 *     ack over the returned `commandId` to reach a terminal on-device state), not
 *     a premature `Dispatched`. `Dispatched` remains in the wire contract for a
 *     node that later acks receipt over the event stream; this synchronous
 *     dispatcher never asserts it up front.
 *
 *  2. Version-skew gate. A desktop build that predates the pack-install route
 *     does NOT advertise `member_pack_install` in `supportedOperations`; its
 *     gateway would answer 501. We detect that up front and return terminal
 *     `Failed` WITHOUT dispatching (and WITHOUT a `commandId`, since no command
 *     row exists), rather than pushing an operation the node cannot honor.
 *
 *  3. Command signing. A node that enforces command signing verifies
 *     browser-origin Ed25519 signatures against locally authorized keys
 *     (`CommandSignatureVerifier`); it has no trust anchor for a server-forged
 *     signature. A server-initiated install carries no browser signature, so a
 *     signing-enforcing node would reject it in `CloudCommandExecutor.enqueue`.
 *     We therefore fail closed with terminal `Failed` up front (no `commandId`)
 *     when signing is `Required` OR `Unknown` — the shared
 *     `resolveCommandSigningRequirement` decides the requirement, and this
 *     dispatcher applies the fail-closed action (it has no browser signature to
 *     fall back on, unlike the generic commands route which proceeds unsigned on
 *     `Unknown` and surfaces a warning). The dispatcher deliberately does NOT
 *     forge a signature.
 *
 *  4. No replay storm, but keep ambiguous outcomes replayable. `createCommand`
 *     persists the command as `queued` before dispatch. A PROVEN-failed outcome
 *     must leave NO non-terminal row, or the node's hello-ack replay
 *     (`listNonTerminalDispatchCommands`, which selects every non-terminal
 *     command and re-emits it on reconnect) would re-run a stale/duplicate
 *     install on every reconnect. So a post-dispatch definitively-offline or
 *     proven-failed result marks the created command terminal (`Expired`) so
 *     replay excludes it. TWO outcomes legitimately stay non-terminal: the
 *     delivered `Pending` case — the node took the command and
 *     `resumeFromSequence` replay is the intended durable path — and the
 *     AMBIGUOUS case (`isAmbiguousDispatchFailure`), where the transport did not
 *     prove the command never reached the node (a cloud→relay timeout, or the
 *     relay's `target_not_connected`, which it also returns when a cross-instance
 *     peer proxy times out AFTER the peer may already have emitted). There we
 *     keep the row `queued` and `Pending` so a node that took the install can
 *     still reconcile on reconnect rather than being reported as a terminal
 *     failure the member retries into a duplicate run.
 */

/**
 * Relay reason that DEFINITIVELY proves there is no local subscriber: the
 * in-process relay bus (`relayEventBus.publishOperation`, used when no external
 * `RELAY_API_URL` is configured) returns `target_offline` only when it has no
 * subscriber for the target — a real, terminalizable offline. The relay's
 * `target_not_connected` is deliberately NOT here: the relay collapses
 * cross-instance peer timeouts and malformed peer responses into that same wire
 * reason, so from the cloud's vantage it is ambiguous, not proof of no delivery.
 */
const DEFINITIVE_OFFLINE_REASONS = new Set<string>([
  MemberPackInstallDispatchReason.TargetOffline,
]);

/**
 * Relay reasons whose failure is AMBIGUOUS: the transport did not return a clean
 * `delivered:true`, but it also did NOT prove the command was never emitted to
 * the node, so the install may be running. Reporting a terminal `Failed` and
 * expiring the row would (a) let the member "retry" an install that is already
 * running and (b) drop the command from hello-ack reconnect replay, so a node
 * that took it could never reconcile. Instead the created command stays
 * NON-terminal (`queued`, so `resumeFromSequence` replay can still resolve it)
 * and we surface non-terminal `Pending` — honest "we couldn't confirm; it may be
 * running". Members: `relay_dispatch_failed` (cloud→relay fetch throw/timeout)
 * and `target_not_connected` (the relay's collapsed cross-instance
 * timeout/malformed-peer outcome). A missing reason is treated as PROVEN-failed
 * (terminalizable), not ambiguous, so unknown transports do not leak queued
 * rows.
 */
const AMBIGUOUS_DISPATCH_REASONS = new Set<string>([
  MemberPackInstallDispatchReason.RelayDispatchFailed,
  MemberPackInstallDispatchReason.TargetNotConnected,
]);

function isAmbiguousDispatchFailure(result: RelayDispatchResult): boolean {
  return (
    result.reason !== undefined && AMBIGUOUS_DISPATCH_REASONS.has(result.reason)
  );
}

/**
 * Narrows the relay's free-form reason string to a wire-contract dispatch
 * reason. An unrecognized reason is surfaced verbatim only through logging; the
 * response `reason` is contract-typed, so unknown strings are dropped rather
 * than widening the wire contract.
 */
function toDispatchReason(
  reason: string | undefined
): MemberPackInstallDispatchReason | undefined {
  const known = Object.values(MemberPackInstallDispatchReason) as string[];
  return reason !== undefined && known.includes(reason)
    ? (reason as MemberPackInstallDispatchReason)
    : undefined;
}

function mapDeliveredDispatchResultToState(
  result: RelayDispatchResult
): MemberPackInstallDispatchState {
  if (result.delivered) {
    // Transport reached a connected node, but the node has NOT yet acked/ran
    // the install. Honest: Pending, not Dispatched.
    return MemberPackInstallDispatchState.Pending;
  }
  if (result.reason && DEFINITIVE_OFFLINE_REASONS.has(result.reason)) {
    return MemberPackInstallDispatchState.TargetOffline;
  }
  // Ambiguous (cloud→relay timeout, or the relay's collapsed
  // `target_not_connected`, after the node may already have taken the install):
  // do NOT assert a terminal Failed. Stay Pending — the created command remains
  // non-terminal for reconnect replay.
  if (isAmbiguousDispatchFailure(result)) {
    return MemberPackInstallDispatchState.Pending;
  }
  return MemberPackInstallDispatchState.Failed;
}

function buildPackInstallCommandInput(
  packId: string,
  harness: string
): CreateDesktopCommandInput {
  return {
    operationId: MEMBER_PACK_INSTALL_OPERATION_ID,
    method: "POST",
    path: MEMBER_PACK_INSTALL_PATH,
    body: { packId, harness },
  };
}

/**
 * Whether the target advertises the pack-install gateway route. An older
 * desktop build predating FEA-4082 omits it from `supportedOperations`.
 */
function targetSupportsPackInstall(target: ComputeTarget): boolean {
  return target.supportedOperations.includes(MEMBER_PACK_INSTALL_OPERATION_ID);
}

/**
 * Whether the target would reject a server-initiated (unsigned) command because
 * it enforces browser command signing. Uses the shared
 * `resolveCommandSigningRequirement` (one source of truth with the generic
 * commands route) and applies this dispatcher's fail-closed action: block on
 * `Required` AND on `Unknown` (we cannot prove the install would be accepted and
 * have no browser signature to fall back on), dispatch only on `NotRequired`.
 *
 * The requester is always the target owner here (`findOwnedById` is owner-only),
 * so `requesterUserId === targetUserId` and the owner clerk id is the requester
 * clerk id, matching the commands route's owner branch.
 */
async function targetEnforcesCommandSigning(
  target: ComputeTarget,
  ownerClerkUserId?: string | null
): Promise<boolean> {
  const requirement = await resolveCommandSigningRequirement({
    capabilities: target.capabilities,
    organizationId: target.organizationId,
    targetUserId: target.userId,
    targetGatewayId: target.gatewayId,
    requesterUserId: target.userId,
    requesterClerkUserId: ownerClerkUserId,
    targetOwnerClerkUserId: ownerClerkUserId,
  });
  return requirement.status !== CommandSigningRequirementStatus.NotRequired;
}

/**
 * Terminal preflight failure BEFORE any command row exists (version-skew or
 * signing gate). No `commandId` — there is no event stream to correlate, and an
 * empty-string sentinel would make the correlation key lie.
 */
function buildTerminalFailureResponse(input: {
  packId: string;
  harness: string;
  reason: MemberPackInstallDispatchReason;
}): MemberPackInstallResponse {
  return {
    packId: input.packId,
    harness: input.harness,
    state: MemberPackInstallDispatchState.Failed,
    reason: input.reason,
  };
}

export async function dispatchMemberPackInstall(input: {
  targetId: string;
  packId: string;
  harness: string;
  user: { id: string; organizationId: string; clerkId?: string | null };
}): Promise<NextResponse<ApiResult<MemberPackInstallResponse>>> {
  const { targetId, packId, harness, user } = input;

  // Member ownership gate: owner-only, org-scoped. Returns null for a node the
  // member does not own, a node in another org, or a merely org-shared node.
  const target = await computeTargetsService.findOwnedById(
    targetId,
    user.organizationId,
    user.id,
    user.clerkId
  );
  if (!target) {
    return notFoundResponse("Compute target");
  }

  // Version-skew gate: a node that does not advertise the pack-install route
  // would answer 501. Reject up front with a terminal Failed and never dispatch.
  if (!targetSupportsPackInstall(target)) {
    log.info("Member pack install rejected: operation not supported by node", {
      computeTargetId: target.id,
      packId,
      harness,
      reason: MemberPackInstallDispatchReason.OperationNotSupported,
    });
    scheduleLogFlush();
    return successResponse(
      buildTerminalFailureResponse({
        packId,
        harness,
        reason: MemberPackInstallDispatchReason.OperationNotSupported,
      })
    );
  }

  // Command-signing gate: a signing-enforcing node rejects an unsigned,
  // server-initiated command in CloudCommandExecutor.enqueue (there is no
  // trust anchor for a server-forged signature). Fail closed up front with a
  // terminal Failed instead of dispatching an operation the node will drop.
  if (await targetEnforcesCommandSigning(target, user.clerkId)) {
    log.info("Member pack install rejected: node enforces command signing", {
      computeTargetId: target.id,
      packId,
      harness,
      reason: MemberPackInstallDispatchReason.SigningRequired,
    });
    scheduleLogFlush();
    return successResponse(
      buildTerminalFailureResponse({
        packId,
        harness,
        reason: MemberPackInstallDispatchReason.SigningRequired,
      })
    );
  }

  const commandInput = buildPackInstallCommandInput(packId, harness);
  const requestId = crypto.randomUUID();

  try {
    const createResult = await desktopCommandStore.createCommand(
      target.id,
      commandInput,
      buildTelemetryTraceContext({
        computeTargetId: target.id,
        operationId: commandInput.operationId,
        requestId,
      })
    );
    const { commandId } = createResult.command;

    const relayOperation = toRelayOperation(commandId, commandInput);
    const dispatchResult = await dispatchRelayCommandToRelay({
      targetId: target.id,
      commandId,
      relayOperation,
      requestId,
    });

    const state = mapDeliveredDispatchResultToState(dispatchResult);

    // No replay storm: a command that was PROVEN not delivered stays `queued`
    // and would be re-emitted on the next hello-ack replay, re-running a
    // stale/duplicate install. Mark it terminal (`Expired`) so a
    // definitively-offline/proven-failed dispatch is not retried behind the
    // member's back. Two cases legitimately stay non-terminal: the delivered
    // (`Pending`) case — the node took the command and durable
    // `resumeFromSequence` replay is intended — AND the AMBIGUOUS case (see
    // `isAmbiguousDispatchFailure`), where the relay may already have emitted
    // before our fetch timed out / collapsed a peer timeout; expiring there
    // would drop an install the node may be running from reconnect replay and
    // let the member retry it.
    if (
      !(dispatchResult.delivered || isAmbiguousDispatchFailure(dispatchResult))
    ) {
      await desktopCommandStore.markCommandExpired(
        commandId,
        `member_pack_install_delivery_failed:${dispatchResult.reason ?? "unknown"}`,
        {
          commandId,
          operationId: commandInput.operationId,
          computeTargetId: target.id,
          requestId,
        }
      );
    }

    log.info("Member pack install dispatched", {
      computeTargetId: target.id,
      commandId,
      packId,
      harness,
      state,
      reason: dispatchResult.reason,
    });
    scheduleLogFlush();

    const reason = toDispatchReason(dispatchResult.reason);
    const response: MemberPackInstallResponse = {
      commandId,
      packId,
      harness,
      state,
      // Surface the dispatch reason whenever one exists. A clean delivered
      // `Pending` carries no reason; an AMBIGUOUS `Pending` (transport timeout
      // after possible emit) keeps its reason so the UI can explain the
      // unconfirmed state instead of a bare spinner.
      ...(reason ? { reason } : {}),
    };
    return successResponse(response);
  } catch (error) {
    return errorResponse("Failed to dispatch member pack install", error);
  }
}
