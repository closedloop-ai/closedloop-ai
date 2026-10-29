import type { ApiResult } from "@repo/api/src/types/common";
import type { TeamRole } from "@repo/api/src/types/teams";
import type { User } from "@repo/api/src/types/user";
import type { NextResponse } from "next/server";
import { forbiddenResponse, notFoundResponse } from "@/lib/route-utils";
import { teamsService } from "./service";

/**
 * Gate a team write on org tenancy first, then on a team role floor.
 *
 * Returns `null` when the caller is cleared, or the exact response the route
 * must return. The ORDERING is the contract, and is why this is one function
 * rather than a preamble each route copies.
 *
 * **404 before 403, and 404 for both cases.** `lib/org-scope.ts` owns this rule:
 * not-found and cross-org collapse to one outcome the route maps to 404, never a
 * 403 and never a distinct "belongs to another org" signal, because existence is
 * itself org-scoped information. A 403 here would tell a caller probing ids that
 * a team exists in some other org.
 *
 * The team is deliberately not returned — no call site reads it, and handing back
 * a value nobody consumes would invite a second, heavier lookup.
 *
 * `hasRole` reports a bare false for two different reasons — role floor unmet, or
 * no membership row at all — so a team deleted between the two probes would leave
 * as a 403 and contradict the 404 promised above. The deny path re-probes to tell
 * those apart. That costs a third round-trip only on denial; a caller cleared by
 * the role gate still pays two.
 */
export async function requireTeamRole(
  teamId: string,
  user: Pick<User, "id" | "organizationId">,
  requiredRole: TeamRole
): Promise<NextResponse<ApiResult<never>> | null> {
  const exists = await teamsService.existsInOrganization(
    teamId,
    user.organizationId
  );
  if (!exists) {
    return notFoundResponse("Team");
  }

  const hasPermission = await teamsService.hasRole({
    teamId,
    organizationId: user.organizationId,
    userId: user.id,
    requiredRole,
  });
  if (hasPermission) {
    return null;
  }

  const stillExists = await teamsService.existsInOrganization(
    teamId,
    user.organizationId
  );
  if (stillExists) {
    return forbiddenResponse();
  }
  return notFoundResponse("Team");
}
