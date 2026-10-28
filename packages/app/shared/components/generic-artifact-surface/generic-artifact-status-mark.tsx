"use client";

import {
  ArtifactStatusEditSurface,
  type ArtifactStatusEditSurface as ArtifactStatusEditSurfaceType,
} from "@repo/api/src/types/artifact-status-contract";
import { ArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import {
  type ArtifactStatusRowVariant,
  ArtifactStatusVariant,
} from "@repo/app/shared/lib/artifact-status-view-contract";
import type { GenericArtifactStatusSource } from "./generic-artifact-status";
import {
  genericArtifactStatusCapability,
  genericArtifactStatusFacet,
  genericArtifactStatusFromRaw,
} from "./generic-artifact-status";

type StatusSourceWithId = GenericArtifactStatusSource &
  Readonly<{ id: string }>;

/** Canonical read-only status treatment for a Generic Artifact fixture row. */
export function GenericArtifactStatusMark({
  artifact,
  variant = ArtifactStatusVariant.CompactCell,
}: Readonly<{
  artifact: StatusSourceWithId;
  variant?: ArtifactStatusRowVariant;
}>) {
  return (
    <ArtifactStatus
      variant={variant}
      view={{
        ...genericArtifactStatusFacet(artifact),
        artifactId: artifact.id,
      }}
    />
  );
}

/** Canonical editor that translates raw commit targets back to preview aliases. */
export function GenericArtifactStatusEditor({
  ariaLabel,
  artifact,
  onChange,
  surface = ArtifactStatusEditSurface.InlineCell,
  triggerVariant,
}: Readonly<{
  ariaLabel?: string;
  artifact: StatusSourceWithId;
  onChange: (status: StatusSourceWithId["status"]) => void;
  surface?: Exclude<
    ArtifactStatusEditSurfaceType,
    | typeof ArtifactStatusEditSurface.Board
    | typeof ArtifactStatusEditSurface.Bulk
  >;
  triggerVariant?: typeof ArtifactStatusVariant.Icon;
}>) {
  return (
    <ArtifactStatus
      ariaLabel={ariaLabel}
      capability={genericArtifactStatusCapability(artifact)}
      onCommit={(commit) => {
        const status = genericArtifactStatusFromRaw(artifact.kind, commit.to);
        if (status !== null) {
          onChange(status);
        }
      }}
      surface={surface}
      triggerVariant={triggerVariant}
      variant={ArtifactStatusVariant.Editor}
      view={{
        ...genericArtifactStatusFacet(artifact),
        artifactId: artifact.id,
      }}
    />
  );
}
