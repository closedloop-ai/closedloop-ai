import { log } from "@repo/observability/log";
import { isChannelOrgId } from "@repo/realtime-contract/channels";
import type { IssuedRealtimeToken } from "@repo/realtime-contract/protocol";
import { issueRealtimeToken } from "@repo/realtime-contract/token";
import { env } from "@/env";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  serviceUnavailableResponse,
  successResponse,
} from "@/lib/route-utils";
import { buildRealtimeGrants } from "../grant-policy";
import {
  REALTIME_TOKEN_ISSUED_EVENT,
  RealtimeTokenErrorCode,
} from "./realtime-token-contract";
import { realtimeTokenSigning } from "./token-signing";
import { withPublicUrl } from "./with-public-url";

/**
 * Mints a short-lived realtime grant token for the caller's own organization
 * (PLN-2103 Step 5). Accepts a Clerk session, a desktop session bearer, or an
 * `sk_live_*` key with the `read` scope.
 */
export const POST = withAnyAuth<IssuedRealtimeToken, "/realtime/token">(
  async ({ user, authMethod }) => {
    const signing = realtimeTokenSigning();
    if (signing === undefined) {
      return serviceUnavailableResponse(REALTIME_NOT_CONFIGURED_MESSAGE, {
        code: RealtimeTokenErrorCode.NotConfigured,
      });
    }
    // A grant naming an org the address grammar rejects can never match a
    // channel, so the client would be refused on every join with a valid token.
    if (!isChannelOrgId(user.organizationId)) {
      return errorResponse(
        UNADDRESSABLE_ORG_MESSAGE,
        new Error(UNADDRESSABLE_ORG_MESSAGE)
      );
    }
    const grants = buildRealtimeGrants({
      organizationId: user.organizationId,
      userId: user.id,
    });
    try {
      const issued = await issueRealtimeToken(
        { sub: user.id, org: user.organizationId, grants },
        signing
      );
      // Clients re-mint about every TTL, so a success is routine: debug, per
      // apps/api/AGENTS.md. The 503 and the unaddressable-org path log louder.
      log.debug(REALTIME_TOKEN_ISSUED_EVENT, {
        userId: user.id,
        organizationId: user.organizationId,
        authMethod,
        grantCount: grants.length,
        expiresAt: issued.expiresAt,
      });
      return successResponse(withPublicUrl(issued, env.REALTIME_PUBLIC_URL));
    } catch (error) {
      return errorResponse("Unable to issue realtime token", error);
    }
  },
  { requiredScopes: ["read"] }
);

const REALTIME_NOT_CONFIGURED_MESSAGE = "Realtime is not configured";
const UNADDRESSABLE_ORG_MESSAGE =
  "Organization id cannot address a realtime channel";
