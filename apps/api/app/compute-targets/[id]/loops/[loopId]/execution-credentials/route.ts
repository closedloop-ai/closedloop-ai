import { normalizeDesktopApiPath } from "@repo/api/src/desktop-api-namespace";
import type { JsonObject } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import { ApiKeySource, withDb } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiKeysService } from "@/app/api-keys/service";
import { uuidV7Validator } from "@/app/compute-targets/validators";
import { usersService } from "@/app/users/service";
import {
  getDesktopManagedPopFailure,
  verifyDesktopManagedPop,
} from "@/lib/auth/desktop-managed-pop";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { buildDesktopLoopExecutionCredentials } from "@/lib/loops/loop-orchestrator";
import {
  conflictResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

const executionCredentialsRequestValidator = z.object({
  commandId: uuidV7Validator,
});

const loopCredentialIntentBodyValidator = z
  .object({
    loopId: z.string().trim().min(1),
  })
  .passthrough()
  .refine((body) => Object.hasOwn(body, "userIntent"), {
    message: "userIntent is required",
    path: ["userIntent"],
  });

const loopCredentialRequestPayloadValidator = z
  .object({
    path: z.string().trim().min(1),
    body: loopCredentialIntentBodyValidator,
  })
  .passthrough();

type LoopCredentialAction = "loop.launch" | "loop.kill";

/**
 * Authenticates the credential fetch as the Desktop target owner. This route is
 * intentionally narrower than withAnyAuth: browser sessions, user-created API
 * keys, and Desktop-managed bearer-only requests cannot receive loop execution
 * credentials.
 */
async function authenticateDesktopManagedPopRequest(request: Request): Promise<
  | {
      ok: true;
      organizationId: string;
      userId: string;
      gatewayId: string;
    }
  | { ok: false; response: NextResponse }
> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token?.startsWith("sk_live_")) {
    return {
      ok: false,
      response: NextResponse.json(failure("Unauthorized"), { status: 401 }),
    };
  }

  const keyContext = await apiKeysService.verifyKeyWithMetadata(token, {
    updateLastUsedAt: false,
  });
  if (!keyContext) {
    return {
      ok: false,
      response: NextResponse.json(failure("Unauthorized"), { status: 401 }),
    };
  }
  if (!keyContext.scopes.includes("write")) {
    return {
      ok: false,
      response: NextResponse.json(failure("Forbidden"), { status: 403 }),
    };
  }
  if (
    keyContext.source !== ApiKeySource.DESKTOP_MANAGED ||
    !keyContext.boundPublicKey ||
    !keyContext.gatewayId
  ) {
    return {
      ok: false,
      response: NextResponse.json(
        failure("Desktop managed PoP verification failed"),
        { status: 403 }
      ),
    };
  }

  const user = await usersService.findById(
    keyContext.userId,
    keyContext.organizationId
  );
  if (!user?.active) {
    return {
      ok: false,
      response: NextResponse.json(failure("Unauthorized"), { status: 401 }),
    };
  }

  const popFailure = getDesktopManagedPopFailure(
    verifyDesktopManagedPop({
      keyContext: { ...keyContext, clerkUserId: user.clerkId },
      request,
      mode: "enforce",
    })
  );
  if (popFailure) {
    return {
      ok: false,
      response: NextResponse.json(failure(popFailure.message), {
        status: popFailure.status,
      }),
    };
  }
  await apiKeysService.touchLastUsedAt(keyContext.apiKeyId);

  return {
    ok: true,
    organizationId: keyContext.organizationId,
    userId: keyContext.userId,
    gatewayId: keyContext.gatewayId,
  };
}

function resolveLoopCredentialAction(input: {
  operationId: string;
  requestPayload: unknown;
  loopId: string;
}): LoopCredentialAction | null {
  const parsed = loopCredentialRequestPayloadValidator.safeParse(
    input.requestPayload
  );
  if (!parsed.success) {
    return null;
  }
  const payload = parsed.data;
  const normalizedPath = normalizeDesktopApiPath(payload.path);
  if (payload.body.loopId !== input.loopId) {
    return null;
  }
  if (
    input.operationId === "symphony_loop" &&
    normalizedPath === "/api/gateway/symphony/loop"
  ) {
    return "loop.launch";
  }
  if (
    input.operationId === "symphony_loop_kill" &&
    normalizedPath === "/api/gateway/symphony/loop/kill"
  ) {
    return "loop.kill";
  }
  return null;
}

function consumeCredentialRequest(input: {
  organizationId: string;
  userId: string;
  gatewayId: string;
  targetId: string;
  loopId: string;
  commandId: string;
}): Promise<
  | { ok: true; action: LoopCredentialAction }
  | { ok: false; reason: "not_found" | "invalid_command" | "conflict" }
> {
  return withDb.tx(async (tx) => {
    const target = await tx.computeTarget.findFirst({
      where: {
        id: input.targetId,
        organizationId: input.organizationId,
        userId: input.userId,
        gatewayId: input.gatewayId,
      },
      select: { id: true },
    });
    if (!target) {
      return { ok: false, reason: "not_found" } as const;
    }

    const loop = await tx.loop.findFirst({
      where: {
        id: input.loopId,
        organizationId: input.organizationId,
        computeTargetId: input.targetId,
      },
      select: { id: true },
    });
    if (!loop) {
      return { ok: false, reason: "not_found" } as const;
    }

    const command = await tx.desktopCommand.findFirst({
      where: {
        id: input.commandId,
        computeTargetId: input.targetId,
      },
      select: {
        id: true,
        operationId: true,
        requestPayload: true,
      },
    });
    if (!command) {
      return { ok: false, reason: "not_found" } as const;
    }

    const action = resolveLoopCredentialAction({
      operationId: command.operationId,
      requestPayload: command.requestPayload,
      loopId: input.loopId,
    });
    if (!action) {
      return { ok: false, reason: "invalid_command" } as const;
    }

    try {
      await tx.loopExecutionCredentialConsumption.create({
        data: {
          commandId: input.commandId,
          loopId: input.loopId,
          computeTargetId: input.targetId,
          gatewayId: input.gatewayId,
          action,
        },
      });
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2002") {
        return { ok: false, reason: "conflict" } as const;
      }
      throw error;
    }

    return { ok: true, action } as const;
  });
}

/**
 * POST /compute-targets/:id/loops/:loopId/execution-credentials
 *
 * Desktop calls this only after verifying a signed browser loop intent. Auth
 * still goes through API-key auth and the existing Desktop-managed PoP policy,
 * so browser clients never receive the loop runner JWT or inline context pack.
 */
export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{ id: string; loopId: string }>;
  }
) {
  try {
    const auth = await authenticateDesktopManagedPopRequest(request);
    if (!auth.ok) {
      return auth.response;
    }

    const { id: targetId, loopId } = await context.params;
    const { body, errorResponse: bodyErrorResponse } = await parseBody(
      request,
      executionCredentialsRequestValidator
    );
    if (bodyErrorResponse) {
      return bodyErrorResponse;
    }
    if (!body) {
      return NextResponse.json(failure("Invalid request body"), {
        status: 400,
      });
    }

    const consumption = await consumeCredentialRequest({
      organizationId: auth.organizationId,
      userId: auth.userId,
      gatewayId: auth.gatewayId,
      targetId,
      loopId,
      commandId: body.commandId,
    });
    if (!consumption.ok) {
      if (consumption.reason === "conflict") {
        return conflictResponse("Loop execution credentials already consumed");
      }
      if (consumption.reason === "invalid_command") {
        return NextResponse.json(
          failure("Command is not a signed loop intent for this loop"),
          { status: 400 }
        );
      }
      return notFoundResponse("Loop execution credentials");
    }

    const credentials = await buildDesktopLoopExecutionCredentials({
      loopId,
      organizationId: auth.organizationId,
      action: consumption.action,
    });
    return successResponse(credentials as JsonObject);
  } catch (error) {
    return errorResponse("Failed to fetch loop execution credentials", error);
  }
}
