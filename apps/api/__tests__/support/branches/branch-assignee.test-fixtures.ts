import { organizationId } from "./branch-read-service.test-helpers";

/**
 * A branch row's `assignee` relation, which is the branch Owner (ISS-12463).
 * Pass it to `makeBranchRow({ assignee })`.
 */
export function makeBranchAssignee(
  userId: string,
  overrides: {
    firstName?: string | null;
    lastName?: string | null;
    organizationId?: string;
  } = {}
) {
  return {
    id: userId,
    email: `${userId}@example.com`,
    firstName: overrides.firstName ?? null,
    lastName: overrides.lastName ?? null,
    avatarUrl: null,
    organizationId: overrides.organizationId ?? organizationId,
  };
}
