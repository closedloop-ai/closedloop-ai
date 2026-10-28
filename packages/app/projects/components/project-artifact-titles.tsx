import { ArtifactType } from "@repo/api/src/types/artifact";
import type { ComponentProps, ReactNode } from "react";
import {
  EditableArtifactLead,
  GenericArtifactLead,
} from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-cells";
import type { GenericArtifact } from "../../shared/components/generic-artifact-surface/preview/fixtures";
import { useFeatureFlagEnabledOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import { PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY } from "../../shared/lib/feature-flags";
import { ProjectArtifactTitle } from "./project-artifact-title";

type TitleRenderer = (artifact: GenericArtifact, href: string) => ReactNode;

/**
 * The titles Project Detail draws for a board card and for a tree row.
 *
 * A tree row names its artifact by ID as well as by title (ISS-13035); a board
 * card keeps the title alone. The kind icon ahead of a non-document title is
 * part of the portable surface (`projects-portable-surface`, ISS-13007), which
 * this module reads itself.
 */
export function useProjectArtifactTitleRenderers({
  artifactTypeOf,
  onCommit,
  onOpenArtifact,
}: {
  artifactTypeOf: (artifactId: string) => ArtifactType | undefined;
  onCommit: ComponentProps<typeof EditableArtifactLead>["onCommit"];
  onOpenArtifact: (artifact: GenericArtifact) => void;
}): { renderBoardTitle: TitleRenderer; renderTreeTitle: TitleRenderer } {
  const kindIcon = useFeatureFlagEnabledOptional(
    PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY
  );
  const external = (artifact: GenericArtifact) =>
    artifactTypeOf(artifact.id) === ArtifactType.Deployment;
  const isDocument = (artifact: GenericArtifact) =>
    artifactTypeOf(artifact.id) === ArtifactType.Document;
  return {
    renderBoardTitle: (artifact, href) =>
      isDocument(artifact) ? (
        <EditableArtifactLead
          artifact={artifact}
          onCommit={onCommit}
          onOpenArtifact={onOpenArtifact}
          openHref={href}
          showSlug={false}
        />
      ) : (
        <ProjectArtifactTitle
          external={external(artifact)}
          href={href}
          lead={
            kindIcon ? (
              <GenericArtifactLead artifact={artifact} showSlug={false} />
            ) : undefined
          }
          title={artifact.title}
        />
      ),
    renderTreeTitle: (artifact, href) =>
      isDocument(artifact) ? (
        <EditableArtifactLead
          artifact={artifact}
          onCommit={onCommit}
          onOpenArtifact={onOpenArtifact}
          openHref={href}
        />
      ) : (
        <ProjectArtifactTitle
          external={external(artifact)}
          href={href}
          lead={
            kindIcon ? (
              <GenericArtifactLead artifact={artifact} />
            ) : (
              <GenericArtifactLead artifact={artifact} showIcon={false} />
            )
          }
          title={artifact.title}
        />
      ),
  };
}
