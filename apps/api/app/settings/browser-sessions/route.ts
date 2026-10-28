import {
  BrowserSessionErrorCode,
  type BrowserSessionListResponse,
} from "@repo/api/src/types/browser-session";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  forbiddenResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { pageBoundValidator } from "@/lib/validators/pagination";
import { browserSessionService } from "../browser-session-service";

/**
 * `.strict()` is deliberate. `parseQueryParams` hands every search key to this
 * schema, so a non-strict object would strip a misspelled `?limt=20` and answer
 * with the default page — a 200 for a request the route did not honor. This
 * route implements exactly two params; anything else is a 400.
 */
const listQueryValidator = z
  .object({
    limit: pageBoundValidator,
    offset: pageBoundValidator,
  })
  .strict();

/**
 * GET /settings/browser-sessions
 *
 * The signed-in user's own active browser sign-ins (ISS-9085), for ISS-8366's
 * Connected Devices panel.
 *
 * `withAnyAuth`, not `withAuth`: the Desktop renderer reaches this API with a
 * desktop-session token, which `withAuth` rejects outright, and the panel ships
 * on both surfaces. The api-key transport is then refused below.
 *
 * No org-admin gate. `SettingsDomainId.Devices` already grants read and edit to
 * every role, and these are the caller's OWN sign-ins — gating them on admin
 * would stop a member signing out their own browser.
 */
export const GET = withAnyAuth<
  BrowserSessionListResponse,
  "/settings/browser-sessions"
>(async ({ clerkUserId, clerkSessionId, authMethod }, request) => {
  if (authMethod === "api_key") {
    return forbiddenResponse();
  }

  const { params, errorResponse: parseError } = parseQueryParams(
    request,
    listQueryValidator
  );
  if (parseError) {
    return parseError;
  }

  try {
    const page = await browserSessionService.list({
      clerkUserId,
      clerkSessionId,
      limit: params.limit,
      offset: params.offset,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    return successResponse(page);
  } catch (error) {
    // 503, never an empty list: "this user has no other sessions" and "we could
    // not ask the provider" must stay distinguishable to the panel.
    return errorResponse("Failed to list browser sessions", error, 503, {
      code: BrowserSessionErrorCode.ProviderUnavailable,
    });
  }
});
