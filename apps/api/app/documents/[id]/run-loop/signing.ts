import { stableStringify } from "@repo/api/src/stable-stringify";
import type { ApiResult, JsonValue } from "@repo/api/src/types/common";
import { COMMAND_SIGNING_CAPABILITY_KEY } from "@repo/api/src/types/compute-target";
import type { NextResponse } from "next/server";
import { computeTargetsService } from "@/app/compute-targets/service";
import { enforceRegisteredBrowserPublicKey } from "@/lib/browser-command-public-key-enforcement";
import { isComputeTargetSigningSupportedForUser } from "@/lib/command-signing-feature";
import { badRequestResponse } from "@/lib/route-utils";
import type { RunLoopBody } from "./validators";

type SignedRunLoopIntent = NonNullable<RunLoopBody["userIntentSignature"]>;

type ResolveSignedRunLoopIntentResult =
  | { ok: true; userIntentSignature: SignedRunLoopIntent | undefined }
  | { ok: false; response: NextResponse<ApiResult<never>> };

function buildRunLoopUserIntent(
  documentId: string,
  body: RunLoopBody
): JsonValue {
  return {
    documentId,
    command: body.command,
    ...(body.prompt === undefined ? {} : { prompt: body.prompt }),
    ...(body.computeTargetId === undefined
      ? {}
      : { computeTargetId: body.computeTargetId }),
    ...(body.backendOverride ? { backendOverride: body.backendOverride } : {}),
    ...(body.repo ? { repo: body.repo } : {}),
    ...(body.additionalRepos ? { additionalRepos: body.additionalRepos } : {}),
    ...(body.desktopApiNamespace
      ? { desktopApiNamespace: body.desktopApiNamespace }
      : {}),
  };
}

/**
 * Determines whether a run-loop intent must be signed using the target owner's
 * rollout identity. Shared targets must not inherit the browser viewer's flag
 * state because Desktop enforcement is negotiated from the owner's hello auth.
 */
export async function isRunLoopSigningRequired(input: {
  computeTargetId: string | undefined;
  requesterUserId: string;
  requesterClerkUserId?: string | null;
}): Promise<boolean> {
  if (!input.computeTargetId) {
    return false;
  }
  const target = await computeTargetsService.findById(input.computeTargetId);
  const capabilities = target?.capabilities as Record<string, unknown> | null;
  if (capabilities?.[COMMAND_SIGNING_CAPABILITY_KEY] !== true) {
    return false;
  }
  if (!target?.userId) {
    return false;
  }
  return isComputeTargetSigningSupportedForUser({
    userId: target.userId,
    clerkUserId:
      target.userId === input.requesterUserId
        ? input.requesterClerkUserId
        : target.user?.clerkId,
  });
}

/**
 * Validates an optional signed run-loop intent. When a signed intent is
 * present, the browser key must still be registered to the authenticated
 * requester even if the target does not currently require signing.
 */
export async function resolveEffectiveSignedRunLoopIntent(input: {
  computeTargetId: string | undefined;
  requesterUserId: string;
  requesterOrganizationId: string;
  requesterClerkUserId?: string | null;
  documentId: string;
  body: RunLoopBody;
}): Promise<ResolveSignedRunLoopIntentResult> {
  const signingRequired = await isRunLoopSigningRequired({
    computeTargetId: input.computeTargetId,
    requesterUserId: input.requesterUserId,
    requesterClerkUserId: input.requesterClerkUserId,
  });
  const signedUserIntent = input.body.userIntentSignature;
  if (signingRequired && !signedUserIntent) {
    return {
      ok: false,
      response: badRequestResponse(
        "Command signing is required for this compute target"
      ),
    };
  }
  if (signedUserIntent) {
    const expectedIntent = buildRunLoopUserIntent(input.documentId, input.body);
    if (
      stableStringify(signedUserIntent.body) !== stableStringify(expectedIntent)
    ) {
      return {
        ok: false,
        response: badRequestResponse(
          "Signed run-loop intent does not match request"
        ),
      };
    }

    const registrationError = await enforceRegisteredBrowserPublicKey({
      userId: input.requesterUserId,
      organizationId: input.requesterOrganizationId,
      publicKeyFingerprint: signedUserIntent.publicKeyFingerprint,
    });
    if (registrationError) {
      return { ok: false, response: registrationError };
    }
  }
  return {
    ok: true,
    userIntentSignature: signingRequired ? signedUserIntent : undefined,
  };
}
