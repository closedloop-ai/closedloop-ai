import {
  classifyDesktopCommandAckRejection,
  DESKTOP_COMMAND_ACK_DEADLINE_MS,
  resolveDesktopCommandAckOutcome,
} from "@repo/api/src/types/desktop-command-ack";
import { log } from "@repo/observability/log";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import { buildTelemetryTraceContext } from "@repo/observability/telemetry/context";
import { emitProtocolMetric } from "@repo/observability/telemetry/metrics";
import { ORIGIN } from "@repo/observability/telemetry/origin";
import { acknowledgeDesktopCommand } from "@/lib/desktop-command-ack-handler";
import { getRealDesktopCommandTelemetryContext } from "@/lib/desktop-command-telemetry-context";
import { isRecord } from "@/lib/type-guards";
import { scheduleQueuedCommandRelease } from "./command-drain";
import type { CorrelationContext, SocketEventResponse } from "./types";

/**
 * ISS-7486: extracted from `service.ts` so the rejection-reason tag lands here
 * rather than growing a file that was over the 1,000-line ceiling.
 *
 * Lives under `service/` beside `hello-handler` and `github-dirty-scope-drain`:
 * `main` decomposed the same file into that directory while this branch was
 * open, and one decomposition is better than two. This module was originally a
 * sibling of `service.ts`; it moved on merge rather than establishing a second
 * layout for the same idea.
 */
export async function handleCommandAck(
  payload: unknown,
  targetId: string,
  correlation: Partial<CorrelationContext>
): Promise<SocketEventResponse> {
  if (!isRecord(payload)) {
    return { emit: [] };
  }

  if (
    typeof payload.commandId !== "string" ||
    typeof payload.accepted !== "boolean"
  ) {
    return { emit: [] };
  }

  const commandId = payload.commandId;
  const accepted = payload.accepted;
  const reason =
    typeof payload.reason === "string" ? payload.reason : undefined;

  const ctx = buildTelemetryTraceContext({
    ...correlation,
    commandId,
    computeTargetId: targetId,
  });

  // `rejectionReason` is the bounded metric dimension and is present ONLY on a
  // rejection — an accepted ack carrying `unspecified` would land accepted
  // traffic in a rejection bucket. `reason` stays the raw wire string for log
  // search; only the folded code is safe to tag a metric with.
  //
  // ISS-7223: `ackOutcome` rides beside `accepted`, not instead of it. It is the
  // dimension `relay.command_acks` groups by so the third outcome — no ack at
  // all, emitted by the ack-timeout sweep — is a bucket rather than a
  // subtraction of two counters. `accepted` stays because every existing monitor
  // and dashboard query already reads it.
  log.info("Relay command ack received", {
    commandId,
    accepted,
    ackOutcome: resolveDesktopCommandAckOutcome(accepted),
    computeTargetId: ctx.computeTargetId,
    gatewaySessionIdHash: redactGatewaySessionId(ctx.gatewaySessionId),
    requestId: ctx.requestId,
    ...(accepted
      ? {}
      : {
          reason,
          rejectionReason: classifyDesktopCommandAckRejection(reason),
        }),
  });

  const commandContext = getRealDesktopCommandTelemetryContext(ctx);
  if (!commandContext) {
    log.info("command.ack.lifecycle_context_omitted", {
      commandId,
      computeTargetId: ctx.computeTargetId,
      gatewaySessionIdHash: redactGatewaySessionId(ctx.gatewaySessionId),
      requestId: ctx.requestId,
      reason: "missing_gateway_session",
    });
    emitProtocolMetric({
      metric: "command_ack_lifecycle_context_omitted",
      origin: ORIGIN,
      count: 1,
      computeTargetId: targetId,
      gatewaySessionId: ctx.gatewaySessionId,
    });
  }

  const acknowledged = await acknowledgeDesktopCommand({
    commandId,
    accepted,
    reason,
    targetId,
    ...(commandContext ? { context: commandContext } : {}),
  });

  // A refusal retires the command, so the slot it was going to occupy is free
  // immediately. An ACCEPTED ack is the opposite — it fills a slot — so the
  // release belongs only in this branch.
  if (!accepted) {
    scheduleQueuedCommandRelease(targetId);
  }

  if (acknowledged) {
    const latencyMs = Date.now() - new Date(acknowledged.createdAt).getTime();
    emitProtocolMetric({
      metric: "ack_latency",
      origin: ORIGIN,
      value: latencyMs,
      computeTargetId: targetId,
      gatewaySessionId: ctx.gatewaySessionId,
    });

    // ISS-7223: the overlap term. The ack-timeout sweep changes no command
    // state, so a command it already reported `timed_out` can still be acked —
    // and then the same command has produced two outcome events. That makes the
    // three outcomes a set of observations rather than a partition, and summing
    // them would overcount. This names the intersection exactly, off the SAME
    // deadline the sweep uses, so `timed_out` minus `lateAck` is the count that
    // genuinely never resolved rather than a guess.
    //
    // Emitted only past the deadline, so it costs nothing on the common path.
    if (latencyMs >= DESKTOP_COMMAND_ACK_DEADLINE_MS) {
      log.info("Relay command ack arrived late", {
        commandId,
        computeTargetId: ctx.computeTargetId,
        ackOutcome: resolveDesktopCommandAckOutcome(accepted),
        lateAck: true,
        latencyMs,
      });
    }
  }

  return { emit: [] };
}
