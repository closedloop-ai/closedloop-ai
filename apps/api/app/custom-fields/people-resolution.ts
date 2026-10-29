import type { BasicUser } from "@repo/api/src/types/user";
import { withDb } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";

/**
 * The one org-scoped user lookup the custom-field services make.
 *
 * Four copies of this query used to exist — the inline fetch in
 * `getValuesForEntity`, a private `resolvePeopleMap` in `values-service`, a
 * private `resolvePeopleNames` in `utils`, and the presence check in
 * `validatePeopleIds` — which is how the write path ended up resolving names
 * through an UNORDERED `findMany` that did not even select `id`, while the read
 * path ordered by the stored array (ISS-7215).
 *
 * `organizationId` is not optional and not derived: `User` and
 * `CustomFieldValue` carry their own org columns, so a row naming a user from
 * another tenant is schema-valid and only this predicate keeps the lookup
 * inside the caller's org — the same reason `enumOptionsService` states for its
 * cascade.
 */
export async function resolvePeopleMap(
  ids: string[],
  organizationId: string
): Promise<Map<string, BasicUser>> {
  if (ids.length === 0) {
    return new Map();
  }
  const users = await withDb((db) =>
    db.user.findMany({
      where: { id: { in: ids }, organizationId },
      ...basicUserSelect,
    })
  );
  return new Map(users.map((user) => [user.id, user]));
}
