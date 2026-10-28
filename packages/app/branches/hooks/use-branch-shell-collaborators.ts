"use client";

import {
  CollaboratorArtifactType,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import { useQuery } from "@tanstack/react-query";
import { useBranchesDataSource } from "../data-source/provider";
import { branchRowQueryKeys } from "./branch-query-keys";

/** Use the active source; local identities must never be guessed against cloud IDs. */
export function useBranchShellCollaborators(branchId: string) {
  const source = useBranchesDataSource();
  const query = useQuery({
    queryKey: [
      ...branchRowQueryKeys.details,
      source.scope,
      branchId,
      "collaborators",
    ],
    queryFn: async () => {
      const response = await source.collaborators?.([branchId]);
      const entry = response?.results.find(
        (candidate) =>
          candidate.artifactId === branchId &&
          candidate.artifactType === CollaboratorArtifactType.Branch
      );
      return (
        (entry?.artifactType === CollaboratorArtifactType.Branch
          ? entry.collaborators
          : undefined) ??
        unavailableArtifactCollaborators(CollaboratorArtifactType.Branch)
      );
    },
    staleTime: 30_000,
  });
  return {
    ...query,
    collaborators: query.isError
      ? unavailableArtifactCollaborators(CollaboratorArtifactType.Branch)
      : (query.data ??
        unavailableArtifactCollaborators(CollaboratorArtifactType.Branch)),
  };
}
