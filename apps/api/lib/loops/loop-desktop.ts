/**
 * Desktop loop dispatch — builds a command payload and dispatches it
 * to the electron harness via the desktop gateway.
 */

import {
  CURRENT_DESKTOP_API_NAMESPACE,
  rewriteDesktopApiPath,
} from "@repo/api/src/desktop-api-namespace";
import type { JsonValue } from "@repo/api/src/types/common";
import type {
  BrowserSignedCommandId,
  CreateDesktopCommandInput,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { DocumentType } from "@repo/api/src/types/document";
import type { AdditionalRepoRef, LoopCommand } from "@repo/api/src/types/loop";
import type {
  LoopBody,
  LoopBranchMaterializationEnvelope,
} from "@repo/api/src/types/loop-body";
import { log } from "@repo/observability/log";
import { toRelayOperation } from "@/app/compute-targets/relay-command-helpers";
import { computeTargetsService } from "@/app/compute-targets/service";
import { hasDesktopCommandSigningEnforcement } from "@/lib/command-signing-enforcement";
import {
  COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_ERROR,
  CommandSigningEligibilityStatus,
  type CommandSigningRequirementResult,
  CommandSigningRequirementStatus,
  isComputeTargetSigningEligible,
} from "@/lib/compute-target-signing-eligibility";
import { shortContentHash } from "@/lib/content-hash";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  toEnvelope,
  toWireCommandFromRelayOperation,
} from "@/lib/desktop-gateway-wire";
import { relayEventBus } from "@/lib/relay-event-bus";
import type { DesktopUserIntentSignature } from "./compute-provider";
import type { ContextPack } from "./loop-state";

type RelayOperation = ReturnType<typeof toRelayOperation>;
type RelayDispatchContext = {
  label: string;
  loopId: string;
  commandId: string;
};
type RelayApiDispatchConfig = {
  relayApiUrl: string;
  internalSecret: string;
};

/**
 * Throws if the relay reported delivered: false (target offline/disconnected).
 * Only called when throwOnFailure is true and the HTTP response was 2xx.
 */
async function assertDelivered(
  response: Response,
  context: {
    label: string;
    loopId: string;
    commandId: string;
    computeTargetId: string;
  }
): Promise<void> {
  const result = (await response.json().catch(() => null)) as {
    delivered?: boolean;
    reason?: string;
  } | null;
  if (result && result.delivered === false) {
    log.error(`[loop-desktop] ${context.label} relay dispatch not delivered`, {
      loopId: context.loopId,
      commandId: context.commandId,
      computeTargetId: context.computeTargetId,
      reason: result.reason,
    });
    throw new RelayDispatchNotDeliveredError(result.reason);
  }
}

function getImplementationPlanPayloadDiagnostics(contextPack: ContextPack): {
  artifactCount: number;
  implementationPlanArtifactPresent: boolean;
  implementationPlanRawRecordPresent: boolean;
  implementationPlanRawContentPresent: boolean;
  implementationPlanRawContentMatchesArtifact: boolean | null;
  implementationPlanRawReusableByDesktop: boolean | null;
  implementationPlanContentLength: number | null;
  implementationPlanRawContentLength: number | null;
  implementationPlanContentHash: string | null;
  implementationPlanRawContentHash: string | null;
} {
  const planArtifact = contextPack.artifacts.find(
    (artifact) => artifact.type === DocumentType.ImplementationPlan
  );
  const rawPlanContent =
    typeof planArtifact?.raw?.content === "string"
      ? planArtifact.raw.content
      : undefined;
  let implementationPlanRawReusableByDesktop: boolean | null = null;
  if (planArtifact && rawPlanContent !== undefined) {
    implementationPlanRawReusableByDesktop =
      rawPlanContent === planArtifact.content;
  } else if (planArtifact) {
    implementationPlanRawReusableByDesktop = false;
  }

  return {
    artifactCount: contextPack.artifacts.length,
    implementationPlanArtifactPresent: planArtifact !== undefined,
    implementationPlanRawRecordPresent: planArtifact?.raw !== undefined,
    implementationPlanRawContentPresent: rawPlanContent !== undefined,
    implementationPlanRawContentMatchesArtifact:
      planArtifact && rawPlanContent !== undefined
        ? rawPlanContent === planArtifact.content
        : null,
    implementationPlanRawReusableByDesktop,
    implementationPlanContentLength: planArtifact?.content.length ?? null,
    implementationPlanRawContentLength: rawPlanContent?.length ?? null,
    implementationPlanContentHash: shortContentHash(planArtifact?.content),
    implementationPlanRawContentHash: shortContentHash(rawPlanContent),
  };
}

/**
 * Dispatch a relay operation to a desktop compute target.
 * Shared by launch and kill paths.
 */
function getRelayApiDispatchConfig(): RelayApiDispatchConfig | null {
  const relayApiUrl = process.env.RELAY_API_URL;
  const internalSecret = process.env.INTERNAL_API_SECRET;
  return relayApiUrl && internalSecret ? { relayApiUrl, internalSecret } : null;
}

function buildRelayApiEnvelope(
  computeTargetId: string,
  relayOperation: RelayOperation,
  context: RelayDispatchContext,
  throwOnFailure: boolean
): ReturnType<typeof toEnvelope> | null {
  const wireCommand = toWireCommandFromRelayOperation(relayOperation);
  if (wireCommand) {
    return toEnvelope(wireCommand);
  }
  const err = new Error("Failed to convert relay operation to wire command");
  log.error(`[loop-desktop] ${context.label} wire conversion failed`, {
    loopId: context.loopId,
    commandId: context.commandId,
    computeTargetId,
  });
  if (throwOnFailure) {
    throw err;
  }
  return null;
}

async function handleRelayApiResponse(
  response: Response,
  computeTargetId: string,
  context: RelayDispatchContext,
  throwOnFailure: boolean
): Promise<void> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    log.error(`[loop-desktop] ${context.label} relay dispatch failed`, {
      loopId: context.loopId,
      commandId: context.commandId,
      computeTargetId,
      status: response.status,
      body,
    });
    if (throwOnFailure) {
      throw new Error(`Relay dispatch failed with status ${response.status}`);
    }
    return;
  }
  if (throwOnFailure) {
    // Check the delivered flag -- a 200 with delivered: false means the target
    // was offline or disconnected. Fail loudly so the caller does not report
    // success for a loop that never reached the desktop.
    await assertDelivered(response, { ...context, computeTargetId });
  }
}

async function dispatchRelayApiOperation(input: {
  computeTargetId: string;
  relayOperation: RelayOperation;
  context: RelayDispatchContext;
  throwOnFailure: boolean;
  config: RelayApiDispatchConfig;
}): Promise<void> {
  try {
    const operation = buildRelayApiEnvelope(
      input.computeTargetId,
      input.relayOperation,
      input.context,
      input.throwOnFailure
    );
    if (!operation) {
      return;
    }
    const response = await fetch(`${input.config.relayApiUrl}/dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": input.config.internalSecret,
      },
      body: JSON.stringify({
        targetId: input.computeTargetId,
        operation,
      }),
      signal: AbortSignal.timeout(5000),
    });
    await handleRelayApiResponse(
      response,
      input.computeTargetId,
      input.context,
      input.throwOnFailure
    );
  } catch (dispatchError) {
    log.error(
      `[loop-desktop] ${input.context.label} failed to dispatch to relay`,
      {
        loopId: input.context.loopId,
        commandId: input.context.commandId,
        computeTargetId: input.computeTargetId,
        error: dispatchError,
      }
    );
    if (input.throwOnFailure) {
      throw dispatchError;
    }
  }
}

function dispatchLocalRelayOperation(
  computeTargetId: string,
  relayOperation: RelayOperation,
  context: RelayDispatchContext,
  throwOnFailure: boolean
): void {
  const result = relayEventBus.publishOperation(
    computeTargetId,
    relayOperation
  );
  if (!throwOnFailure || result.deliveredToSubscriber) {
    return;
  }
  log.error(`[loop-desktop] ${context.label} relay dispatch not delivered`, {
    loopId: context.loopId,
    commandId: context.commandId,
    computeTargetId,
    reason: "target_offline",
  });
  throw new RelayDispatchNotDeliveredError("target_offline");
}

async function dispatchRelayOperation(
  computeTargetId: string,
  relayOperation: RelayOperation,
  context: RelayDispatchContext,
  throwOnFailure = false
): Promise<void> {
  const config = getRelayApiDispatchConfig();
  if (config) {
    await dispatchRelayApiOperation({
      computeTargetId,
      relayOperation,
      context,
      throwOnFailure,
      config,
    });
    return;
  }
  dispatchLocalRelayOperation(
    computeTargetId,
    relayOperation,
    context,
    throwOnFailure
  );
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

export type LaunchDesktopOpts = {
  loopId: string;
  organizationId: string;
  userId?: string;
  command: LoopCommand;
  computeTargetId: string;
  closedLoopAuthToken: string;
  apiBaseUrl: string;
  s3StateKey?: string;
  contextPack: ContextPack;
  documentSlug?: string;
  parentLoopId?: string;
  parentBranchName?: string;
  parentSessionId?: string;
  localRepoPath?: string;
  additionalRepos?: AdditionalRepoRef[];
  branchMaterialization?: LoopBranchMaterializationEnvelope;
  documentId?: string;
  desktopUserIntentSignature?: DesktopUserIntentSignature;
  harness?: HarnessType;
};

async function resolveLaunchCommandSigningRequirement(
  computeTargetId: string
): Promise<CommandSigningRequirementResult> {
  const target = await computeTargetsService.findById(computeTargetId);
  const capabilities = target?.capabilities as Record<string, unknown> | null;
  if (!hasDesktopCommandSigningEnforcement(capabilities)) {
    return { status: CommandSigningRequirementStatus.NotRequired };
  }
  if (!target?.userId) {
    return { status: CommandSigningRequirementStatus.NotRequired };
  }
  const eligibility = await isComputeTargetSigningEligible({
    organizationId: target.organizationId,
    userId: target.userId,
    clerkUserId: target.user?.clerkId,
    gatewayId: target.gatewayId,
  });
  if (eligibility.status === CommandSigningEligibilityStatus.Unknown) {
    return { status: CommandSigningRequirementStatus.Unknown };
  }
  return eligibility.status === CommandSigningEligibilityStatus.Eligible
    ? { status: CommandSigningRequirementStatus.Required }
    : { status: CommandSigningRequirementStatus.NotRequired };
}

export function buildDesktopLoopExecutionBody(
  opts: Omit<LaunchDesktopOpts, "desktopUserIntentSignature">
): JsonValue {
  return {
    loopId: opts.loopId,
    command: opts.command,
    closedLoopAuthToken: opts.closedLoopAuthToken,
    apiBaseUrl: opts.apiBaseUrl,
    ...(opts.s3StateKey ? { s3StateKey: opts.s3StateKey } : {}),
    artifacts: opts.contextPack.artifacts,
    prompt: opts.contextPack.prompt ?? null,
    repo: opts.contextPack.repoInfo ?? null,
    committer: opts.contextPack.committer ?? null,
    artifactSlug: opts.documentSlug ?? null,
    parentLoopId: opts.parentLoopId ?? null,
    parentBranchName: opts.parentBranchName ?? null,
    parentSessionId: opts.parentSessionId ?? null,
    localRepoPath: opts.localRepoPath ?? null,
    ...(opts.contextPack.userContext === undefined
      ? {}
      : { userContext: opts.contextPack.userContext }),
    ...(opts.contextPack.attachments === undefined
      ? {}
      : { attachments: opts.contextPack.attachments }),
    ...(opts.contextPack.supportingArtifacts === undefined
      ? {}
      : { supportingArtifacts: opts.contextPack.supportingArtifacts }),
    ...(opts.contextPack.codeEvaluationContext === undefined
      ? {}
      : { codeEvaluationContext: opts.contextPack.codeEvaluationContext }),
    ...(opts.additionalRepos === undefined
      ? {}
      : {
          additionalRepos: opts.additionalRepos.map((repo) => ({
            fullName: repo.fullName,
            branch: repo.branch,
          })),
        }),
    ...(opts.branchMaterialization === undefined
      ? {}
      : { branchMaterialization: opts.branchMaterialization }),
    ...(opts.documentId ? { primaryArtifactId: opts.documentId } : {}),
    ...(opts.contextPack.agents === undefined
      ? {}
      : { agents: opts.contextPack.agents }),
    ...(opts.contextPack.repoConfigs === undefined
      ? {}
      : { repoConfigs: opts.contextPack.repoConfigs }),
    ...(opts.harness === undefined ? {} : { harness: opts.harness }),
  } satisfies LoopBody as JsonValue;
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
    contextPack,
    desktopUserIntentSignature,
  } = opts;
  const namespace = CURRENT_DESKTOP_API_NAMESPACE;

  const signingRequirement =
    await resolveLaunchCommandSigningRequirement(computeTargetId);
  if (signingRequirement.status === CommandSigningRequirementStatus.Unknown) {
    throw new Error(COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_ERROR);
  }
  const signingRequired =
    signingRequirement.status === CommandSigningRequirementStatus.Required;
  if (signingRequired && !desktopUserIntentSignature) {
    throw new Error("Command signing is required for this compute target");
  }
  const signatureForDispatch = signingRequired
    ? desktopUserIntentSignature
    : undefined;

  const input = signatureForDispatch
    ? {
        commandId: signatureForDispatch.commandId as BrowserSignedCommandId,
        operationId: "symphony_loop",
        method: "POST" as const,
        path: rewriteDesktopApiPath("/api/gateway/symphony/loop", namespace),
        body: {
          loopId,
          userIntent: signatureForDispatch.body,
        } satisfies JsonValue,
        signature: signatureForDispatch.signature,
        signaturePayload: signatureForDispatch.signaturePayload,
        publicKeyFingerprint: signatureForDispatch.publicKeyFingerprint,
      }
    : {
        operationId: "symphony_loop",
        method: "POST" as const,
        path: rewriteDesktopApiPath("/api/gateway/symphony/loop", namespace),
        body: buildDesktopLoopExecutionBody(opts),
      };

  const createResult = await desktopCommandStore.createCommand(
    computeTargetId,
    input
  );
  const commandId = createResult.command.commandId;

  const relayOperation = toRelayOperation(
    commandId,
    input,
    signatureForDispatch
      ? {
          signature: signatureForDispatch.signature,
          signaturePayload: signatureForDispatch.signaturePayload,
          publicKeyFingerprint: signatureForDispatch.publicKeyFingerprint,
        }
      : undefined
  );

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
    if (signatureForDispatch) {
      await desktopCommandStore.markCommandExpired(
        commandId,
        `signed_command_delivery_failed:${dispatchReason ?? "unknown"}`,
        {
          commandId,
          operationId: input.operationId,
          computeTargetId,
        }
      );
    }
    throw new DispatchError(
      err instanceof Error ? err.message : String(err),
      commandId,
      dispatchReason
    );
  }

  log.info("[loop-desktop] Desktop loop command dispatched", {
    loopId,
    commandId,
    command,
    computeTargetId,
    desktopApiNamespace: namespace,
    ...getImplementationPlanPayloadDiagnostics(contextPack),
  });

  return commandId;
}

/**
 * Dispatch a kill command to a desktop compute target.
 * Extracted from the DELETE route to keep routes thin.
 */
export async function stopDesktopLoop(
  loopId: string,
  computeTargetId: string,
  desktopUserIntentSignature?: DesktopUserIntentSignature
): Promise<void> {
  const namespace = CURRENT_DESKTOP_API_NAMESPACE;

  const killInput: CreateDesktopCommandInput = desktopUserIntentSignature
    ? {
        commandId:
          desktopUserIntentSignature.commandId as BrowserSignedCommandId,
        operationId: "symphony_loop_kill",
        method: "POST" as const,
        path: rewriteDesktopApiPath(
          "/api/gateway/symphony/loop/kill",
          namespace
        ),
        body: {
          loopId,
          userIntent: desktopUserIntentSignature.body,
        } satisfies JsonValue,
        signature: desktopUserIntentSignature.signature,
        signaturePayload: desktopUserIntentSignature.signaturePayload,
        publicKeyFingerprint: desktopUserIntentSignature.publicKeyFingerprint,
      }
    : {
        operationId: "symphony_loop_kill",
        method: "POST" as const,
        path: rewriteDesktopApiPath(
          "/api/gateway/symphony/loop/kill",
          namespace
        ),
        body: { loopId },
      };
  const createResult = await desktopCommandStore.createCommand(
    computeTargetId,
    killInput
  );
  const commandId = createResult.command.commandId;
  const relayOp = toRelayOperation(
    commandId,
    killInput,
    desktopUserIntentSignature
      ? {
          signature: desktopUserIntentSignature.signature,
          signaturePayload: desktopUserIntentSignature.signaturePayload,
          publicKeyFingerprint: desktopUserIntentSignature.publicKeyFingerprint,
        }
      : undefined
  );

  try {
    await dispatchRelayOperation(
      computeTargetId,
      relayOp,
      {
        label: "Kill",
        loopId,
        commandId,
      },
      Boolean(desktopUserIntentSignature)
    );
  } catch (err) {
    const dispatchReason =
      err instanceof RelayDispatchNotDeliveredError ? err.reason : undefined;
    if (desktopUserIntentSignature) {
      await desktopCommandStore.markCommandExpired(
        commandId,
        `signed_command_delivery_failed:${dispatchReason ?? "unknown"}`,
        {
          commandId,
          operationId: killInput.operationId,
          computeTargetId,
        }
      );
    }
    throw new DispatchError(
      err instanceof Error ? err.message : String(err),
      commandId,
      dispatchReason
    );
  }

  log.info("[loop-desktop] Desktop kill command dispatched", {
    loopId,
    commandId,
    computeTargetId,
  });
}
