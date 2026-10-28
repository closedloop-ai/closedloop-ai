"use client";

import { type Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import type { ArtifactCollaboratorEntry } from "@repo/api/src/types/artifact-collaborators";
import { useMemo } from "react";
// Project rows share the artifact-generic provenance read with document lists.
import { useRelatedSessionsPage } from "../../documents/hooks/use-related-sessions";
import { useArtifactCollaborators } from "../../shared/hooks/use-artifact-collaborators";
import {
  type ProjectArtifactReadModel,
  visibleProjectArtifacts,
} from "../lib/project-artifact-read-model";

/** Bounded canonical metadata reads for a mixed project list's visible rows. */
export function useProjectArtifactListMetadata({
  model,
  visibleArtifactIds,
  includePeople,
  includeRelatedSessions,
}: {
  model: ProjectArtifactReadModel;
  visibleArtifactIds: readonly string[];
  includePeople: boolean;
  includeRelatedSessions: boolean;
}) {
  return useProjectArtifactMetadata({
    artifacts: visibleProjectArtifacts(model, visibleArtifactIds),
    includePeople,
    includeRelatedSessions,
  });
}

/**
 * The same per-type collaborator, comment and related-session reads over an
 * explicit artifact set. The project board (ISS-12929, 724-F4) reads its cards
 * through this rather than a second copy of the per-type fan-out.
 */
export function useProjectArtifactMetadata({
  artifacts,
  includePeople,
  includeRelatedSessions,
}: {
  artifacts: readonly Pick<Artifact, "id" | "type">[];
  includePeople: boolean;
  includeRelatedSessions: boolean;
}) {
  const idsForType = (type: ArtifactType) =>
    artifacts
      .filter((artifact) => artifact.type === type)
      .map((artifact) => artifact.id);
  const documents = useArtifactCollaborators({
    artifactType: ArtifactType.Document,
    artifactIds: idsForType(ArtifactType.Document),
    enabled: includePeople,
  });
  const branches = useArtifactCollaborators({
    artifactType: ArtifactType.Branch,
    artifactIds: idsForType(ArtifactType.Branch),
    enabled: includePeople,
  });
  const sessions = useArtifactCollaborators({
    artifactType: ArtifactType.Session,
    artifactIds: idsForType(ArtifactType.Session),
    enabled: includePeople,
  });
  const deployments = useArtifactCollaborators({
    artifactType: ArtifactType.Deployment,
    artifactIds: idsForType(ArtifactType.Deployment),
    enabled: includePeople,
  });
  const relatedSessions = useRelatedSessionsPage(
    artifacts
      .filter((artifact) => artifact.type !== ArtifactType.Session)
      .map((artifact) => artifact.id),
    includeRelatedSessions
  );
  const peopleByArtifactId = useMemo(() => {
    const merged = new Map<string, ArtifactCollaboratorEntry>();
    for (const source of [
      documents.data,
      branches.data,
      sessions.data,
      deployments.data,
    ]) {
      for (const [id, entry] of source ?? []) {
        merged.set(id, entry);
      }
    }
    return merged;
  }, [documents.data, branches.data, sessions.data, deployments.data]);
  return {
    peopleByArtifactId,
    peopleReads: { documents, branches, sessions, deployments },
    relatedSessions,
  };
}
