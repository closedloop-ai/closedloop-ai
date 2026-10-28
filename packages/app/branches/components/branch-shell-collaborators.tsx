"use client";

import {
  type BranchCollaborators as BranchCollaboratorsResult,
  branchPersonKey,
} from "@repo/api/src/types/branch-identity";
import {
  type CollaboratorPerson,
  Collaborators,
} from "@repo/app/shared/components/collaborators";
import { useBranchShellCollaborators } from "../hooks/use-branch-shell-collaborators";

/**
 * Blank until the read settles and blank when it is unavailable or partial
 * (operator ruling, ISS-12267): the hook's pre-load placeholder is an
 * "unavailable" result that must not draw as a finished empty list.
 */
export function BranchShellCollaborators({ branchId }: { branchId: string }) {
  const { collaborators, isPending } = useBranchShellCollaborators(branchId);
  if (isPending) {
    return null;
  }
  return <Collaborators people={headerPeople(collaborators)} />;
}

function headerPeople(
  collaborators: BranchCollaboratorsResult
): CollaboratorPerson[] {
  return collaborators.people.map((person) => ({
    key: branchPersonKey(person),
    name: person.displayName ?? person.login ?? person.id,
    ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
  }));
}
