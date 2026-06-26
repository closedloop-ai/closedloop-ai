import { analytics } from "@repo/analytics/server";
import {
  CURRENT_DESKTOP_API_NAMESPACE,
  DESKTOP_API_PREFIX,
  rewriteDesktopApiPath,
} from "@repo/api/src/desktop-api-namespace";
import { BranchViewLocalHeader } from "@repo/api/src/types/branch-view-local";
import type { ApiResult } from "@repo/api/src/types/common";
import type {
  CommandSignatureFields,
  CreateDesktopCommandInput,
  CreateDesktopCommandResponse,
} from "@repo/api/src/types/compute-target";
import {
  DesktopCommandStatus,
  UPDATE_AND_RESTART_OPERATION_ID,
} from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { buildTelemetryTraceContext } from "@repo/observability/telemetry/context";
import { emitCommandLifecycleEvent } from "@repo/observability/telemetry/emitter";
import { TelemetryCategory } from "@repo/observability/telemetry/schema";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  classifyBranchViewLocalCommand,
  stampBranchViewLocalCommandMetadata,
  validateBranchViewLocalAccess,
} from "@/lib/branch-view-local-authorization";
import { enforceRegisteredBrowserPublicKey } from "@/lib/browser-command-public-key-enforcement";
import {
  browserKeyRevocationReservedResponse,
  isReservedBrowserKeyRevocationCommand,
} from "@/lib/browser-key-revocation-command";
import { hasDesktopCommandSigningEnforcement } from "@/lib/command-signing-enforcement";
import {
  COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_ERROR,
  CommandSigningEligibilityStatus,
  isComputeTargetSigningEligible,
} from "@/lib/compute-target-signing-eligibility";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import {
  dispatchRelayCommandToRelay,
  toRelayOperation,
} from "../../relay-command-helpers";
import { computeTargetsService } from "../../service";
import { createDesktopCommandValidator } from "../../validators";

type DispatchContext = {
  traceContext: ReturnType<typeof buildTelemetryTraceContext>;
  pluginVersion: string | undefined;
  isUpdateAndRestart: boolean;
};

type CommandSigningContext = {
  effectiveCommandSigning: boolean;
  eligibilityUnknown: boolean;
};

type AccessibleCommandTarget = NonNullable<
  Awaited<ReturnType<typeof computeTargetsService.findAccessibleById>>
>;

type PrepareCommandDispatchResult =
  | {
      ok: true;
      input: CreateDesktopCommandInput;
      rewrittenInput: CreateDesktopCommandInput;
      requestId: string;
      signatureFields: CommandSignatureFields | undefined;
      signingContext: CommandSigningContext;
      target: AccessibleCommandTarget;
    }
  | {
      ok: false;
      response: NextResponse<ApiResult<never>>;
    };

function extractSignatureFields(
  input: CreateDesktopCommandInput
): CommandSignatureFields | undefined {
  if (
    !(input.signature && input.signaturePayload && input.publicKeyFingerprint)
  ) {
    return undefined;
  }
  return {
    signature: input.signature,
    signaturePayload: input.signaturePayload,
    publicKeyFingerprint: input.publicKeyFingerprint,
  };
}

function stripSignatureFields(
  input: CreateDesktopCommandInput
): CreateDesktopCommandInput {
  const {
    signature: _signature,
    signaturePayload: _signaturePayload,
    publicKeyFingerprint: _publicKeyFingerprint,
    ...rest
  } = input;
  return rest;
}

function isPathInCurrentNamespace(path: string): boolean {
  return path.startsWith(DESKTOP_API_PREFIX);
}

function emitDispatchedTelemetry(ctx: DispatchContext): void {
  emitCommandLifecycleEvent(
    TelemetryCategory.CommandDispatched,
    ctx.traceContext
  );
  if (ctx.isUpdateAndRestart) {
    emitCommandLifecycleEvent(
      TelemetryCategory.ElectronUpdateInitiated,
      ctx.traceContext,
      {
        message: `update-and-restart dispatched; fromVersion=${ctx.pluginVersion ?? "unknown"}`,
      }
    );
  }
}

function validateSignatureConsistency(
  input: CreateDesktopCommandInput,
  signatureFields: CommandSignatureFields | undefined
): NextResponse<ApiResult<never>> | null {
  if (input.commandId && !signatureFields) {
    return NextResponse.json(
      {
        success: false,
        error: "Client command IDs require browser command signing fields",
      },
      { status: 400 }
    );
  }
  if (signatureFields && !input.commandId) {
    return NextResponse.json(
      {
        success: false,
        error: "Signed browser commands require a client command ID",
      },
      { status: 400 }
    );
  }
  return null;
}

async function resolveCommandSigningContext(input: {
  capabilities: Record<string, unknown>;
  organizationId: string;
  targetUserId: string;
  targetGatewayId?: string | null;
  requesterUserId: string;
  requesterClerkUserId?: string | null;
  targetOwnerClerkUserId?: string | null;
}): Promise<CommandSigningContext> {
  if (!hasDesktopCommandSigningEnforcement(input.capabilities)) {
    return {
      effectiveCommandSigning: false,
      eligibilityUnknown: false,
    };
  }
  const eligibility = await isComputeTargetSigningEligible({
    organizationId: input.organizationId,
    userId: input.targetUserId,
    clerkUserId:
      input.targetUserId === input.requesterUserId
        ? (input.requesterClerkUserId ?? undefined)
        : (input.targetOwnerClerkUserId ?? undefined),
    gatewayId: input.targetGatewayId,
  });
  if (eligibility.status === CommandSigningEligibilityStatus.Unknown) {
    return {
      effectiveCommandSigning: false,
      eligibilityUnknown: true,
    };
  }
  return {
    effectiveCommandSigning:
      eligibility.status === CommandSigningEligibilityStatus.Eligible,
    eligibilityUnknown: false,
  };
}

async function resolveTargetOwnerClerkUserId(input: {
  targetId: string;
  targetUserId: string;
  requesterUserId: string;
  requesterClerkUserId?: string | null;
}): Promise<string | null | undefined> {
  if (input.targetUserId === input.requesterUserId) {
    return input.requesterClerkUserId;
  }
  return (await computeTargetsService.findById(input.targetId))?.user?.clerkId;
}

function validateSigningCompatibility(
  input: CreateDesktopCommandInput,
  signatureFields: CommandSignatureFields | undefined,
  signingContext: CommandSigningContext
): NextResponse<ApiResult<never>> | null {
  if (signingContext.eligibilityUnknown) {
    return NextResponse.json(
      {
        success: false,
        error: COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_ERROR,
      },
      { status: 400 }
    );
  }
  if (signingContext.effectiveCommandSigning && !signatureFields) {
    return NextResponse.json(
      {
        success: false,
        error: "Command signing is required for this compute target",
      },
      { status: 400 }
    );
  }
  if (signatureFields && !isPathInCurrentNamespace(input.path)) {
    return NextResponse.json(
      {
        success: false,
        error: "Signed command path does not match target namespace",
      },
      { status: 400 }
    );
  }
  return null;
}

function buildCommandInputForDispatch(
  input: CreateDesktopCommandInput,
  signatureFields: CommandSignatureFields | undefined
): CreateDesktopCommandInput {
  const unsignedInput = stripSignatureFields(input);
  return signatureFields
    ? unsignedInput
    : {
        ...unsignedInput,
        path: rewriteDesktopApiPath(
          unsignedInput.path,
          CURRENT_DESKTOP_API_NAMESPACE
        ),
      };
}

/**
 * Checks whether the electron-remote-update feature flag is enabled for the given user.
 * Returns true when enabled or when PostHog is not configured (fail-open).
 */
async function isElectronRemoteUpdateEnabled(userId: string): Promise<boolean> {
  if (typeof analytics.isFeatureEnabled !== "function") {
    return true;
  }
  try {
    const result = await analytics.isFeatureEnabled(
      "electron-remote-update",
      userId
    );
    return result !== false;
  } catch {
    return true;
  }
}

/**
 * Validates all update-and-restart–specific preconditions:
 * operation supported by target, feature flag enabled, and no extra payload.
 * Returns a response if validation fails, or null if everything passes.
 */
async function checkUpdateAndRestartPreconditions(
  input: CreateDesktopCommandInput,
  supportedOperations: string[],
  userId: string
): Promise<NextResponse<ApiResult<never>> | null> {
  if (!supportedOperations.includes(UPDATE_AND_RESTART_OPERATION_ID)) {
    return NextResponse.json(
      { success: false, error: "Operation not supported by target" },
      { status: 422 }
    );
  }

  const allowed = await isElectronRemoteUpdateEnabled(userId);
  if (!allowed) {
    return NextResponse.json(
      { success: false, error: "Feature not available" },
      { status: 403 }
    );
  }

  if (
    input.body !== undefined ||
    (input.headers && Object.keys(input.headers).length > 0)
  ) {
    return NextResponse.json(
      {
        success: false,
        error: "update-and-restart does not accept a body or custom headers",
      },
      { status: 422 }
    );
  }

  return null;
}

async function expireUndeliveredSignedCommand(input: {
  commandId: string;
  operationId: string;
  computeTargetId: string;
  requestId: string;
  reason: string | undefined;
  deduped: boolean;
}): Promise<NextResponse<ApiResult<CreateDesktopCommandResponse>>> {
  const reason = `signed_command_delivery_failed:${input.reason ?? "unknown"}`;
  await desktopCommandStore.markCommandExpired(input.commandId, reason, {
    commandId: input.commandId,
    operationId: input.operationId,
    computeTargetId: input.computeTargetId,
    requestId: input.requestId,
  });
  scheduleLogFlush();
  const response: CreateDesktopCommandResponse = {
    commandId: input.commandId,
    status: DesktopCommandStatus.Expired,
    ...(input.deduped ? { deduped: true } : {}),
  };
  return successResponse(response);
}

async function validateBrowserSignedCommand(input: {
  routeInput: CreateDesktopCommandInput;
  signatureFields: CommandSignatureFields | undefined;
  userId: string;
  organizationId: string;
}): Promise<NextResponse<ApiResult<never>> | null> {
  const signatureConsistencyError = validateSignatureConsistency(
    input.routeInput,
    input.signatureFields
  );
  if (signatureConsistencyError) {
    return signatureConsistencyError;
  }

  if (!input.signatureFields) {
    return null;
  }
  const registrationError = await enforceRegisteredBrowserPublicKey({
    userId: input.userId,
    organizationId: input.organizationId,
    publicKeyFingerprint: input.signatureFields.publicKeyFingerprint,
  });
  return registrationError;
}

async function prepareCommandDispatch(input: {
  targetId: string;
  user: { id: string; organizationId: string; clerkId?: string | null };
  request: Request;
}): Promise<PrepareCommandDispatchResult> {
  const { body, errorResponse: parseError } = await parseBody(
    input.request,
    createDesktopCommandValidator
  );
  if (parseError || !body) {
    return { ok: false, response: parseError };
  }

  const target = await computeTargetsService.findAccessibleById(
    input.targetId,
    input.user.organizationId,
    input.user.id
  );
  if (!target) {
    return { ok: false, response: notFoundResponse("Compute target") };
  }

  const routeInput = body as CreateDesktopCommandInput;
  if (isReservedBrowserKeyRevocationCommand(routeInput)) {
    return { ok: false, response: browserKeyRevocationReservedResponse() };
  }

  const signatureFields = extractSignatureFields(routeInput);
  const signedCommandError = await validateBrowserSignedCommand({
    routeInput,
    signatureFields,
    userId: input.user.id,
    organizationId: input.user.organizationId,
  });
  if (signedCommandError) {
    return { ok: false, response: signedCommandError };
  }

  if (routeInput.operationId === UPDATE_AND_RESTART_OPERATION_ID) {
    const guardError = await checkUpdateAndRestartPreconditions(
      routeInput,
      target.supportedOperations,
      input.user.id
    );
    if (guardError) {
      return { ok: false, response: guardError };
    }
  }

  const targetOwnerClerkUserId = await resolveTargetOwnerClerkUserId({
    targetId: target.id,
    targetUserId: target.userId,
    requesterUserId: input.user.id,
    requesterClerkUserId: input.user.clerkId,
  });
  const signingContext = await resolveCommandSigningContext({
    capabilities: target.capabilities,
    organizationId: target.organizationId,
    targetUserId: target.userId,
    targetGatewayId: target.gatewayId,
    requesterUserId: input.user.id,
    requesterClerkUserId: input.user.clerkId,
    targetOwnerClerkUserId,
  });
  const signingCompatibilityError = validateSigningCompatibility(
    routeInput,
    signatureFields,
    signingContext
  );
  if (signingCompatibilityError) {
    return { ok: false, response: signingCompatibilityError };
  }

  let branchViewLocalInput = routeInput;
  if (classifyBranchViewLocalCommand(routeInput)) {
    const headers = routeInput.headers ?? {};
    const proof = await validateBranchViewLocalAccess({
      userId: input.user.id,
      organizationId: input.user.organizationId,
      computeTargetId: target.id,
      externalLinkId: headers[BranchViewLocalHeader.ExternalLinkId] ?? "",
      repoFullName: headers[BranchViewLocalHeader.RepoFullName] ?? "",
      headBranch: headers[BranchViewLocalHeader.HeadBranch] ?? "",
      prNumber: Number(headers[BranchViewLocalHeader.PrNumber]),
      operationPath: routeInput.path,
    });
    if (!proof.ok) {
      return {
        ok: false,
        response: NextResponse.json(
          { success: false, error: proof.error, code: proof.code },
          { status: proof.status }
        ),
      };
    }
    branchViewLocalInput = stampBranchViewLocalCommandMetadata(
      routeInput,
      proof.metadataHeaders
    );
  }

  return {
    ok: true,
    input: branchViewLocalInput,
    rewrittenInput: buildCommandInputForDispatch(
      branchViewLocalInput,
      signatureFields
    ),
    requestId: crypto.randomUUID(),
    signatureFields,
    signingContext,
    target,
  };
}

async function handleDispatchResult(input: {
  commandId: string;
  createResult: Awaited<ReturnType<typeof desktopCommandStore.createCommand>>;
  dispatchCtx: DispatchContext;
  dispatchResult: Awaited<ReturnType<typeof dispatchRelayCommandToRelay>>;
  rewrittenInput: CreateDesktopCommandInput;
  requestId: string;
  signatureFields: CommandSignatureFields | undefined;
  signingContext: CommandSigningContext;
  target: AccessibleCommandTarget;
}): Promise<NextResponse<ApiResult<CreateDesktopCommandResponse>>> {
  if (input.dispatchResult.delivered) {
    log.info("Desktop command dispatched", {
      targetId: input.target.id,
      computeTargetId: input.target.id,
      commandId: input.commandId,
      deduped: input.createResult.deduped,
    });
    emitDispatchedTelemetry(input.dispatchCtx);
  } else if (
    input.signingContext.effectiveCommandSigning &&
    input.signatureFields
  ) {
    const expiredResponse = await expireUndeliveredSignedCommand({
      commandId: input.commandId,
      operationId: input.rewrittenInput.operationId,
      computeTargetId: input.target.id,
      requestId: input.requestId,
      reason: input.dispatchResult.reason,
      deduped: input.createResult.deduped,
    });
    return expiredResponse;
  }

  scheduleLogFlush();
  return successResponse({
    commandId: input.commandId,
    status: input.createResult.command.status,
    deduped: input.createResult.deduped ? true : undefined,
  });
}

function handleCreateCommandError(
  error: unknown
): NextResponse<ApiResult<never>> {
  if (
    error instanceof Error &&
    error.name === desktopCommandStore.IdempotencyConflictError.name
  ) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 409 }
    );
  }
  if (
    error instanceof Error &&
    error.name === desktopCommandStore.ClientCommandIdConflictError.name
  ) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 409 }
    );
  }
  return errorResponse("Failed to create desktop command", error);
}

/**
 * POST /compute-targets/:id/commands
 * Queues a desktop command and attempts immediate dispatch to active target transport.
 */
export const POST = withAnyAuth<
  CreateDesktopCommandResponse,
  "/compute-targets/[id]/commands"
>(async ({ user }, request, params) => {
  try {
    const { id: targetId } = await params;
    const prepared = await prepareCommandDispatch({
      targetId,
      user,
      request,
    });
    if (!prepared.ok) {
      return prepared.response;
    }
    const { target, input, rewrittenInput, requestId, signatureFields } =
      prepared;

    const createResult = await desktopCommandStore.createCommand(
      target.id,
      rewrittenInput,
      buildTelemetryTraceContext({
        computeTargetId: target.id,
        operationId: rewrittenInput.operationId,
        requestId,
      })
    );

    const { commandId } = createResult.command;

    const pluginVersionRaw = target.capabilities.pluginVersion;
    const pluginVersion =
      typeof pluginVersionRaw === "string" ? pluginVersionRaw : undefined;

    const traceContext = buildTelemetryTraceContext({
      commandId,
      operationId: rewrittenInput.operationId,
      computeTargetId: target.id,
      requestId,
      pluginVersion,
    });

    const relayOperation = toRelayOperation(
      commandId,
      rewrittenInput,
      signatureFields
    );

    const isUpdateAndRestart =
      input.operationId === UPDATE_AND_RESTART_OPERATION_ID;
    const dispatchCtx: DispatchContext = {
      traceContext,
      pluginVersion,
      isUpdateAndRestart,
    };

    const dispatchResult = await dispatchRelayCommandToRelay({
      targetId: target.id,
      commandId,
      relayOperation,
      requestId,
    });

    return handleDispatchResult({
      commandId,
      createResult,
      dispatchCtx,
      dispatchResult,
      rewrittenInput,
      requestId,
      signatureFields,
      signingContext: prepared.signingContext,
      target,
    });
  } catch (error) {
    return handleCreateCommandError(error);
  }
});
