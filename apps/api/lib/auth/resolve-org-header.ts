import "server-only";

import { AuthErrorCode } from "@repo/api/src/types/auth-error";
import { ORG_IDENTITY_HEADER } from "@repo/api/src/types/headers";
import { log } from "@repo/observability/log";
import { clerkService } from "@/lib/auth/clerk-service";

/**
 * Cap on how much of the caller-supplied org header reaches the log. A Clerk org
 * id is ~31 characters; anything longer is malformed input, not an identifier.
 */
const MAX_LOGGED_HEADER_ORG_ID_LENGTH = 64;

/**
 * Outcome of reconciling the request's org header against the caller's session.
 *
 * `forbidden` and `unverifiable` are deliberately distinct (ISS-5118). The first
 * is an authorization DECISION — Clerk answered, and the answer was "not a
 * member". The second is an AVAILABILITY failure — Clerk did not answer at all,
 * so nothing about the caller's access is known. Collapsing them made an outage
 * indistinguishable from a denial in telemetry, and made the client advise a
 * re-auth that cannot fix a provider outage.
 */
type OrgHeaderResult =
  | { kind: "session"; clerkOrgId: string; orgRole?: string }
  | { kind: "header"; clerkOrgId: string; orgRole: string }
  | { kind: "forbidden" }
  | { kind: "unverifiable" };

export async function resolveOrgHeader(
  request: Request,
  clerkUserId: string,
  sessionClerkOrgId: string,
  sessionOrgRole?: string
): Promise<OrgHeaderResult> {
  const headerOrgId = request.headers.get(ORG_IDENTITY_HEADER);

  if (!headerOrgId || headerOrgId === sessionClerkOrgId) {
    return {
      kind: "session",
      clerkOrgId: sessionClerkOrgId,
      orgRole: sessionOrgRole,
    };
  }

  try {
    const role = await clerkService.getOrganizationMembershipRole(
      headerOrgId,
      clerkUserId
    );
    if (!role) {
      return { kind: "forbidden" };
    }
    return { kind: "header", clerkOrgId: headerOrgId, orgRole: role };
  } catch (error) {
    // The lookup failed, so the caller's membership is UNKNOWN — not denied.
    // Logged rather than swallowed so an identity-provider outage is visible as
    // itself instead of arriving as a spike in legitimate denials. `headerOrgId`
    // is a caller-supplied header, so it is length-bounded before it reaches the
    // log rather than trusted to be an org id.
    log.error("Org header verification failed", {
      error,
      code: AuthErrorCode.OrgUnverifiable,
      clerkUserId,
      headerOrgId: headerOrgId.slice(0, MAX_LOGGED_HEADER_ORG_ID_LENGTH),
    });
    return { kind: "unverifiable" };
  }
}
