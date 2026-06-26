import {
  BROWSER_COMMAND_KEY_REVOKE_INVALID_REASON,
  BROWSER_COMMAND_KEY_REVOKE_METHOD,
  BROWSER_COMMAND_KEY_REVOKE_OPERATION_ID,
  BROWSER_COMMAND_KEY_REVOKE_PATH,
  BROWSER_COMMAND_KEY_TARGET_CONTEXT_MISMATCH_REASON,
} from "../shared/contracts.js";
import { normalizeCommandKeyFingerprint } from "./authorized-command-key-store.js";
import type {
  DesktopCommandAckEvent,
  DesktopCommandEvent,
  DesktopCommandStreamEvent,
} from "./cloud-protocol.js";
import {
  type ActiveCommandKeyTargetContext,
  browserCommandKeyTargetContextMatches,
  parseBrowserCommandKeyCommandTargetContext,
} from "./command-key-target-context.js";

export type BrowserCommandKeyRevocationMatch =
  | "match"
  | "mismatch"
  | "not_reserved";

/**
 * Identifies the reserved server-control command that may bypass browser
 * command-signature enforcement to revoke the key that might otherwise be
 * required to authorize the revocation itself.
 */
export function classifyBrowserCommandKeyRevocationCommand(
  command: Pick<DesktopCommandEvent, "method" | "operationId" | "path">
): BrowserCommandKeyRevocationMatch {
  const referencesReservedCommand =
    command.operationId === BROWSER_COMMAND_KEY_REVOKE_OPERATION_ID ||
    command.path === BROWSER_COMMAND_KEY_REVOKE_PATH;
  if (!referencesReservedCommand) {
    return "not_reserved";
  }
  return command.operationId === BROWSER_COMMAND_KEY_REVOKE_OPERATION_ID &&
    command.path === BROWSER_COMMAND_KEY_REVOKE_PATH &&
    command.method === BROWSER_COMMAND_KEY_REVOKE_METHOD
    ? "match"
    : "mismatch";
}

export type BrowserCommandKeyRevocationBody =
  | { ok: true; fingerprint: string }
  | { ok: false; reason: typeof BROWSER_COMMAND_KEY_REVOKE_INVALID_REASON };

type CommandAckPayload = Pick<
  DesktopCommandAckEvent,
  "commandId" | "accepted" | "state" | "reason"
>;
type CommandEventPayload = Pick<
  DesktopCommandStreamEvent,
  "commandId" | "sequence" | "eventType" | "data"
>;

export type BrowserCommandKeyRevocationHandlerOptions = {
  removeAuthorizedKey: (fingerprint: string) => boolean;
  getActiveTargetContext?: () => ActiveCommandKeyTargetContext | undefined;
  sendCommandAck: (event: CommandAckPayload) => void;
  sendCommandEvent: (event: CommandEventPayload) => void;
  onChanged?: () => void;
  log?: (level: "warn", message: string) => void;
};

/** Validates the narrow revocation command body before any local mutation. */
export function parseBrowserCommandKeyRevocationBody(
  body: unknown
): BrowserCommandKeyRevocationBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: BROWSER_COMMAND_KEY_REVOKE_INVALID_REASON };
  }
  const fingerprint = normalizeCommandKeyFingerprint(
    (body as Record<string, unknown>).fingerprint
  );
  if (!fingerprint) {
    return { ok: false, reason: BROWSER_COMMAND_KEY_REVOKE_INVALID_REASON };
  }
  return { ok: true, fingerprint };
}

export function handleBrowserCommandKeyRevocationCommand(
  command: DesktopCommandEvent,
  options: BrowserCommandKeyRevocationHandlerOptions
): void {
  const parsed = parseBrowserCommandKeyRevocationBody(command.body);
  if (!parsed.ok) {
    options.log?.(
      "warn",
      `Rejected browser command key revocation ${command.commandId}: ${parsed.reason}`
    );
    options.sendCommandAck({
      commandId: command.commandId,
      accepted: false,
      state: "failed",
      reason: parsed.reason,
    });
    return;
  }

  const commandTargetContext = parseBrowserCommandKeyCommandTargetContext(
    command.body
  );
  if (commandTargetContext.kind === "invalid") {
    options.log?.(
      "warn",
      `Rejected browser command key revocation ${command.commandId}: ${BROWSER_COMMAND_KEY_REVOKE_INVALID_REASON}`
    );
    options.sendCommandAck({
      commandId: command.commandId,
      accepted: false,
      state: "failed",
      reason: BROWSER_COMMAND_KEY_REVOKE_INVALID_REASON,
    });
    return;
  }
  if (
    commandTargetContext.kind === "present" &&
    !browserCommandKeyTargetContextMatches({
      commandContext: commandTargetContext,
      activeContext: options.getActiveTargetContext?.(),
    })
  ) {
    options.log?.(
      "warn",
      `Rejected browser command key revocation ${command.commandId}: ${BROWSER_COMMAND_KEY_TARGET_CONTEXT_MISMATCH_REASON}`
    );
    options.sendCommandAck({
      commandId: command.commandId,
      accepted: false,
      state: "failed",
      reason: BROWSER_COMMAND_KEY_TARGET_CONTEXT_MISMATCH_REASON,
    });
    return;
  }

  try {
    const removed = options.removeAuthorizedKey(parsed.fingerprint);
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
        removed,
      },
    });
    if (removed) {
      options.onChanged?.();
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "failed to revoke key";
    options.log?.(
      "warn",
      `Failed browser command key revocation ${command.commandId}: ${message}`
    );
    options.sendCommandAck({
      commandId: command.commandId,
      accepted: false,
      state: "failed",
      reason: "browser command key revocation failed",
    });
  }
}
