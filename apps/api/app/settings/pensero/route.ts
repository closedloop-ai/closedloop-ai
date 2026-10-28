import type {
  PenseroCredentialInfoResponse,
  RemovePenseroCredentialResponse,
  SetPenseroCredentialRequest,
} from "@repo/api/src/types/pensero-integration";
import { PenseroRouteErrorCode } from "@repo/api/src/types/pensero-integration";
import { SettingsCommandCapability } from "@repo/api/src/types/settings-command";
import { SettingsDomainId } from "@repo/api/src/types/settings-domain";
import { requireSettingsCommand } from "@/lib/auth/settings-command";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  type PenseroCredentialInfo,
  penseroIntegrationService,
} from "../pensero-integration-service";
import { isPenseroIntegrationRolloutEnabled } from "./pensero-rollout-feature";
import { setPenseroCredentialValidator } from "./validators";

function toResponse(
  info: PenseroCredentialInfo
): PenseroCredentialInfoResponse {
  return {
    isSet: info.isSet,
    lastFour: info.lastFour,
    baseUrl: info.baseUrl,
    teamIdentifiers: info.teamIdentifiers,
    setAt: info.setAt ? info.setAt.toISOString() : null,
  };
}

/**
 * GET /settings/pensero
 * Presence + fingerprint of this org's Pensero credential. Never the token.
 *
 * Readable by any member of the org, matching the Claude-key info endpoint: it
 * discloses nothing secret, and a non-admin needs it to see WHY the delivery
 * metrics on their dashboard are or are not configured.
 */
export const GET = withAnyAuth<
  PenseroCredentialInfoResponse,
  "/settings/pensero"
>(async ({ user }) => {
  try {
    const info = await penseroIntegrationService.getOrgCredentialInfo(
      user.organizationId
    );
    return successResponse(toResponse(info));
  } catch (error) {
    return errorResponse("Failed to fetch Pensero credential info", error);
  }
});

/**
 * PUT /settings/pensero
 * Create or replace this organization's Pensero credential. Admin only.
 *
 * The response echoes the same fingerprint shape as GET, NOT the submitted
 * token — a write confirms what is now stored without handing the secret back
 * across the boundary it just crossed.
 *
 * GATED ON THE ROLLOUT FLAG, unlike GET and DELETE — see
 * `pensero-rollout-feature.ts`. This is the only verb that CREATES state, and
 * an org row wins over the env token once layer 3 reads it, so a credential
 * written while the rollout is off is state outside the rollout.
 */
export const PUT = withAuth<PenseroCredentialInfoResponse, "/settings/pensero">(
  async ({ user, clerkOrgId, clerkUserId }, request) => {
    try {
      const denial = await requireSettingsCommand({
        clerkOrgId,
        clerkUserId,
        domain: SettingsDomainId.Connections,
        capability: SettingsCommandCapability.Admin,
      });
      if (denial) {
        return denial;
      }

      // AFTER the admin gate, deliberately: authorization is the boundary and
      // the flag is a rollout control, so the 403 a non-admin gets must not
      // depend on PostHog being reachable.
      if (
        !(await isPenseroIntegrationRolloutEnabled({
          clerkUserId,
          userId: user.id,
        }))
      ) {
        return forbiddenResponse({
          code: PenseroRouteErrorCode.RolloutDisabled,
        });
      }

      const { body, errorResponse: parseFailure } = await parseBody(
        request,
        setPenseroCredentialValidator
      );
      if (parseFailure) {
        return parseFailure;
      }

      // Annotated with the SHARED request contract, not left to inference: the
      // schema decides what this route accepts and the type is what the client
      // sends, and nothing else makes the two agree. A field added to one alone
      // fails `tsc` here instead of arriving as `undefined` at runtime.
      const credential: SetPenseroCredentialRequest = {
        token: body.token,
        baseUrl: body.baseUrl,
        teamIdentifiers: body.teamIdentifiers,
      };

      const info = await penseroIntegrationService.setOrgCredential(
        user.organizationId,
        credential
      );

      return successResponse(toResponse(info));
    } catch (error) {
      return errorResponse("Failed to save Pensero credential", error);
    }
  }
);

/**
 * DELETE /settings/pensero
 * Remove this organization's Pensero credential. Admin only.
 */
export const DELETE = withAuth<
  RemovePenseroCredentialResponse,
  "/settings/pensero"
>(async ({ user, clerkOrgId, clerkUserId }) => {
  try {
    const denial = await requireSettingsCommand({
      clerkOrgId,
      clerkUserId,
      domain: SettingsDomainId.Connections,
      capability: SettingsCommandCapability.Admin,
    });
    if (denial) {
      return denial;
    }

    await penseroIntegrationService.removeOrgCredential(user.organizationId);
    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to remove Pensero credential", error);
  }
});
