import {
  genericArtifactStatusCapability,
  genericArtifactStatusForRoot,
} from "../../generic-artifact-status";
import type { GenericArtifact } from "../fixtures";
import { EDITABLE_OWNERS } from "./artifact-list-owners";

/** Resolve every requested grouping axis before committing any of them. */
export function resolveArtifactGroupDrop(
  artifact: GenericArtifact,
  requests: readonly Readonly<{ fieldId: string; value: string }>[]
): GenericArtifact | null {
  let next = artifact;
  for (const request of requests) {
    const patch = resolveArtifactGroupPatch(
      next,
      request.fieldId,
      request.value
    );
    if (patch === null) {
      return null;
    }
    next = { ...next, ...patch };
  }
  return next;
}

/** Resolve the exact primary and optional secondary bands used by a group drop. */
export function resolveArtifactGroupDestination(
  artifact: GenericArtifact,
  primaryFieldId: string,
  primaryValue: string,
  secondaryFieldId?: string,
  secondaryValue?: string
): GenericArtifact | null {
  return resolveArtifactGroupDrop(artifact, [
    { fieldId: primaryFieldId, value: primaryValue },
    ...(secondaryFieldId && secondaryValue !== undefined
      ? [{ fieldId: secondaryFieldId, value: secondaryValue }]
      : []),
  ]);
}

function resolveArtifactGroupPatch(
  artifact: GenericArtifact,
  fieldId: string,
  value: string
): Partial<GenericArtifact> | null {
  if (fieldId === "status") {
    const capability = genericArtifactStatusCapability(artifact);
    const status = genericArtifactStatusForRoot(artifact, value);
    return capability.editable && status !== null
      ? { status, statusRaw: undefined }
      : null;
  }
  if (fieldId === "owner") {
    const owner = EDITABLE_OWNERS.find((candidate) => candidate.name === value);
    return owner ? { owner: owner.name, ownerInitials: owner.initials } : null;
  }
  return {
    creationValues: {
      ...artifact.creationValues,
      [fieldId]: value === "No value" ? null : value,
    },
  };
}
