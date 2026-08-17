"use client";

import {
  ArtifactKind,
  type ArtifactSessionTrace,
  type GenericArtifact,
} from "../mock";
import { ResponsiveReferenceList } from "./artifact-list-custom-cells";
import {
  type ArtifactListColumnExtension,
  relatedSessionOptions,
} from "./artifact-list-model";

export function buildRelatedSessionsColumn(
  relatedSessionsForArtifact: (
    artifact: GenericArtifact
  ) => ArtifactSessionTrace,
  onOpenArtifactHref?: (artifact: GenericArtifact) => string | undefined
): ArtifactListColumnExtension {
  return {
    filterable: true,
    filterValues: (artifact) =>
      artifact.kind === ArtifactKind.Session
        ? []
        : relatedSessionOptions(
            artifact,
            relatedSessionsForArtifact(artifact)
          ).map((session) => session.slug),
    id: "relatedSessions",
    label: "Related Sessions",
    renderCell: (artifact) => {
      if (artifact.kind === ArtifactKind.Session) {
        return <span className="text-muted-foreground">—</span>;
      }
      const options = relatedSessionOptions(
        artifact,
        relatedSessionsForArtifact(artifact)
      );
      return (
        <ResponsiveReferenceList
          hrefForValue={(value) => {
            const option = options.find((candidate) => candidate.id === value);
            const artifactHref = onOpenArtifactHref?.(artifact);
            if (!artifactHref) {
              return undefined;
            }
            const url = new URL(artifactHref, "http://prototype.local");
            url.searchParams.set("tab", "sessions");
            if (option?.lastInteractionTraceRow == null) {
              url.searchParams.delete("traceRow");
            } else {
              url.searchParams.set(
                "traceRow",
                String(option.lastInteractionTraceRow)
              );
            }
            return `${url.pathname}${url.search}${url.hash}`;
          }}
          options={options}
          values={options.map((option) => option.id)}
        />
      );
    },
    tooltip:
      "Read-only sessions that wrote to this artifact or commented on it. Select a session to open its latest interaction in the Sessions trace.",
    width: "220px",
  };
}
