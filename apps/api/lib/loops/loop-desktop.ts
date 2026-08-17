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
import type { AdditionalRepoRef, LoopCommand } from "@repo/api/src/types/loop";
import type { LoopBody } from "@repo/api/src/types/loop-body";
import type { LoopBranchMaterializationEnvelope } from "@closedloop-ai/loops-api/desktop-request";
import { log } from "@repo/observability/log";
import { z } from "zod";
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
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  toEnvelope,
  toWireCommandFromRelayOperation,
} from "@/lib/desktop-gateway-wire";
import { relayEventBus } from "@/lib/relay-event-bus";
import type { DesktopUserIntentSignature } from "./compute-provider";
import { getImplementationPlanPayloadDiagnostics } from "./loop-desktop-diagnostics";
import type { ContextPack } from "./loop-state";

type RelayOperation = ReturnType<typeof toRelayOperation>;
type RelayDispatchContext = {
  label: string;
  loopId: string;
  commandId: string;
  /**
   * Whether `dispatchOperationWithReplay` still has a replay left after this
   * attempt.
   *
   * A not-delivered answer that will be replayed is an expected transient
   * (ISS-5811), not a failure. Error-level logs here are wired to Datadog
   * monitors, so a dispatch that recovers on its second attempt must not leave
   * an error behind -- an alert that fires on every recovered launch is an
   * alert people learn to ignore. Absent (the final attempt) means the failure
   * is terminal and logs at error.
   */
  willReplay?: boolean;
};
type RelayApiDispatchConfig = {
  relayApiUrl: string;
  internalSecret: string;
};

/**
 * Attempts a relay dispatch gets before the operation is declared failed.
 *
 * A single not-delivered answer from the relay is a transient, not a verdict
 * (ISS-5811). When the API's `POST /dispatch` lands on a relay instance that
 * does not own the target's socket, the relay proxies to the owning peer with a
 * 4s budget (`PEER_DISPATCH_TIMEOUT_MS`); when that hop does not answer in time
 * the relay reports not-delivered and the whole launch dies. Every such launch
 * fails at 4.16-4.40s -- the peer timeout plus overhead -- while a dispatch that
 * reaches the owning instance delivers in ~370ms.
 *
 * WHY THREE. 23 dispatches issued against a target reporting online and
 * socket-connected throughout (2026-08-10, direct API calls, so no client-side
 * gate in the path) delivered 10 times. Compounding a ~43% per-attempt rate,
 * 2 attempts reach ~68% and 3 reach ~82%, for a worst case of ~13s of peer
 * timeouts -- trivial against commands that then run ten to twenty minutes.
 *
 * TREAT THAT RATE AS A FLOOR, NOT A BASELINE. The whole measurement window sat
 * inside escalating desktop memory pressure: the machine was allocating 1-2.5GB
 * per `loadSyncedSessions` op and OOM-killed its Electron main process (rss
 * 4.6GB) 22 minutes after the last sample (ISS-5808). A desktop in that state
 * can stall or drop its relay socket, which produces this same not-delivered
 * answer, so an unknown share of those failures may be desktop-side rather than
 * relay-side. The failure MODE is well attested independently -- never-started
 * loops at 4.16-4.40s against the relay's 4s `PEER_DISPATCH_TIMEOUT_MS`, on
 * separate days and machines -- but the RATE wants re-measuring on a healthy
 * desktop before anyone plans against it. Three attempts is defensible under
 * any of these rates; the exact number is not load-bearing.
 *
 * Replay is safe because the commandId is minted ONCE by `createCommand` before
 * the first attempt and reused: the desktop executor dedupes on it
 * (`trackedByCommandId` in `cloud-command-executor.ts` re-acks and replays
 * buffered output instead of executing twice), so a retry cannot double-spawn a
 * loop even when an attempt did reach the desktop and only its response was
 * lost.
 *
 * THAT MAP IS PER-PROCESS, so it alone does not carry the guarantee across a
 * desktop restart -- and the runner child is detached, so it outlives the
 * Electron process that spawned it. A replay (or a relay reconnect replay) that
 * lands on a FRESH executor finds both that map and the launch handler's
 * `runningLoops` guard empty while the original runner is still alive. What
 * closes that is desktop-side and persisted: `seedRunningLoopsFromJobStore`
 * (`apps/desktop/src/main/jobs/boot-loop-registry-seed.ts`) repopulates
 * `runningLoops` from the job store synchronously at boot, before the cloud
 * socket can accept a command, so the duplicate launch answers 409 instead of
 * spawning. Do not weaken either side without the other.
 *
 * This mirrors `PRE_LOOP_RELAY_HEALTH_CHECK_MAX_ATTEMPTS`, which made the same
 * call for the relay-targeted health check in ISS-5169.
 *
 * THE KILL SHARES THIS BUDGET (ISS-6046). Both operations ride the same relay
 * hop and so miss for the same reason at the same rate; the kill only carried a
 * single unchecked attempt because its unsigned path never read the `delivered`
 * flag at all. An undelivered kill is the worse of the two to get wrong: the
 * runner child is spawned detached and outlives the Electron process, so it
 * keeps executing on the user's machine while the cloud records the loop
 * cancelled or launch-failed. Replay is safe on the kill for the same reason as
 * the launch -- one commandId, minted once, deduped desktop-side -- and the kill
 * handler is idempotent besides. Retrying does cost the user-facing cancel
 * request up to ~15s of relay timeouts in the failure case, which is the case
 * that previously returned a lie.
 *
 * THIS IS TRIAGE, NOT A CURE. It re-rolls a load-balancer draw to work around a
 * relay that cannot reliably reach its own peer; at a 43% per-attempt rate the
 * transport is badly broken and the real fix is relay-side. Do not let a green
 * dispatch rate here retire that work.
 */
const DISPATCH_MAX_ATTEMPTS = 3;

/**
 * Pause between relay dispatch attempts.
 *
 * Deliberately modest, and NOT presented as a tuned value: closely-spaced
 * attempts measured worse than widely-spaced ones (1/5 at ~3s apart against 6/8
 * at ~15s apart), but those samples are small and confounded, and a retry at 3s
 * did still succeed. So the evidence supports RETRYING MORE, not any particular
 * gap. A second is enough to let a pooled connection turn over without adding
 * meaningfully to a launch that already costs seconds.
 */
const DISPATCH_RETRY_DELAY_MS = 1000;

/**
 * The relay's `/dispatch` 2xx envelope. `delivered` is always present and
 * always a boolean on every relay answer -- the relay applies this same
 * `typeof … !== "boolean"` check to its own peer hop before answering.
 *
 * `delivered` is the only field that decides anything, so it is the only one
 * allowed to fail the envelope. `reason` is diagnostic, and rejecting a
 * `delivered: true` answer over it would report a command that DID reach the
 * desktop as failed -- an off-contract one degrades to absent instead.
 */
const relayDispatchEnvelopeSchema = z.object({
  delivered: z.boolean(),
  reason: z.string().optional().catch(undefined),
});

/**
 * Reason recorded when a relay 2xx carried no readable envelope. Unrecognized
 * by `classifyLaunchFailure`, so it degrades to generic `launch_failed`.
 */
export const MALFORMED_RELAY_ENVELOPE_REASON = "malformed_relay_envelope";

/**
 * Throws unless the relay reported an explicit `delivered: true`. Only called
 * once the HTTP response was 2xx.
 *
 * Requiring the positive answer rather than rejecting only `delivered: false`
 * is what keeps the check from failing open: an empty object, a `null`, a body
 * that is not JSON, and a `delivered` that is not a boolean all describe a
 * dispatch whose outcome the cloud cannot vouch for. Returning success on one
 * is the same unearned claim ISS-5708 and ISS-6046 exist to stop, and on the
 * kill path it is what turns an undelivered kill into an info line reading
 * exactly like a delivered one.
 *
 * A malformed envelope is replayed like any other not-delivered answer. That is
 * safe for the same reason the rest of the replay is (one commandId, minted
 * once, deduped desktop-side) and correct because the body carries no evidence
 * either way.
 */
async function assertDelivered(
  response: Response,
  context: RelayDispatchContext & { computeTargetId: string }
): Promise<void> {
  const parsed = relayDispatchEnvelopeSchema.safeParse(
    await response.json().catch(() => null)
  );
  if (parsed.success && parsed.data.delivered) {
    return;
  }
  const reason = parsed.success
    ? parsed.data.reason
    : MALFORMED_RELAY_ENVELOPE_REASON;
  logDispatchDeliveryFailure(context, {
    loopId: context.loopId,
    commandId: context.commandId,
    computeTargetId: context.computeTargetId,
    reason,
  });
  throw new RelayDispatchNotDeliveredError(reason);
}

/**
 * Log a not-delivered dispatch at the level its retry budget warrants.
 *
 * Warn while a replay remains, error once the attempt is terminal. Only
 * delivery failures get this treatment: a relay 4xx/5xx and a wire-conversion
 * failure are never replayed (`isRetriableDispatchFailure`), so they stay at
 * error on every attempt.
 */
function logDispatchDeliveryFailure(
  context: Pick<RelayDispatchContext, "label" | "willReplay">,
  fields: Record<string, unknown>
): void {
  const message = `[loop-desktop] ${context.label} relay dispatch not delivered`;
  if (context.willReplay) {
    log.warn(message, fields);
    return;
  }
  log.error(message, fields);
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
  context: RelayDispatchContext
): ReturnType<typeof toEnvelope> {
  const wireCommand = toWireCommandFromRelayOperation(relayOperation);
  if (wireCommand) {
    return toEnvelope(wireCommand);
  }
  log.error(`[loop-desktop] ${context.label} wire conversion failed`, {
    loopId: context.loopId,
    commandId: context.commandId,
    computeTargetId,
  });
  throw new Error("Failed to convert relay operation to wire command");
}

async function handleRelayApiResponse(
  response: Response,
  computeTargetId: string,
  context: RelayDispatchContext
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
    throw new Error(`Relay dispatch failed with status ${response.status}`);
  }
  // A 2xx only proves the relay answered. Require the delivered flag so the
  // caller does not report success for a command that never reached the
  // desktop.
  await assertDelivered(response, { ...context, computeTargetId });
}

async function dispatchRelayApiOperation(input: {
  computeTargetId: string;
  relayOperation: RelayOperation;
  context: RelayDispatchContext;
  config: RelayApiDispatchConfig;
}): Promise<void> {
  try {
    const operation = buildRelayApiEnvelope(
      input.computeTargetId,
      input.relayOperation,
      input.context
    );
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
      input.context
    );
  } catch (dispatchError) {
    // A not-delivered answer has already been logged by `assertDelivered`, at
    // the level its retry budget warrants and with the relay's reason attached.
    // Re-logging it here would emit a second, always-error line for one
    // transient miss -- so a launch that recovers on replay would still leave
    // an error in Datadog. Everything else reaching this catch (a fetch throw,
    // the 5s abort, a wire-conversion failure) is unexpected and terminal.
    if (!(dispatchError instanceof RelayDispatchNotDeliveredError)) {
      log.error(
        `[loop-desktop] ${input.context.label} failed to dispatch to relay`,
        {
          loopId: input.context.loopId,
          commandId: input.context.commandId,
          computeTargetId: input.computeTargetId,
          error: dispatchError,
        }
      );
    }
    throw dispatchError;
  }
}

function dispatchLocalRelayOperation(
  computeTargetId: string,
  relayOperation: RelayOperation,
  context: RelayDispatchContext
): void {
  const result = relayEventBus.publishOperation(
    computeTargetId,
    relayOperation
  );
  if (result.deliveredToSubscriber) {
    return;
  }
  logDispatchDeliveryFailure(context, {
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
  context: RelayDispatchContext
): Promise<void> {
  const config = getRelayApiDispatchConfig();
  if (config) {
    await dispatchRelayApiOperation({
      computeTargetId,
      relayOperation,
      context,
      config,
    });
    return;
  }
  dispatchLocalRelayOperation(computeTargetId, relayOperation, context);
}

/**
 * Whether a failed dispatch attempt is worth replaying.
 *
 * Only a delivery failure is transient. A wire-conversion failure is
 * deterministic -- the same operation converts to the same `null` every time --
 * so replaying it just doubles the latency before the same error, and a relay
 * 4xx is a rejection the relay will repeat. Both fall through to the caller
 * unretried.
 */
function isRetriableDispatchFailure(error: unknown): boolean {
  return error instanceof RelayDispatchNotDeliveredError;
}

/**
 * Dispatch a relay operation, replaying a not-delivered answer up to
 * `DISPATCH_MAX_ATTEMPTS` times.
 *
 * Always throws on failure: a launch that cannot be delivered must fail loudly
 * rather than report a success it has not earned (ISS-5708), and so must a kill
 * -- a caller told the runner was stopped when it is still running is the same
 * lie pointed the other way (ISS-6046).
 */
async function dispatchOperationWithReplay(
  computeTargetId: string,
  relayOperation: RelayOperation,
  context: RelayDispatchContext
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DISPATCH_MAX_ATTEMPTS; attempt++) {
    try {
      await dispatchRelayOperation(computeTargetId, relayOperation, {
        ...context,
        willReplay: attempt < DISPATCH_MAX_ATTEMPTS,
      });
      if (attempt > 1) {
        log.info(
          `[loop-desktop] ${context.label} dispatch delivered on replay`,
          {
            loopId: context.loopId,
            commandId: context.commandId,
            computeTargetId,
            attempt,
          }
        );
      }
      return;
    } catch (error) {
      lastError = error;
      if (
        !isRetriableDispatchFailure(error) ||
        attempt === DISPATCH_MAX_ATTEMPTS
      ) {
        throw error;
      }
      log.warn(
        `[loop-desktop] ${context.label} dispatch not delivered, replaying`,
        {
          loopId: context.loopId,
          commandId: context.commandId,
          computeTargetId,
          attempt,
          reason:
            error instanceof RelayDispatchNotDeliveredError
              ? error.reason
              : undefined,
        }
      );
      await delay(DISPATCH_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
    await dispatchOperationWithReplay(computeTargetId, relayOperation, {
      label: "Launch",
      loopId,
      commandId,
    });
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
 *
 * Throws when the kill could not be delivered, signed or not (ISS-6046). Every
 * caller treats the kill as best-effort and proceeds with its own bookkeeping,
 * but it must do so knowing the runner may still be alive rather than off a log
 * line that said the command was dispatched when it never left the cloud.
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
    await dispatchOperationWithReplay(computeTargetId, relayOp, {
      label: "Kill",
      loopId,
      commandId,
    });
  } catch (err) {
    const dispatchReason =
      err instanceof RelayDispatchNotDeliveredError ? err.reason : undefined;
    // Only a SIGNED kill is terminalized here. An unsigned one deliberately
    // leaves its row non-terminal so the desktop's hello-ack replay
    // (`listNonTerminalDispatchCommands`) still delivers the kill on reconnect
    // -- the durable backstop for the orphaned runner the replay above could
    // not reach. A signed command cannot use that path: the desktop verifier
    // rejects a signature past `MAX_SIGNATURE_AGE_SECONDS` and burns its nonce,
    // so a later replay is refused as stale. It is expired instead.
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
