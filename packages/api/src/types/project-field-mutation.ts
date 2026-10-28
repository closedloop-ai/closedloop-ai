/**
 * ISS-11198 — the conflict contract for the name and description guards on
 * `PUT /projects/{id}`: `expectedName` and `expectedDescription`, following the
 * ISS-9486 rules. Each guard is valid only beside its own field, an omitted
 * guard is unguarded last-write-wins, and a value the project already holds is
 * never refused.
 *
 * Project codes, not the session `stale_name`: that code's `details` entry is
 * keyed by an artifact id, and a project is not an artifact.
 */

import type { JsonObject } from "./common.ts";
import { Status } from "./result.ts";

export const ProjectFieldMutationErrorCode = {
  StaleName: "stale_project_name",
  StaleDescription: "stale_project_description",
} as const;
export type ProjectFieldMutationErrorCode =
  (typeof ProjectFieldMutationErrorCode)[keyof typeof ProjectFieldMutationErrorCode];

export type ProjectStaleName = JsonObject & {
  projectId: string;
  currentName: string;
  expectedName: string;
};

/**
 * Compared with the RENDERED description, where an unset one renders as the
 * empty string, because that is what the client read.
 */
export type ProjectStaleDescription = JsonObject & {
  projectId: string;
  currentDescription: string;
  expectedDescription: string;
};

export type ProjectFieldMutationErrorDetails = JsonObject & {
  staleNames?: ProjectStaleName[];
  staleDescriptions?: ProjectStaleDescription[];
};

export type ProjectFieldMutationError = {
  status: typeof Status.Conflict;
  code: ProjectFieldMutationErrorCode;
  message: string;
  details: ProjectFieldMutationErrorDetails;
};

export function staleProjectNameConflict(
  staleName: ProjectStaleName
): ProjectFieldMutationError {
  return {
    status: Status.Conflict,
    code: ProjectFieldMutationErrorCode.StaleName,
    message: "One or more projects changed before the name update",
    details: { staleNames: [staleName] },
  };
}

export function staleProjectDescriptionConflict(
  staleDescription: ProjectStaleDescription
): ProjectFieldMutationError {
  return {
    status: Status.Conflict,
    code: ProjectFieldMutationErrorCode.StaleDescription,
    message: "One or more projects changed before the description update",
    details: { staleDescriptions: [staleDescription] },
  };
}
