import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { log } from "@repo/observability/log";
import type {
  DOC_SYNC_TOKEN_PATH,
  DocSyncTokenResponse,
} from "@repo/realtime-contract/protocol";
import { env } from "@/env";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseBody,
  serviceUnavailableResponse,
  successResponse,
} from "@/lib/route-utils";
import { realtimeTokenSigning } from "../../realtime/token/token-signing";
import {
  DOC_SYNC_TOKEN_ISSUED_EVENT,
  DocSyncTokenErrorCode,
  docSyncTokenRequestSchema,
} from "./doc-sync-token-contract";
import { failureResponse } from "./doc-sync-token-responses";
import { docSyncTokenService } from "./service";

/**
 * Mints a short-lived token for one document on the document sync service
 * (PLN-2099 E4), in the realtime token format, plus the service URL. Requires
 * the `write` scope from an `sk_live_*` key, as `/collaboration/auth` does.
 */
export const POST = withAnyAuth<
  DocSyncTokenResponse,
  typeof DOC_SYNC_TOKEN_PATH
>(
  async ({ user, authMethod }, request) => {
    const signing = realtimeTokenSigning();
    const url = env.DOC_SYNC_PUBLIC_URL;
    if (signing === undefined || url === undefined) {
      return serviceUnavailableResponse(DOC_SYNC_NOT_CONFIGURED_MESSAGE, {
        code: DocSyncTokenErrorCode.NotConfigured,
      });
    }
    const { body, errorResponse: invalidBody } = await parseBody(
      request,
      docSyncTokenRequestSchema
    );
    if (invalidBody) {
      return invalidBody;
    }
    try {
      const result = await docSyncTokenService.issueToken({
        user,
        room: body.room,
        signing,
      });
      if (!result.ok) {
        return failureResponse(result.error);
      }
      const { issued, slug, firstOpenSeed } = result.value;
      // Clients re-mint on every reconnect, so a success is routine: debug,
      // per apps/api/AGENTS.md.
      log.debug(DOC_SYNC_TOKEN_ISSUED_EVENT, {
        userId: user.id,
        organizationId: user.organizationId,
        slug,
        authMethod,
        expiresAt: issued.expiresAt,
      });
      return successResponse({ ...issued, url, firstOpenSeed });
    } catch (error) {
      return errorResponse("Unable to issue document sync token", error);
    }
  },
  { requiredScopes: [ApiKeyScope.Write] }
);

const DOC_SYNC_NOT_CONFIGURED_MESSAGE = "Document sync is not configured";
