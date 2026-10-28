"use client";

import {
  CollaboratorArtifactType,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import { useQuery } from "@tanstack/react-query";
import { useAgentSessionsDataSource } from "../data-source/provider";
import { agentSessionKeys } from "./agent-session-keys";

/** Use the active source; local identities must never be guessed against cloud IDs. */
export function useSessionShellCollaborators(sessionId: string) {
  const source = useAgentSessionsDataSource();
  const query = useQuery({
    queryKey: agentSessionKeys.collaborators(source.scope, sessionId),
    queryFn: async () => {
      const response = await source.collaborators?.([sessionId]);
      const entry = response?.results.find(
        (candidate) =>
          candidate.artifactId === sessionId &&
          candidate.artifactType === CollaboratorArtifactType.Session
      );
      return (
        (entry?.artifactType === CollaboratorArtifactType.Session
          ? entry.collaborators
          : undefined) ??
        unavailableArtifactCollaborators(CollaboratorArtifactType.Session)
      );
    },
    staleTime: 30_000,
  });
  return {
    ...query,
    collaborators: query.isError
      ? unavailableArtifactCollaborators(CollaboratorArtifactType.Session)
      : (query.data ??
        unavailableArtifactCollaborators(CollaboratorArtifactType.Session)),
  };
}
