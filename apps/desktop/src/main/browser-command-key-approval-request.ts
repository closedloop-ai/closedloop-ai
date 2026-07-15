import {
  BROWSER_COMMAND_KEY_APPROVAL_REQUEST_INVALID_REASON,
  BROWSER_COMMAND_KEY_APPROVAL_REQUEST_METHOD,
  BROWSER_COMMAND_KEY_APPROVAL_REQUEST_OPERATION_ID,
  BROWSER_COMMAND_KEY_APPROVAL_REQUEST_PATH,
  BROWSER_COMMAND_KEY_TARGET_CONTEXT_MISMATCH_REASON,
} from "../shared/contracts.js";
import { normalizeCommandKeyFingerprint } from "./authorized-command-key-store.js";
import type { DesktopCommandEvent } from "./cloud-protocol.js";
import {
  type ActiveCommandKeyTargetContext,
  browserCommandKeyTargetContextMatches,
  parseBrowserCommandKeyCommandTargetContext,
} from "./command-key-target-context.js";
import {
  type ReservedCommandAckPayload as CommandAckPayload,
  type ReservedCommandEventPayload as CommandEventPayload,
  classifyReservedCommand,
  type ReservedCommandMatch,
  rejectReservedCommand,
} from "./reserved-command-handler.js";

export type BrowserCommandKeyApprovalRequestMatch = ReservedCommandMatch;

/**
 * Identifies the reserved server-control command that asks Desktop to surface
 * a pending browser command key approval without trusting the key automatically.
 */
export function classifyBrowserCommandKeyApprovalRequestCommand(
  command: Pick<DesktopCommandEvent, "method" | "operationId" | "path">
): BrowserCommandKeyApprovalRequestMatch {
  return classifyReservedCommand(command, {
    method: BROWSER_COMMAND_KEY_APPROVAL_REQUEST_METHOD,
    operationId: BROWSER_COMMAND_KEY_APPROVAL_REQUEST_OPERATION_ID,
    path: BROWSER_COMMAND_KEY_APPROVAL_REQUEST_PATH,
  });
}

export type BrowserCommandKeyApprovalRequestBody =
  | { ok: true; fingerprint: string }
  | {
      ok: false;
      reason: typeof BROWSER_COMMAND_KEY_APPROVAL_REQUEST_INVALID_REASON;
    };

export type BrowserCommandKeyApprovalRequestHandlerOptions = {
  notifyPendingKeys: (fingerprint: string) => Promise<void> | void;
  getActiveTargetContext?: () => ActiveCommandKeyTargetContext | undefined;
  onLegacyContextlessApproval?: (fingerprint: string) => void;
  sendCommandAck: (event: CommandAckPayload) => void;
  sendCommandEvent: (event: CommandEventPayload) => void;
  onChanged?: () => void;
  log?: (level: "warn", message: string) => void;
};

/** Validates the reserved approval-request body before notification side effects. */
export function parseBrowserCommandKeyApprovalRequestBody(
  body: unknown
): BrowserCommandKeyApprovalRequestBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      reason: BROWSER_COMMAND_KEY_APPROVAL_REQUEST_INVALID_REASON,
    };
  }
  const fingerprint = normalizeCommandKeyFingerprint(
    (body as Record<string, unknown>).fingerprint
  );
  if (!fingerprint) {
    return {
      ok: false,
      reason: BROWSER_COMMAND_KEY_APPROVAL_REQUEST_INVALID_REASON,
    };
  }
  return { ok: true, fingerprint };
}

export function handleBrowserCommandKeyApprovalRequestCommand(
  command: DesktopCommandEvent,
  options: BrowserCommandKeyApprovalRequestHandlerOptions
): void {
  const parsed = parseBrowserCommandKeyApprovalRequestBody(command.body);
  if (!parsed.ok) {
    rejectBrowserCommandKeyApprovalRequest(command, options, parsed.reason);
    return;
  }

  const commandTargetContext = parseBrowserCommandKeyCommandTargetContext(
    command.body
  );
  if (commandTargetContext.kind === "invalid") {
    rejectBrowserCommandKeyApprovalRequest(
      command,
      options,
      BROWSER_COMMAND_KEY_APPROVAL_REQUEST_INVALID_REASON
    );
    return;
  }
  if (
    commandTargetContext.kind === "present" &&
    !browserCommandKeyTargetContextMatches({
      commandContext: commandTargetContext,
      activeContext: options.getActiveTargetContext?.(),
    })
  ) {
    rejectBrowserCommandKeyApprovalRequest(
      command,
      options,
      BROWSER_COMMAND_KEY_TARGET_CONTEXT_MISMATCH_REASON
    );
    return;
  }

  if (commandTargetContext.kind === "absent") {
    options.onLegacyContextlessApproval?.(parsed.fingerprint);
  }

  options.sendCommandAck({
    commandId: command.commandId,
    accepted: true,
    state: "accepted",
  });
  options.sendCommandEvent({
    commandId: command.commandId,
    sequence: 1,
    eventType: "done",
    data: {
      type: "done",
      fingerprint: parsed.fingerprint,
    },
  });
  options.onChanged?.();
  void Promise.resolve(options.notifyPendingKeys(parsed.fingerprint)).catch(
    (error) => {
      const message =
        error instanceof Error
          ? error.message
          : "failed to notify pending browser command key";
      options.log?.(
        "warn",
        `Browser command key approval request notification failed ${command.commandId}: ${message}`
      );
    }
  );
}

function rejectBrowserCommandKeyApprovalRequest(
  command: DesktopCommandEvent,
  options: BrowserCommandKeyApprovalRequestHandlerOptions,
  reason: string
): void {
  rejectReservedCommand(
    command,
    options,
    "browser command key approval request",
    reason
  );
}
