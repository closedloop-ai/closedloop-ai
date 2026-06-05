import { basicUserSelect } from "@/lib/db-utils";

/**
 * Typed error for feature not found - maps to 404 HTTP status.
 */
export class FeatureNotFoundError extends Error {
  readonly status = 404;
  constructor(message = "Feature not found") {
    super(message);
    this.name = "FeatureNotFoundError";
  }
}

/**
 * Standard include pattern for feature queries with workstream, project, assignee, and createdBy info.
 */
export const featureIncludeWithContext = {
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
