/**
 * Desktop loop dispatch — builds a command payload and dispatches it
 * to the electron harness via the desktop gateway.
 */

import {
  CURRENT_DESKTOP_API_NAMESPACE,
  type DesktopApiNamespace,
  getDesktopApiNamespaceFromCapabilities,
  rewriteDesktopApiPath,
} from "@repo/api/src/desktop-api-namespace";
import type { JsonValue } from "@repo/api/src/types/common";
import type { AdditionalRepoRef, LoopCommand } from "@repo/api/src/types/loop";
import type { SymphonyLoopBody } from "@repo/api/src/types/symphony-loop-body";
import { log } from "@repo/observability/log";
import { toRelayOperation } from "@/app/compute-targets/relay-command-helpers";
import { computeTargetsService } from "@/app/compute-targets/service";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  toEnvelope,
  toWireCommandFromRelayOperation,
} from "@/lib/desktop-gateway-wire";
import { relayEventBus } from "@/lib/relay-event-bus";
import type { ContextPack } from "./loop-state";

/**
 * Throws if the relay reported delivered: false (target offline/disconnected).
 * Only called when throwOnFailure is true and the HTTP response was 2xx.
 */
async function assertDelivered(
  response: Response,
  context: { label: string; loopId: string; commandId: string }
): Promise<void> {
  const result = (await response.json().catch(() => null)) as {
    delivered?: boolean;
    reason?: string;
  } | null;
  if (result && result.delivered === false) {
    log.error(`[loop-desktop] ${context.label} relay dispatch not delivered`, {
      loopId: context.loopId,
      commandId: context.commandId,
      reason: result.reason,
    });
    throw new RelayDispatchNotDeliveredError(result.reason);
  }
}

/**
 * Dispatch a relay operation to a desktop compute target.
 * Shared by launch and kill paths.
 */
async function dispatchRelayOperation(
  computeTargetId: string,
  relayOperation: ReturnType<typeof toRelayOperation>,
  context: { label: string; loopId: string; commandId: string },
  throwOnFailure = false
): Promise<void> {
  const relayApiUrl = process.env.RELAY_API_URL;
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (relayApiUrl && internalSecret) {
    try {
      // Wrap in wire envelope format expected by relay server
      const wireCommand = toWireCommandFromRelayOperation(relayOperation);
      if (!wireCommand) {
        const err = new Error(
          "Failed to convert relay operation to wire command"
        );
        log.error(`[loop-desktop] ${context.label} wire conversion failed`, {
          loopId: context.loopId,
          commandId: context.commandId,
        });
        if (throwOnFailure) {
          throw err;
        }
        return;
      }
      const envelopedCommand = toEnvelope(wireCommand);

      const response = await fetch(`${relayApiUrl}/dispatch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": internalSecret,
        },
        body: JSON.stringify({
          targetId: computeTargetId,
          operation: envelopedCommand,
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
        if (throwOnFailure) {
          throw new Error(
            `Relay dispatch failed with status ${response.status}`
          );
        }
      } else if (throwOnFailure) {
        // Check the delivered flag -- a 200 with delivered: false means the
        // target was offline or disconnected. Fail loudly so the caller
        // does not report success for a loop that never reached the desktop.
        await assertDelivered(response, context);
      }
    } catch (dispatchError) {
      log.error(`[loop-desktop] ${context.label} failed to dispatch to relay`, {
        loopId: context.loopId,
        commandId: context.commandId,
        error: dispatchError,
      });
      if (throwOnFailure) {
        throw dispatchError;
      }
    }
  } else {
    relayEventBus.publishOperation(computeTargetId, relayOperation);
  }
}

export class DispatchError extends Error {
  readonly commandId: string;
  readonly dispatchReason?: string;
  constructor(message: string, commandId: string, dispatchReason?: string) {
    super(message);
    this.name = "DispatchError";
    this.commandId = commandId;
    this.dispatchReason = dispatchReason;
  }
}

export function isDispatchError(error: unknown): error is DispatchError {
  return error instanceof DispatchError;
}

class RelayDispatchNotDeliveredError extends Error {
  readonly reason?: string;
  constructor(reason?: string) {
    super(`Relay dispatch not delivered: ${reason ?? "target offline"}`);
    this.name = "RelayDispatchNotDeliveredError";
    this.reason = reason;
  }
}

type LaunchDesktopOpts = {
  loopId: string;
  organizationId: string;
  command: LoopCommand;
  computeTargetId: string;
  desktopApiNamespace?: DesktopApiNamespace;
  closedLoopAuthToken: string;
  apiBaseUrl: string;
  contextPack: ContextPack;
  documentSlug?: string;
  parentLoopId?: string;
  parentBranchName?: string;
  parentSessionId?: string;
  localRepoPath?: string;
  additionalRepos?: AdditionalRepoRef[];
};

async function resolveDesktopApiNamespace(
  computeTargetId: string,
  namespaceHint?: DesktopApiNamespace
): Promise<DesktopApiNamespace> {
  if (namespaceHint) {
    return namespaceHint;
  }

  const target = await computeTargetsService.findById(computeTargetId);
  return (
    getDesktopApiNamespaceFromCapabilities(
      target?.capabilities as Record<string, unknown> | null
    ) ?? CURRENT_DESKTOP_API_NAMESPACE
  );
}

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
    desktopApiNamespace,
    closedLoopAuthToken,
    apiBaseUrl,
    contextPack,
    documentSlug,
    parentLoopId,
    parentBranchName,
    parentSessionId,
    localRepoPath,
    additionalRepos,
  } = opts;
  const namespace = await resolveDesktopApiNamespace(
    computeTargetId,
    desktopApiNamespace
  );

  const input = {
    operationId: "symphony_loop",
    method: "POST" as const,
    path: rewriteDesktopApiPath("/api/gateway/symphony/loop", namespace),
    body: {
      loopId,
      command,
      closedLoopAuthToken,
      apiBaseUrl,
      artifacts: contextPack.artifacts,
      prompt: contextPack.prompt ?? null,
      repo: contextPack.repoInfo ?? null,
      committer: contextPack.committer ?? null,
      artifactSlug: documentSlug ?? null,
      parentLoopId: parentLoopId ?? null,
      parentBranchName: parentBranchName ?? null,
      parentSessionId: parentSessionId ?? null,
      localRepoPath: localRepoPath ?? null,
      userContext: contextPack.userContext,
      attachments: contextPack.attachments,
      additionalRepos: additionalRepos?.map((r) => ({
        fullName: r.fullName,
        branch: r.branch,
      })),
    } satisfies SymphonyLoopBody as JsonValue,
  };

  const createResult = await desktopCommandStore.createCommand(
    computeTargetId,
    input
  );
  const commandId = createResult.command.commandId;

  const relayOperation = toRelayOperation(commandId, input);

  try {
    await dispatchRelayOperation(
      computeTargetId,
      relayOperation,
      { label: "Launch", loopId, commandId },
      true
    );
  } catch (err) {
    const dispatchReason =
      err instanceof RelayDispatchNotDeliveredError ? err.reason : undefined;
    throw new DispatchError(
      err instanceof Error ? err.message : String(err),
      commandId,
      dispatchReason
    );
  }

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
  const namespace = await resolveDesktopApiNamespace(computeTargetId);
  const killInput = {
    operationId: "symphony_loop_kill",
    method: "POST" as const,
    path: rewriteDesktopApiPath("/api/gateway/symphony/loop/kill", namespace),
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
