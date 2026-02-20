import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { apiKeysService } from "@/app/api-keys/service";
import { env } from "@/env";
import {
  errorResponse,
  parseBody,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";

const verifyApiKeyValidator = z.object({
  key: z.string().min(1, "Key is required"),
});

export async function POST(request: Request) {
  // Reject requests when INTERNAL_API_SECRET is not configured or header does not match
  const internalSecret = env.INTERNAL_API_SECRET;
  const headerSecret = request.headers.get("X-Internal-Secret");
  if (!(internalSecret && headerSecret)) {
    return unauthorizedResponse();
  }
  const expectedBuf = Buffer.from(internalSecret, "utf8");
  const actualBuf = Buffer.from(headerSecret, "utf8");
  if (
    expectedBuf.length !== actualBuf.length ||
    !timingSafeEqual(expectedBuf, actualBuf)
  ) {
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
    const context = await apiKeysService.verifyKey(body.key);
    if (!context) {
      return unauthorizedResponse();
    }
    return successResponse({
      userId: context.userId,
      organizationId: context.organizationId,
    });
  } catch (error) {
    return errorResponse("Failed to verify API key", error);
  }
}
