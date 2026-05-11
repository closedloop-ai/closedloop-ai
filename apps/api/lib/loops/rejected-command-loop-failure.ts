import { createHash } from "node:crypto";
import type { JsonObject } from "@repo/api/src/types/common";
import { LoopErrorCode, LoopStatus } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { isRecord } from "@/lib/type-guards";

const SYMPHONY_LOOP_OPERATION_ID = "symphony_loop";
const COMMAND_SIGNING_KEY_AUTH_REJECTION_REASON_VALUES = [
  "unauthorized: no keys authorized",
  "unauthorized: unknown signing key",
] as const;
type CommandSigningKeyAuthorizationRejectionReason =
  (typeof COMMAND_SIGNING_KEY_AUTH_REJECTION_REASON_VALUES)[number];
const COMMAND_SIGNING_KEY_AUTH_REJECTION_REASONS = new Set<string>(
  COMMAND_SIGNING_KEY_AUTH_REJECTION_REASON_VALUES
);
const TERMINAL_LOOP_STATUSES = new Set<string>([
  LoopStatus.Completed,
  LoopStatus.Failed,
  LoopStatus.Cancelled,
  LoopStatus.TimedOut,
]);
const LOOP_FAILED_FROM_STATUSES = [
  LoopStatus.Pending,
  LoopStatus.Claimed,
  LoopStatus.Running,
];

type RejectedLoopFailureResult =
  | { failed: true; loopId: string }
  | { failed: false; reason: string };

export function isCommandSigningKeyAuthorizationRejectionReason(
  reason: string | undefined
): reason is CommandSigningKeyAuthorizationRejectionReason {
  return (
    reason !== undefined &&
    COMMAND_SIGNING_KEY_AUTH_REJECTION_REASONS.has(reason)
  );
}

function readLoopIdFromRequestPayload(payload: unknown): string | null {
  if (!(isRecord(payload) && isRecord(payload.body))) {
    return null;
  }
  return typeof payload.body.loopId === "string" ? payload.body.loopId : null;
}

function buildSigningAuthorizationMessage(reason: string): string {
  return reason === "unauthorized: no keys authorized"
    ? "Desktop rejected the signed loop command because no browser command signing keys are authorized."
    : "Desktop rejected the signed loop command because the browser signing key is not authorized.";
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

async function markLoopFailedForSigningAuthorization(input: {
  loopId: string;
  organizationId: string;
  message: string;
}): Promise<RejectedLoopFailureResult> {
  const completedAt = new Date();
  const result = await withDb((db) =>
    db.loop.updateMany({
      where: {
        id: input.loopId,
        organizationId: input.organizationId,
        status: { in: LOOP_FAILED_FROM_STATUSES },
      },
      data: {
        status: LoopStatus.Failed,
        completedAt,
        error: {
          code: LoopErrorCode.AuthChallenge,
          message: input.message,
        },
      },
    })
  );

  if (result.count === 0) {
    const current = await withDb((db) =>
      db.loop.findUnique({
        where: { id: input.loopId, organizationId: input.organizationId },
        select: { status: true },
      })
    );
    if (!current) {
      return { failed: false, reason: "loop_not_found_for_target" };
    }
    if (TERMINAL_LOOP_STATUSES.has(current.status)) {
      log.info(
        "[rejected-command-loop-failure] Loop already terminal; skipping rejected command failure",
        { loopId: input.loopId, from: current.status }
      );
      return { failed: false, reason: "loop_already_terminal" };
    }
    return { failed: false, reason: "invalid_status_transition" };
  }

  await withDb((db) =>
    db.loop.updateMany({
      where: {
        id: input.loopId,
        organizationId: input.organizationId,
        startedAt: null,
      },
      data: { startedAt: completedAt },
    })
  );

  log.info("Loop status updated", {
    loopId: input.loopId,
    to: LoopStatus.Failed,
  });

  return { failed: true, loopId: input.loopId };
}

async function addSystemLoopErrorEvent(input: {
  loopId: string;
  data: JsonObject;
}): Promise<void> {
  const event = { type: "error", data: input.data };
  const eventId = createHash("sha256")
    .update(JSON.stringify(event))
    .digest("hex");

  try {
    await withDb((db) =>
      db.loopEvent.create({
        data: {
          loopId: input.loopId,
          type: event.type,
          data: input.data,
          eventSource: "system",
          eventId,
        },
      })
    );
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      return;
    }
    throw error;
  }
}

/**
 * Fails a loop only for Desktop command-signing key authorization rejections
 * that can be bound to the exact target-scoped symphony_loop command body.
 */
export async function failLoopFromRejectedCommand(input: {
  commandId: string;
  targetId: string;
  reason: string | undefined;
}): Promise<RejectedLoopFailureResult> {
  const reason = input.reason;
  if (!isCommandSigningKeyAuthorizationRejectionReason(reason)) {
    return { failed: false, reason: "non_key_authorization_reason" };
  }

  const command = await withDb((db) =>
    db.desktopCommand.findUnique({
      where: { id: input.commandId },
      select: {
        computeTargetId: true,
        operationId: true,
        requestPayload: true,
      },
    })
  );
  if (!command) {
    return { failed: false, reason: "command_not_found" };
  }
  if (
    command.computeTargetId !== input.targetId ||
    command.operationId !== SYMPHONY_LOOP_OPERATION_ID
  ) {
    return { failed: false, reason: "command_not_loop_scoped_to_target" };
  }

  const loopId = readLoopIdFromRequestPayload(command.requestPayload);
  if (!loopId) {
    return { failed: false, reason: "missing_loop_id" };
  }

  const loop = await withDb((db) =>
    db.loop.findFirst({
      where: {
        id: loopId,
        computeTargetId: input.targetId,
      },
      select: {
        organizationId: true,
        status: true,
      },
    })
  );
  if (!loop) {
    return { failed: false, reason: "loop_not_found_for_target" };
  }
  if (TERMINAL_LOOP_STATUSES.has(loop.status)) {
    return { failed: false, reason: "loop_already_terminal" };
  }

  const message = buildSigningAuthorizationMessage(reason);
  const failureResult = await markLoopFailedForSigningAuthorization({
    loopId,
    organizationId: loop.organizationId,
    message,
  });
  if (!failureResult.failed) {
    return failureResult;
  }

  await addSystemLoopErrorEvent({
    loopId,
    data: {
      type: "error",
      code: LoopErrorCode.AuthChallenge,
      message,
      timestamp: new Date().toISOString(),
      result: {
        commandId: input.commandId,
        computeTargetId: input.targetId,
        reason,
      },
    } satisfies JsonObject,
  });

  return failureResult;
}
