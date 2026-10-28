import { randomUUID } from "node:crypto";
import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import {
  DESKTOP_HELLO_ACK_SOCKET_EVENT,
  DesktopCommandStatus,
  DesktopHelloNackReason,
} from "@repo/api/src/types/compute-target";
import { isReportableActiveCommands } from "@repo/api/src/types/relay-heartbeat";
import { log } from "@repo/observability/log";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import { buildTelemetryTraceContext } from "@repo/observability/telemetry/context";
import { emitConnectionStateEvent } from "@repo/observability/telemetry/emitter";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { emitQueueMetric } from "@repo/observability/telemetry/metrics";
import { ORIGIN } from "@repo/observability/telemetry/origin";
import { ErrorClass } from "@repo/observability/telemetry/schema";
import { TelemetryCategory } from "@repo/observability/telemetry/telemetry-category";
import { waitUntil } from "@vercel/functions";
import {
  computeTargetsService,
  isComputeTargetGatewayConflictResult,
} from "@/app/compute-targets/service";
import { reportRegisteredTargetOrgMismatch } from "@/app/compute-targets/service/ownership-refusal-telemetry";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  isWithinMachineNameLimit,
  isWithinSupportedOperationsLimits,
} from "@/lib/compute-target-field-limits";
import {
  CommandSigningEligibilityStatus,
  isComputeTargetSigningEligible,
} from "@/lib/compute-target-signing-eligibility";
import { requeueUndeliveredCommands } from "@/lib/desktop-command-dispatch-queries";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  partitionPendingCommandsForReconnect,
  warnSkippedPendingCommands,
} from "@/lib/desktop-gateway-reconnect";
import {
  type DesktopHelloNackPayload,
  HELLO_OPERATION_TIMEOUT_MS,
  PROTOCOL_VERSION,
  type WireCommandPayload,
} from "@/lib/desktop-gateway-types";
import { toEnvelope, toWireCommandFromStore } from "@/lib/desktop-gateway-wire";
import { buildDesktopServerCapabilities } from "@/lib/desktop-server-capabilities";
import { relayEventBus } from "@/lib/relay-event-bus";
import { scheduleLogFlush } from "@/lib/route-utils";
import { isRecord } from "@/lib/type-guards";
import { isTimeoutError, runStage, timeStage } from "@/lib/with-timeout";
import { normalizeMaxInFlightCommands } from "./command-drain";
import { scheduleGitHubDirtyScopeRecoveryDrain } from "./github-dirty-scope-drain";
import type {
  EmitInstruction,
  RelayAuthContext,
  SocketEventResponse,
} from "./types";

function wireCommand(command: WireCommandPayload): EmitInstruction {
  return { event: "desktop.command", payload: toEnvelope(command) };
}

type RelayHelloInput = {
  machineName: string;
  platform: string;
  capabilities: JsonObject;
  supportedOperations: string[];
  computeTargetId?: string;
  pluginVersion?: string;
  gatewayId?: string;
  desktopSecurityUpgradeProtocolVersion?: 1;
  /** Already normalized — the applied ceiling, never the raw declaration. */
  maxInFlightCommands?: number;
  /** Set only when normalization moved the declared value. */
  maxInFlightCommandsClamp?: { declared: number; applied: number };
};

function parseRelayHelloInput(payload: unknown): RelayHelloInput | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (
    typeof payload.machineName !== "string" ||
    typeof payload.platform !== "string"
  ) {
    return null;
  }

  const desktopSecurityUpgradeProtocolVersion =
    payload.desktopSecurityUpgradeProtocolVersion === 1 ? 1 : undefined;

  // Normalized HERE, before `capabilities` is built, because that object is what
  // `resolveRelayHelloTarget` persists and what `emitFleetCapacityMetrics`
  // samples. Clamping only at the emit left both reading the raw declaration: a
  // target whose drain was capped at 64 stored 9007199254740991 on the row and
  // published a confident near-zero `executor_saturation` against it (ISS-8547).
  // One declaration point, one applied value, three consumers.
  let maxInFlightCommandsClamp:
    | { declared: number; applied: number }
    | undefined;
  const maxInFlightCommands = normalizeMaxInFlightCommands(
    payload.maxInFlightCommands,
    (clamp) => {
      maxInFlightCommandsClamp = clamp;
    }
  );

  return {
    machineName: payload.machineName,
    platform: payload.platform,
    capabilities: {
      ...(isRecord(payload.capabilities)
        ? (payload.capabilities as JsonObject)
        : {}),
      maxInFlightCommands: maxInFlightCommands ?? null,
      allowedDirectoriesHash:
        (payload.allowedDirectoriesHash as JsonValue) ?? null,
      socketProtocolVersion: PROTOCOL_VERSION,
      pluginVersion: (payload.pluginVersion as JsonValue) ?? null,
      desktopClientVersion: (payload.desktopClientVersion as JsonValue) ?? null,
      gatewayProtocolVersion:
        (payload.gatewayProtocolVersion as JsonValue) ?? null,
      desktopSecurityUpgradeProtocolVersion:
        desktopSecurityUpgradeProtocolVersion ?? null,
    },
    // Lands verbatim in `ComputeTarget.supportedOperations` (Json), which every
    // compute-target read echoes back, so an unbounded declaration is a stored
    // blob the API then re-serves. The bound is CHECKED by the caller and the
    // hello refused, not applied here by slicing: a truncated declaration is
    // acknowledged as if complete, and `supportedOperations.includes(...)` then
    // reports every operation past the cutoff as unsupported on a desktop that
    // supports it. Non-string members are still dropped — those are the shape
    // this field has always ignored, not a capability being discarded.
    supportedOperations: Array.isArray(payload.supportedOperations)
      ? payload.supportedOperations.filter(
          (operation): operation is string => typeof operation === "string"
        )
      : [],
    computeTargetId:
      typeof payload.computeTargetId === "string"
        ? payload.computeTargetId
        : undefined,
    pluginVersion:
      typeof payload.pluginVersion === "string"
        ? payload.pluginVersion
        : undefined,
    gatewayId:
      typeof payload.gatewayId === "string" ? payload.gatewayId : undefined,
    desktopSecurityUpgradeProtocolVersion,
    maxInFlightCommands,
    maxInFlightCommandsClamp,
  };
}

type ResolveRelayHelloTargetResult =
  | {
      ok: true;
      targetId: string;
      targetCreated: boolean;
      targetGatewayId: string | null;
    }
  | { ok: false; reason: DesktopHelloNackReason; cause: unknown; label: string }
  | { ok: "conflict" };

async function resolveRelayHelloTarget(
  input: RelayHelloInput,
  auth: RelayAuthContext
): Promise<ResolveRelayHelloTargetResult> {
  if (input.computeTargetId) {
    const updateResult = await runStage(
      computeTargetsService.updateOwned(
        input.computeTargetId,
        auth.organizationId,
        auth.userId,
        {
          machineName: input.machineName,
          platform: input.platform,
          capabilities: input.capabilities,
          supportedOperations: input.supportedOperations,
          gatewayId: input.gatewayId ?? null,
          desktopSecurityUpgradeProtocolVersion:
            input.desktopSecurityUpgradeProtocolVersion,
        }
      ),
      HELLO_OPERATION_TIMEOUT_MS,
      "computeTargetsService.updateOwned",
      DesktopHelloNackReason.ComputeTargetUpdateFailed
    );
    if (!updateResult.ok) {
      return updateResult;
    }
    const updated = updateResult.value;
    if (isComputeTargetGatewayConflictResult(updated)) {
      return { ok: "conflict" };
    }
    if (updated.value) {
      return {
        ok: true,
        targetId: input.computeTargetId,
        targetCreated: false,
        targetGatewayId: updated.value.gatewayId ?? input.gatewayId ?? null,
      };
    }
  }

  const registerResult = await runStage(
    computeTargetsService.register(auth.organizationId, auth.userId, {
      machineName: input.machineName,
      platform: input.platform,
      capabilities: input.capabilities,
      supportedOperations: input.supportedOperations,
      pluginVersion: input.pluginVersion,
      gatewayId: input.gatewayId ?? null,
      desktopSecurityUpgradeProtocolVersion:
        input.desktopSecurityUpgradeProtocolVersion,
    }),
    HELLO_OPERATION_TIMEOUT_MS,
    "computeTargetsService.register",
    DesktopHelloNackReason.ComputeTargetRegisterFailed
  );
  if (!registerResult.ok) {
    return registerResult;
  }
  const target = registerResult.value;
  if (isComputeTargetGatewayConflictResult(target)) {
    return { ok: "conflict" };
  }
  reportRegisteredTargetOrgMismatch({
    computeTargetId: target.value.id,
    organizationId: auth.organizationId,
    userId: auth.userId,
    targetOrganizationId: target.value.organizationId,
    targetUserId: target.value.userId,
  });
  return {
    ok: true,
    targetId: target.value.id,
    targetCreated: true,
    targetGatewayId: target.value.gatewayId ?? input.gatewayId ?? null,
  };
}

type HelloStageTimings = {
  resolveTargetMs?: number;
  pendingCommandsMs?: number;
  onlineStateMs?: number;
  featureFlagSigningMs?: number;
};

type RelayHelloFailure = {
  reason: DesktopHelloNackReason;
  cause: unknown;
  label: string;
};

/**
 * One line per hello. A nack logs at ERROR carrying `reason` and `errorKind`;
 * every other outcome stays at INFO.
 *
 * The message string and the existing field set are deliberately unchanged:
 * 30 days of production evidence was gathered with
 * `"Relay hello processed" @outcome:nack`, so renaming would orphan every
 * saved query for no gain. Before ISS-8043 the nack branch logged at INFO with
 * no reason and no error, which is why the wire reason
 * `pending_commands_lookup_failed` appeared in ZERO production logs while 142
 * of these fired over 30 days.
 *
 * `errorKind` is not redundant with `reason`. `reason` names WHICH STAGE failed;
 * `runStage` collapses a 5s deadline and a thrown DB error onto the SAME reason
 * (`failureReason ?? timeoutReason`), so timeout-vs-failure is exactly the axis
 * `reason` cannot express — and it is the axis that separates a slow query from
 * a broken one.
 *
 * The nack branch flushes, because a nack answers HTTP 200 and the route only
 * flushes from its catch block (`route.ts`). Left buffered, the line dies with
 * the frozen serverless function and ISS-8290's monitor stays as blind as the
 * `log.info` this replaced. The flush is bound to the nack line rather than to
 * the route's return on purpose: this endpoint carries ALL relay socket
 * traffic, and every internal route here deliberately flushes only on its
 * exceptional path — a nack is that path, it merely does not throw.
 */
function logRelayHello(
  auth: RelayAuthContext,
  helloStart: number,
  stageTimings: HelloStageTimings,
  extra: Record<string, unknown>,
  failure?: RelayHelloFailure
): void {
  const payload = {
    organizationId: auth.organizationId,
    userId: auth.userId,
    timings: stageTimings,
    totalMs: Math.round(performance.now() - helloStart),
    ...extra,
  };

  if (failure) {
    log.error("Relay hello processed", {
      ...payload,
      reason: failure.reason,
      errorKind: isTimeoutError(failure.cause, failure.label)
        ? "timeout"
        : "failure",
      error: failure.cause,
    });
    scheduleLogFlush();
    return;
  }

  log.info("Relay hello processed", payload);
}

function helloNackResponse(
  reason: DesktopHelloNackReason
): SocketEventResponse {
  return {
    emit: [
      {
        event: "desktop.hello.nack",
        payload: toEnvelope<DesktopHelloNackPayload>({ reason }),
      },
    ],
    disconnect: true,
  };
}

export async function handleHello(
  payload: unknown,
  auth: RelayAuthContext
): Promise<SocketEventResponse> {
  const helloStart = performance.now();
  const stageTimings: HelloStageTimings = {};

  const input = parseRelayHelloInput(payload);
  if (!input) {
    return { emit: [], disconnect: true };
  }

  // `compute_targets.machine_name` is a UNIQUE btree column, so an oversized
  // name raised SQLSTATE 54000 at INSERT. `runStage` caught that and nacked, so
  // the desktop already saw a nack plus a disconnect — refusing here keeps that
  // outcome and drops only the DB round-trip and its error span.
  //
  // The reason is BRANCHED because the path being short-circuited is: a hello
  // carrying a `computeTargetId` (the steady-state reconnect) goes to
  // `updateOwned` and nacks `ComputeTargetUpdateFailed`, while a fresh
  // registration goes to `register` and nacks `ComputeTargetRegisterFailed`.
  // A single hard-coded reason would change the desktop's status-bar string and
  // its telemetry mapping on reconnect.
  if (!isWithinMachineNameLimit(input.machineName)) {
    const reason = input.computeTargetId
      ? DesktopHelloNackReason.ComputeTargetUpdateFailed
      : DesktopHelloNackReason.ComputeTargetRegisterFailed;
    logRelayHello(
      auth,
      helloStart,
      stageTimings,
      { outcome: "nack" },
      {
        cause: new Error("machineName exceeds the compute-target column bound"),
        label: "machineName",
        reason,
      }
    );
    return helloNackResponse(reason);
  }

  // Same refusal shape, and the same branched reason, as `machineName` above.
  // `supportedOperations` has no btree behind it, so this is not the 54000
  // class — it is the stored-blob bound the REST validator already applies with
  // `.max()`, which REJECTS. Enforcing it by slicing would have made the two
  // lanes disagree about what a bounded declaration means.
  if (!isWithinSupportedOperationsLimits(input.supportedOperations)) {
    const reason = input.computeTargetId
      ? DesktopHelloNackReason.ComputeTargetUpdateFailed
      : DesktopHelloNackReason.ComputeTargetRegisterFailed;
    logRelayHello(
      auth,
      helloStart,
      stageTimings,
      { outcome: "nack" },
      {
        cause: new Error(
          "supportedOperations exceeds the declared capability bound"
        ),
        label: "supportedOperations",
        reason,
      }
    );
    return helloNackResponse(reason);
  }

  const resolvedTarget = await timeStage(stageTimings, "resolveTargetMs", () =>
    resolveRelayHelloTarget(input, auth)
  );
  if (resolvedTarget.ok === false) {
    logRelayHello(
      auth,
      helloStart,
      stageTimings,
      { outcome: "nack" },
      resolvedTarget
    );
    return helloNackResponse(resolvedTarget.reason);
  }
  if (resolvedTarget.ok === "conflict") {
    log.warn("relay.hello.gateway_conflict", {
      organizationId: auth.organizationId,
      userId: auth.userId,
      computeTargetId: input.computeTargetId,
      gatewayId: input.gatewayId,
      errorClass: ErrorClass.Protocol,
    });
    logRelayHello(auth, helloStart, stageTimings, {
      outcome: "gateway_conflict",
    });
    return { emit: [], disconnect: true };
  }
  const { targetId, targetCreated, targetGatewayId } = resolvedTarget;

  const [pendingCommandsResult, onlineStateResult, signingResult] =
    await Promise.all([
      timeStage(stageTimings, "pendingCommandsMs", () =>
        runStage(
          desktopCommandStore.listNonTerminalDispatchCommands(targetId),
          HELLO_OPERATION_TIMEOUT_MS,
          "listNonTerminalDispatchCommands",
          DesktopHelloNackReason.PendingCommandsLookupFailed
        )
      ),
      timeStage(stageTimings, "onlineStateMs", () =>
        targetCreated
          ? Promise.resolve({ ok: true as const, value: true })
          : runStage(
              computeTargetsService.setOnlineState(
                targetId,
                auth.organizationId,
                auth.userId,
                true
              ),
              HELLO_OPERATION_TIMEOUT_MS,
              "setOnlineState",
              DesktopHelloNackReason.OnlineStateUpdateFailed
            )
      ),
      timeStage(stageTimings, "featureFlagSigningMs", () =>
        runStage(
          isComputeTargetSigningEligible({
            organizationId: auth.organizationId,
            userId: auth.userId,
            clerkUserId: auth.clerkUserId,
            gatewayId: targetGatewayId,
          }),
          HELLO_OPERATION_TIMEOUT_MS,
          "isComputeTargetSigningEligible",
          DesktopHelloNackReason.InternalError
        )
      ),
    ]);

  if (!pendingCommandsResult.ok) {
    logRelayHello(
      auth,
      helloStart,
      stageTimings,
      { computeTargetId: targetId, outcome: "nack" },
      pendingCommandsResult
    );
    return helloNackResponse(pendingCommandsResult.reason);
  }

  if (!onlineStateResult.ok) {
    logRelayHello(
      auth,
      helloStart,
      stageTimings,
      { computeTargetId: targetId, outcome: "nack" },
      onlineStateResult
    );
    return helloNackResponse(onlineStateResult.reason);
  }

  // The signing feature flag soft-fails to `false` — a slow or broken
  // feature-flag SDK must not prevent the hello handshake from completing.
  const commandSigningSupported =
    signingResult.ok &&
    signingResult.value.status === CommandSigningEligibilityStatus.Eligible;
  const serverCapabilities = buildDesktopServerCapabilities({
    commandSigningSupported,
  });

  const { emit: pendingCommands, skipped: skippedPendingCommands } =
    partitionPendingCommandsForReconnect(pendingCommandsResult.value);
  // A skipped row is retained non-terminal and is replayed by neither lane, so
  // this warn is the only record it existed. The direct socket has emitted it
  // since before this partition reached the relay; dropping it here would swap
  // one lane divergence for another.
  warnSkippedPendingCommands(skippedPendingCommands);

  // Clear stale in-process backlog so new dispatches go through clean
  relayEventBus.clearOperationBacklog(targetId);

  const sessionId = randomUUID();
  // ISS-8453: a reconnect used to emit the WHOLE backlog in one frame — 106
  // commands against a declared ceiling of 2 in production. The desktop paces
  // its own execution, so this was never an execution overrun, but it is still
  // a burst the desktop never asked for, delivered mid-handshake.
  //
  // Held-back commands are released by `releaseQueuedCommands` as slots free.
  // An absent ceiling means an older desktop that states none, and keeps the
  // previous emit-everything behaviour rather than being frozen by a limit it
  // never declared.
  const declaredCeiling = input.maxInFlightCommands;
  if (input.maxInFlightCommandsClamp !== undefined) {
    // Reported here rather than at the parse, which has no target id yet. Without
    // it a client asking for more than the cap is throttled with nothing on the
    // wire or in the logs saying why (ISS-8547). The socket lane logs its own at
    // `parseHelloPayload`.
    log.warn("desktop.hello.maxInFlightCommands.clamped", {
      computeTargetId: targetId,
      machineName: input.machineName,
      declared: input.maxInFlightCommandsClamp.declared,
      applied: input.maxInFlightCommandsClamp.applied,
    });
  }
  const released =
    declaredCeiling === undefined
      ? pendingCommands
      : pendingCommands.slice(0, declaredCeiling);
  const withheld = pendingCommands.slice(released.length);

  const resumeFromSequence = Object.fromEntries(
    released.map((c) => [c.commandId, c.lastSequenceAcked])
  );

  const connectionCategory = targetCreated
    ? TelemetryCategory.ConnectionRegistered
    : TelemetryCategory.ConnectionResumed;

  emitConnectionStateEvent(
    connectionCategory,
    buildTelemetryTraceContext({
      computeTargetId: targetId,
      gatewaySessionId: sessionId,
    })
  );

  const emit: EmitInstruction[] = [
    {
      event: DESKTOP_HELLO_ACK_SOCKET_EVENT,
      payload: toEnvelope({
        computeTargetId: targetId,
        sessionId,
        serverTime: new Date().toISOString(),
        ...(serverCapabilities ? { serverCapabilities } : {}),
        ...(Object.keys(resumeFromSequence).length > 0
          ? { resumeFromSequence }
          : {}),
      }),
    },
  ];

  for (const command of released) {
    emit.push(wireCommand(toWireCommandFromStore(command)));
  }

  // A withheld command that the cloud still records as `accepted`/`running` is
  // on no desktop: this handshake replaced the executor that held it. Saying so
  // is what lets the drain, which selects `queued`, find it again.
  if (withheld.length > 0) {
    waitUntil(
      requeueUndeliveredCommands(
        targetId,
        withheld.map((command) => command.commandId)
      ).catch((error) => {
        // The ids, not just a count: a failed requeue leaves these rows
        // reading as in-flight on a desktop that never received them, which
        // understates every later `free` until a reconnect retries it. An
        // operator cannot reconcile that from a number alone.
        log.warn("relay.hello.requeue_withheld_failed", {
          computeTargetId: targetId,
          withheld: withheld.length,
          commandIds: withheld.map((command) => command.commandId),
          error,
        });
      })
    );
  }

  waitUntil(
    emitFleetCapacityMetrics({
      targetId,
      maxInFlightCommands: input.maxInFlightCommands,
    })
  );
  scheduleGitHubDirtyScopeRecoveryDrain({
    organizationId: auth.organizationId,
    targetId,
  });

  logRelayHello(auth, helloStart, stageTimings, {
    computeTargetId: targetId,
    gatewaySessionIdHash: redactGatewaySessionId(sessionId),
    // ISS-12032: the pair shows a hello that declared no gatewayId clearing
    // the stored one.
    declaredGatewayId: input.gatewayId ?? null,
    storedGatewayId: targetGatewayId,
    outcome: "ack",
    // ISS-11426: the socket only ever authenticates with the desktop API key
    // (`_relay.validate` -> `/internal/api-keys/verify`). Stated here so this
    // line joins against `compute_target.ownership_refused`'s `authMethod`.
    authMethod: RELAY_SOCKET_AUTH_METHOD,
    targetCreated,
    pendingCommandCount: pendingCommands.length,
    releasedCommandCount: released.length,
    withheldCommandCount: withheld.length,
    serverCapabilities,
  });

  return { targetId, gatewaySessionId: sessionId, emit };
}

/**
 * Publishes the fleet-capacity gauges and returns the queued depth it read.
 *
 * The return exists for ISS-8686: the presence sampler gates its drain on this
 * count, so a heartbeat from a target holding nothing costs no extra query. It
 * is the count as read, not a verdict — `undefined` means the read failed or
 * the sample was superseded, which is NOT the same as a depth of zero, and a
 * caller must not drain on it.
 */
export async function emitFleetCapacityMetrics({
  targetId,
  maxInFlightCommands,
  activeCommands,
  targetFound = true,
  isCurrentSample,
}: {
  targetId: string;
  maxInFlightCommands: number | undefined;
  /**
   * The desktop's own count of commands it is executing, off its presence
   * payload — RAW wire input, validated below. Undefined on hello (no occupancy
   * is reported at handshake) and for a desktop too old to send one; any other
   * non-number is a malformed payload, which is a different outcome.
   */
  activeCommands?: unknown;
  /** False only where the caller read the row back and found none. */
  targetFound?: boolean;
  /**
   * Re-checked after the count reads resolve, so a caller whose sample can be
   * superseded mid-call publishes nothing rather than half of a stale set.
   * Supplied by the presence sampler, which owns a generation; hello has none
   * to lose — it is neither rate-limited nor latched — and omits it.
   */
  isCurrentSample?: () => boolean;
}): Promise<number | undefined> {
  let queuedCount: number;
  let inFlightCount: number;

  try {
    [queuedCount, inFlightCount] = await Promise.all([
      desktopCommandStore.countCommandsForTarget(
        targetId,
        DesktopCommandStatus.Queued
      ),
      desktopCommandStore.countCommandsForTarget(targetId, [
        DesktopCommandStatus.Accepted,
        DesktopCommandStatus.Running,
      ]),
    ]);
  } catch (error) {
    log.warn("fleet.capacity_metrics.query_failed", {
      computeTargetId: targetId,
      error,
    });
    return;
  }

  // The two counts above are awaited reads, so a generation the caller checked
  // BEFORE this call can be lost inside it — and these are the likelier stall,
  // being two of the three reads on the path. Checked here rather than at the
  // call site so it covers every emit below, including the queue gauges: a
  // superseded sample publishes nothing at all, not a partial set interleaved
  // with its replacement's.
  if (isCurrentSample && !isCurrentSample()) {
    return;
  }

  emitQueueMetric({
    metric: "queued_command_count",
    value: queuedCount,
    computeTargetId: targetId,
    origin: ORIGIN,
    filterToken: FilterToken.CommandQueued,
  });
  emitQueueMetric({
    metric: "in_flight_command_count",
    value: inFlightCount,
    computeTargetId: targetId,
    origin: ORIGIN,
    filterToken: FilterToken.CommandDispatched,
  });

  // Absence is expected version skew — a desktop older than the capability
  // never reports one — so it belongs at debug, off the warn dashboards and
  // alerts a real data defect should reach. Not a volume control: `makeLogFn`
  // ships every level identically once `DD.target` is set, and no `status:debug`
  // exclusion filter exists, so the demotion changes the `status` attribute and
  // nothing else. Volume is bounded by the presence sampler's interval gate.
  //
  // A missing row reaches this same branch with nothing to read, so `reason` is
  // what separates a skewed desktop from a target deleted mid-connection.
  if (maxInFlightCommands === undefined) {
    log.debug("executor_saturation_skipped", {
      event: "executor_saturation_skipped",
      reason: targetFound ? "maxInFlightCommands_absent" : "target_not_found",
      computeTargetId: targetId,
    });
    return queuedCount;
  }

  // Matches the wire contract this value is admitted under
  // (`desktop-gateway-wire.ts`: finite, min 1, floored). The column is written
  // unvalidated, so a fractional capacity would divide into a confident
  // saturation above 1.0 and read as real overload, and an unsafe magnitude
  // into an equally confident near-zero that reads as an idle executor.
  // `isSafeInteger` rejects a non-number too, which is reachable here because
  // the hello payload is wire input whatever the parameter type says.
  if (!Number.isSafeInteger(maxInFlightCommands) || maxInFlightCommands < 1) {
    log.warn("executor_saturation_skipped", {
      event: "executor_saturation_skipped",
      reason: "maxInFlightCommands_invalid",
      computeTargetId: targetId,
      maxInFlightCommands,
    });
    return queuedCount;
  }

  // No command status reconstructs this number. `maxInFlightCommands` bounds
  // `inFlightByCommandId` inside the desktop's own scheduler, and BOTH database
  // proxies for that set are wrong in opposite directions: `Accepted` is stamped
  // at ENQUEUE (`cloud-command-executor.ts` `enqueue`), so it counts the client's
  // whole queue — ISS-8453 read 53.0 for a desktop that never ran more than its
  // declared 2 — while `Running` depends on a `status` event that
  // `ingestCommandEvent` drops outright on a sequence gap, which would report an
  // idle executor for a pinned one. So this reads the count the desktop itself
  // sends, and emits nothing when it did not send one.
  if (activeCommands === undefined) {
    log.debug("executor_saturation_skipped", {
      event: "executor_saturation_skipped",
      reason: "activeCommands_absent",
      computeTargetId: targetId,
    });
    return queuedCount;
  }

  // Shared with the relay's occupancy cache, which replays whatever it accepts
  // on every heartbeat: a predicate that drifts from this one lets the cache
  // hold a value this branch then rejects on every sample (ISS-8531 §2).
  if (!isReportableActiveCommands(activeCommands)) {
    log.warn("executor_saturation_skipped", {
      event: "executor_saturation_skipped",
      reason: "activeCommands_invalid",
      computeTargetId: targetId,
      // Rendered and bounded, not passed through: the raw value is
      // caller-controlled and may be an arbitrarily large JSON structure.
      activeCommands: String(activeCommands).slice(0, 64),
    });
    return queuedCount;
  }

  // Intentionally unclamped: >1.0 signals overload (e.g. maxInFlightCommands lowered mid-flight).
  const value = activeCommands / maxInFlightCommands;
  emitQueueMetric({
    metric: "executor_saturation",
    value,
    computeTargetId: targetId,
    origin: ORIGIN,
  });
  return queuedCount;
}

const RELAY_SOCKET_AUTH_METHOD: AuthContext["authMethod"] = "api_key";
