import { DISPLAYED_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { orderGroupEntries } from "@repo/app/shared/lib/table-grouping";
import type { GridTableV2Group as GridTableGroup } from "@repo/design-system/components/ui/grid-table-v2";
import { genericArtifactRootFacets } from "../../generic-artifact-status";
import { ArtifactKind, type GenericArtifact } from "../fixtures";
import type { ArtifactGroupOrder } from "./artifact-list-model";
import { EDITABLE_OWNERS } from "./artifact-list-owners";

export type ArtifactGroupDefinition = {
  key: string;
  label: string;
};

type ArtifactGroupBucket = {
  items: GenericArtifact[];
  label: string;
};

export function artifactGroupDefinitions(
  fieldId: string,
  representedKinds: readonly ArtifactKind[] = Object.values(ArtifactKind),
  includeUnknown = false,
  ownerArtifacts?: readonly GenericArtifact[]
): ArtifactGroupDefinition[] {
  if (fieldId === "status") {
    const definitions = genericArtifactRootFacets(representedKinds).map(
      (facet) => ({
        key: facet.normalized.root,
        label: artifactStatusLabel(facet),
      })
    );
    return includeUnknown
      ? [
          ...definitions,
          {
            key: DISPLAYED_ARTIFACT_STATUS.Unknown,
            label: artifactStatusLabel({
              normalized: { root: DISPLAYED_ARTIFACT_STATUS.Unknown },
              raw: null,
              vocabulary: ArtifactStatusVocabulary.Issue,
            }),
          },
        ]
      : definitions;
  }
  if (fieldId === "owner") {
    if (ownerArtifacts?.some((artifact) => artifact.ownerId !== undefined)) {
      return [
        ...new Map(
          ownerArtifacts
            .filter((artifact) => artifact.ownerId)
            .map((artifact) => [
              artifact.ownerId,
              { key: artifact.ownerId as string, label: artifact.owner },
            ])
        ).values(),
        { key: ARTIFACT_GROUP_NO_VALUE, label: "Unassigned" },
      ];
    }
    return [
      ...EDITABLE_OWNERS.map((owner) => ({
        key: owner.name,
        label: owner.name,
      })),
      { key: ARTIFACT_GROUP_NO_VALUE, label: "Unassigned" },
    ];
  }
  return [];
}

export function buildArtifactSubgroups({
  artifacts,
  definitions,
  descriptorForArtifact,
  order,
  showEmpty,
}: {
  artifacts: readonly GenericArtifact[];
  definitions: readonly ArtifactGroupDefinition[];
  descriptorForArtifact: (artifact: GenericArtifact) => ArtifactGroupDefinition;
  order: ArtifactGroupOrder;
  showEmpty: boolean;
}): GridTableGroup<GenericArtifact>[] {
  const subgroups = new Map<string, ArtifactGroupBucket>();
  for (const artifact of artifacts) {
    const descriptor = descriptorForArtifact(artifact);
    const current = subgroups.get(descriptor.key);
    subgroups.set(descriptor.key, {
      items: [...(current?.items ?? []), artifact],
      label: descriptor.label,
    });
  }
  if (showEmpty) {
    for (const definition of definitions) {
      if (!subgroups.has(definition.key)) {
        subgroups.set(definition.key, { items: [], label: definition.label });
      }
    }
  }
  return orderGroupEntries(
    [...subgroups.entries()].filter(
      ([, subgroup]) => showEmpty || subgroup.items.length > 0
    ),
    order,
    definitions.map((definition) => definition.key)
  ).map(([key, subgroup]) => ({
    items: subgroup.items,
    key,
    label: subgroup.label,
  }));
}

export const ARTIFACT_GROUP_NO_VALUE = "No value";
