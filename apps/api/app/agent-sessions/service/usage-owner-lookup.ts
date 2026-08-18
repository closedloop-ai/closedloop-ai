import type { BasicUser } from "@repo/api/src/types/user";
import { withDb } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";
import { toBasicUser } from "./projections";

/**
 * Resolve the display identities behind the Sessions usage-summary Owner facet.
 *
 * Extracted from `service.ts` (ISS-5355) for the same reason
 * `usage-facet-projections.ts` was (ISS-5283): that file is grandfathered over
 * the 1,000-line ceiling and is SHRINK-ONLY, and "turn a set of grouped user ids
 * into labelled users" is a separate responsibility from "decide which
 * population each aggregate runs over".
 *
 * Sessions whose owner was deleted carry a null `userId` (SetNull) and are
 * grouped under a null key. Those ids are dropped here rather than looked up, so
 * the caller's projection simply finds no user for that group — an unowned
 * session is never attributed to someone else.
 */
export async function buildUsageOwnerMap(
  organizationId: string,
  groups: readonly { userId: string | null }[]
): Promise<Map<string, BasicUser>> {
  const userIds = groups
    .map((group) => group.userId)
    .filter((value): value is string => value != null);
  if (userIds.length === 0) {
    return new Map();
  }
  const users = await withDb((db) =>
    db.user.findMany({
      where: { organizationId, id: { in: userIds } },
      select: basicUserSelect.select,
    })
  );
  return new Map(users.map((user) => [user.id, toBasicUser(user)]));
}
