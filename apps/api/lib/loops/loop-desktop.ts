/**
 * Desktop loop dispatch — builds a command payload and dispatches it
 * to the electron harness via the desktop gateway.
 */

import type { JsonValue } from "@repo/api/src/types/common";
import type { LoopCommand } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { toRelayOperation } from "@/app/compute-targets/relay-command-helpers";
import { env } from "@/env";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { relayEventBus } from "@/lib/relay-event-bus";
import type { ContextPack } from "./loop-state";

/**
 * Dispatch a relay operation to a desktop compute target.
 * Shared by launch and kill paths.
 */
async function dispatchRelayOperation(
  computeTargetId: string,
  relayOperation: ReturnType<typeof toRelayOperation>,
  context: { label: string; loopId: string; commandId: string }
): Promise<void> {
  const relayApiUrl = env.RELAY_API_URL;
  const internalSecret = env.INTERNAL_API_SECRET;
  if (relayApiUrl && internalSecret) {
    try {
      const response = await fetch(`${relayApiUrl}/dispatch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": internalSecret,
        },
        body: JSON.stringify({
          targetId: computeTargetId,
          operation: relayOperation,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        log.error(`[loop-desktop] ${context.label} relay dispatch failed`, {
          loopId: context.loopId,
          commandId: context.commandId,
          status: response.status,
          body,
        });
      }
    } catch (dispatchError) {
      log.error(`[loop-desktop] ${context.label} failed to dispatch to relay`, {
        loopId: context.loopId,
        commandId: context.commandId,
        error: dispatchError,
      });
    }
  } else {
    relayEventBus.publishOperation(computeTargetId, relayOperation);
  }
}

type LaunchDesktopOpts = {
  loopId: string;
  organizationId: string;
  command: LoopCommand;
  computeTargetId: string;
  closedLoopAuthToken: string;
  apiBaseUrl: string;
  contextPack: ContextPack;
  parentBranchName?: string;
  parentSessionId?: string;
};

/**
 * Launch a loop on a desktop compute target.
 * Builds a WireCommandPayload-compatible input for the electron harness
 * and dispatches it via the desktop gateway.
 *
 * @returns The desktop command ID
 */
export async function launchLoopOnDesktop(
  opts: LaunchDesktopOpts
): Promise<string> {
  const {
    loopId,
    command,
    computeTargetId,
    closedLoopAuthToken,
    apiBaseUrl,
    contextPack,
    parentBranchName,
    parentSessionId,
  } = opts;

  const input = {
    operationId: "symphony_loop",
    method: "POST" as const,
    path: "/api/engineer/symphony/loop",
    body: {
      loopId,
      command,
      closedLoopAuthToken,
      apiBaseUrl,
      artifacts: contextPack.artifacts,
      prompt: contextPack.prompt ?? null,
      repo: contextPack.repoInfo ?? null,
      committer: contextPack.committer ?? null,
      parentBranchName: parentBranchName ?? null,
      parentSessionId: parentSessionId ?? null,
    } as JsonValue,
  };

  const createResult = await desktopCommandStore.createCommand(
    computeTargetId,
    input
  );
  const commandId = createResult.command.commandId;

  const relayOperation = toRelayOperation(commandId, input);

  await dispatchRelayOperation(computeTargetId, relayOperation, {
    label: "Launch",
    loopId,
    commandId,
  });

  log.info("[loop-desktop] Desktop loop command dispatched", {
    loopId,
    commandId,
    computeTargetId,
  });

  return commandId;
}

/**
 * Dispatch a kill command to a desktop compute target.
 * Extracted from the DELETE route to keep routes thin.
 */
export async function stopDesktopLoop(
  loopId: string,
  computeTargetId: string
): Promise<void> {
  const killInput = {
    operationId: "symphony_loop_kill",
    method: "POST" as const,
    path: "/api/engineer/symphony/loop/kill",
    body: { loopId },
  };
  const createResult = await desktopCommandStore.createCommand(
    computeTargetId,
    killInput
  );
  const commandId = createResult.command.commandId;
  const relayOp = toRelayOperation(commandId, killInput);

  await dispatchRelayOperation(computeTargetId, relayOp, {
    label: "Kill",
    loopId,
    commandId,
  });

  log.info("[loop-desktop] Desktop kill command dispatched", {
    loopId,
    commandId,
    computeTargetId,
  });
}
