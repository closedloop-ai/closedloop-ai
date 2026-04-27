import { createHmac, timingSafeEqual } from "node:crypto";
import { DESKTOP_POP_HEADER_NAMES } from "@repo/api/src/types/api-key";
import { failure } from "@repo/api/src/types/common";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiKeysService } from "@/app/api-keys/service";
import { env } from "@/env";
import { getDesktopManagedPopRequestFailure } from "@/lib/auth/desktop-managed-pop";
import {
  errorResponse,
  parseBody,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";

const verifyApiKeyValidator = z.object({
  key: z.string().min(1, "Key is required"),
  desktopPopRequired: z.boolean().optional(),
});

export async function POST(request: Request) {
  // Reject requests when INTERNAL_API_SECRET is not configured or header does not match
  const internalSecret = env.INTERNAL_API_SECRET;
  const headerSecret = request.headers.get("X-Internal-Secret");
  if (!(internalSecret && headerSecret)) {
    return unauthorizedResponse();
  }
  const digestKey = "api-constant-time-compare";
  const expectedDigest = createHmac("sha256", digestKey)
    .update(internalSecret, "utf8")
    .digest();
  const actualDigest = createHmac("sha256", digestKey)
    .update(headerSecret, "utf8")
    .digest();
  if (!timingSafeEqual(expectedDigest, actualDigest)) {
    return unauthorizedResponse();
  }

  const { body, errorResponse: parseError } = await parseBody(
    request,
    verifyApiKeyValidator
  );
  if (parseError) {
    return parseError;
  }

  try {
    const context = await apiKeysService.verifyKeyWithMetadata(body.key, {
      updateLastUsedAt: false,
    });
    if (!context) {
      return unauthorizedResponse();
    }

    if (shouldApplyDesktopManagedPop(body.desktopPopRequired, request)) {
      const popFailure = await getDesktopManagedPopRequestFailure({
        keyContext: context,
        request,
      });
      if (popFailure) {
        return NextResponse.json(failure(popFailure.message), {
          status: popFailure.status,
        });
      }
    }

    waitUntil(apiKeysService.touchLastUsedAt(context.apiKeyId));

    return successResponse({
      userId: context.userId,
      organizationId: context.organizationId,
      scopes: context.scopes,
    });
  } catch (error) {
    return errorResponse("Failed to verify API key", error, 503);
  }
}

function shouldApplyDesktopManagedPop(
  desktopPopRequired: boolean | undefined,
  request: Request
): boolean {
  return (
    desktopPopRequired === true ||
    DESKTOP_POP_HEADER_NAMES.some((headerName) =>
      request.headers.has(headerName)
    )
  );
}
