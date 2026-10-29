import type { BasicUser } from "@repo/api/src/types/user";
import type { Prisma } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";
import { createThrottledMonitoredEvent } from "@/lib/observability/throttled-monitored-event";

/**
 * The refusal a caller gets when a user id names somebody outside their
 * organization — or nobody at all. One sentence for both on purpose, so the
 * error cannot be used to probe for user ids in other organizations.
 *
 * Shared rather than repeated because it reaches a client from two services
 * (`documentsService` and `projectsService`) and a reworded copy in one would
 * silently diverge from the other.
 */
export const USER_NOT_IN_ORGANIZATION_MESSAGE =
  "Invalid user ID: user not found in this organization";

/**
 * Whether `userId` names a user inside `organizationId`.
 *
 * The client is a parameter rather than an ambient `withDb` because the two
 * callers need different ones: a write that must resolve the reference inside
 * its own transaction passes `tx`, and a caller outside one passes the pooled
 * client. This answers the question and nothing else — what a `false` costs is
 * each caller's own error policy.
 */
export async function isUserInOrganization(
  client: Pick<Prisma.TransactionClient, "user">,
  userId: string,
  organizationId: string
): Promise<boolean> {
  const user = await client.user.findFirst({
    where: { id: userId, organizationId },
    select: { id: true },
  });
  return user !== null;
}

/**
 * `basicUserSelect` plus the user's organization, so a read can compare it to
 * the owning record's before projecting the user (ISS-10989). The organization
 * is read to be compared, never returned.
 */
export const orgCheckedUserSelect = {
  select: { ...basicUserSelect.select, organizationId: true },
} as const;

/**
 * The event a project read reports a cross-organization assignee on. A stable
 * snake_case name so a log query or monitor can key on it. It is the per-read
 * diagnostic; what pages on these rows is the daily
 * `data.invariant.cross_org_project_assignees` violation check
 * (`app/cron/audit-data-invariants/cross-org-project-assignees.ts`).
 */
export const PROJECT_ASSIGNEE_CROSS_ORG_EVENT =
  "project_assignee_cross_org_read";

/**
 * Every project list and search read reaches the guard once per row, so an
 * org member refreshing a list could repeat the event without bound
 * (`apps/api/AGENTS.md` "Emission and Abuse Control"). One event per project
 * per window; the rest roll up into a counted `aggregated` event that still
 * names the project. Keyed on the project, not the org: an org-only key let the
 * first row in a list win every window, so a second corrupt row was never
 * named. The write is closed (ISS-9487), so the keyspace cannot grow past the
 * rows already written, and the throttle's LRU cap bounds it regardless.
 */
const crossOrgAssigneeEvent = createThrottledMonitoredEvent();

/** Exported so tests can `clear()` it; production code must not reach in. */
export const projectAssigneeCrossOrgThrottle = crossOrgAssigneeEvent.throttle;

/**
 * The project's assignee, or `null` when that user belongs to a different
 * organization than the project.
 *
 * `projects.assignee_id` is only an FK to `users.id`, which a user in any
 * organization satisfies, and the write was unscoped until ISS-9487. A row
 * written through that hole must render as unassigned, not as another tenant's
 * name, email and avatar (ISS-10989, AC3). Production held zero such rows on
 * 2026-09-23, so reaching the `null` branch is corrupt data and is logged.
 */
export function projectAssigneeInOrganization(
  project: { id: string; organizationId: string },
  assignee: (BasicUser & { organizationId: string }) | null
): BasicUser | null {
  if (!assignee) {
    return null;
  }
  const { organizationId, ...user } = assignee;
  if (organizationId === project.organizationId) {
    return user;
  }
  crossOrgAssigneeEvent.report(
    `${project.organizationId}:${project.id}`,
    {
      event: PROJECT_ASSIGNEE_CROSS_ORG_EVENT,
      payload: {
        organizationId: project.organizationId,
        projectId: project.id,
      },
    },
    {}
  );
  return null;
}
