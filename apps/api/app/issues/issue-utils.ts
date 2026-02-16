import { basicUserSelect } from "@/lib/db-utils";

/**
 * Typed error for issue not found - maps to 404 HTTP status.
 */
export class IssueNotFoundError extends Error {
  readonly status = 404;
  constructor(message = "Issue not found") {
    super(message);
    this.name = "IssueNotFoundError";
  }
}

/**
 * Standard include pattern for issue queries with workstream, project, assignee, and createdBy info.
 */
export const issueIncludeWithContext = {
  workstream: {
    select: {
      id: true,
      title: true,
      state: true,
    },
  },
  project: {
    select: {
      id: true,
      organizationId: true,
      name: true,
      teams: {
        select: {
          team: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        take: 1,
      },
    },
  },
  assignee: basicUserSelect,
  createdBy: basicUserSelect,
} as const;
