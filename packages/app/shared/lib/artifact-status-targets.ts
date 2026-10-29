import type {
  ArtifactStatusRoot,
  NormalizedArtifactStatus,
} from "@repo/api/src/types/artifact-status";
import {
  isArtifactStatusRoot,
  UNKNOWN_ARTIFACT_STATUS,
} from "@repo/api/src/types/artifact-status";
import type {
  ArtifactStatusRawValue,
  ArtifactStatusVocabulary,
} from "@repo/api/src/types/artifact-status-contract";
import { ArtifactStatusVocabulary as Vocabulary } from "@repo/api/src/types/artifact-status-contract";
import {
  toArtifactStatusFromBranch,
  toArtifactStatusFromDocument,
  toArtifactStatusFromIssue,
  toArtifactStatusFromProject,
  toArtifactStatusFromSession,
} from "@repo/api/src/types/artifact-status-mapping";
import { artifactStatusRootRank } from "@repo/api/src/types/artifact-status-rank";
import { artifactStatusDetailBelongsTo } from "./artifact-status-appearance";

export type ArtifactStatusTarget = Readonly<{
  normalized: NormalizedArtifactStatus;
  target: ArtifactStatusRawValue;
}>;

export type ArtifactStatusTargetGroup = Readonly<{
  root: ArtifactStatusRoot;
  parents: readonly ArtifactStatusTarget[];
  children: readonly ArtifactStatusTarget[];
}>;

const ARTIFACT_STATUS_TARGET_FOLD: Readonly<
  Record<ArtifactStatusVocabulary, (raw: string) => NormalizedArtifactStatus>
> = Object.freeze({
  [Vocabulary.Document]: toArtifactStatusFromDocument,
  [Vocabulary.Issue]: toArtifactStatusFromIssue,
  [Vocabulary.Branch]: toArtifactStatusFromBranch,
  [Vocabulary.Project]: toArtifactStatusFromProject,
  [Vocabulary.Session]: toArtifactStatusFromSession,
});

/** Group only valid raw targets, with selectable roots before their own details. */
export function groupArtifactStatusTargets(
  targets: readonly ArtifactStatusRawValue[],
  vocabulary: ArtifactStatusVocabulary
): ArtifactStatusTargetGroup[] {
  const groups = new Map<
    ArtifactStatusRoot,
    {
      root: ArtifactStatusRoot;
      parents: ArtifactStatusTarget[];
      children: ArtifactStatusTarget[];
    }
  >();
  for (const target of new Set(targets)) {
    const normalized = Object.hasOwn(ARTIFACT_STATUS_TARGET_FOLD, vocabulary)
      ? ARTIFACT_STATUS_TARGET_FOLD[vocabulary](target)
      : UNKNOWN_ARTIFACT_STATUS;
    const { detail, root } = normalized;
    if (
      !isArtifactStatusRoot(root) ||
      (detail != null && !artifactStatusDetailBelongsTo(detail, vocabulary))
    ) {
      continue;
    }
    let group = groups.get(root);
    if (!group) {
      group = { children: [], parents: [], root };
      groups.set(root, group);
    }
    (detail ? group.children : group.parents).push({ normalized, target });
  }
  return [...groups.values()].sort(
    (left, right) =>
      artifactStatusRootRank(left.root) - artifactStatusRootRank(right.root)
  );
}
