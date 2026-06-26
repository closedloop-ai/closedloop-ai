import "server-only";

import { ORG_IDENTITY_HEADER } from "@repo/api/src/types/headers";
import { clerkService } from "@/lib/auth/clerk-service";

type OrgHeaderResult =
  | { kind: "session"; clerkOrgId: string; orgRole?: string }
  | { kind: "header"; clerkOrgId: string; orgRole: string }
  | { kind: "forbidden" };

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
  } catch {
    return { kind: "forbidden" };
  }
}
