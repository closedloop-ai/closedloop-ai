import type { JsonObject } from "@repo/api/src/types/common";
import {
  type ArtifactRepositoryEntry,
  type ArtifactRepositorySnapshot,
  artifactRepositorySnapshotSchema,
  RepositoryRole,
  type RepositorySelectionInput,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { log } from "@repo/observability/log";
import { loadProjectRepoDefaults } from "@/app/projects/repository-resolver";

/**
 * Helpers for populating the per-document `repository_snapshot` JSON column
 * introduced in PLN-602. The snapshot is server-owned, immutable post-create,
 * and produced from one of: project defaults, an explicit Loop selection, or
 * an inherited parent-artifact snapshot.
 */

function emptySnapshot(): ArtifactRepositorySnapshot {
  return {
    repositories: [],
    source: SnapshotSource.None,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build a snapshot from a project's resolved repo defaults. Used as the
 * fallback when no explicit snapshot is provided to `createDocumentRecord`.
 *
 * Returns:
 *   - A `project_defaults` snapshot when `loadProjectRepoDefaults` returns a
 *     primary. The snapshot contains every selected repo in the override,
 *     with `primaryRepoId` marked as `role: 'primary'` and the rest as
 *     `role: 'additional'`. Branch/ref are omitted — projects don't pin
 *     branches (PLN-237 Q-002).
 *   - An empty `none` snapshot when the project has no resolved defaults
 *     (multi-team project with no override and no legacy fallback).
 */
export async function buildSnapshotFromProjectDefaults(
  projectId: string,
  organizationId: string,
  projectSettings: JsonObject
): Promise<ArtifactRepositorySnapshot> {
  const defaults = await loadProjectRepoDefaults({
    projectId,
    organizationId,
    projectSettings,
  });

  if (!defaults) {
    return emptySnapshot();
  }

  const { override, primary, teamRepos } = defaults;
  const fullNameByRepoId = new Map(
    teamRepos.map((r) => [r.installationRepositoryId, r.repository.fullName])
  );
  fullNameByRepoId.set(override.primaryRepoId, primary.fullName);

  // Resolve full names first, dropping ids that aren't in the team pool, then
  // assign contiguous positions. Positions reflect storage order — gaps would
  // be confusing for downstream consumers that sort or display the list.
  const additionalFullNames = override.selectedRepoIds
    .filter((id) => id !== override.primaryRepoId)
    .map((id) => fullNameByRepoId.get(id))
    .filter((fullName): fullName is string => Boolean(fullName));

  const repositories: ArtifactRepositoryEntry[] = [
    {
      fullName: primary.fullName,
      role: RepositoryRole.Primary,
      position: 0,
    },
    ...additionalFullNames.map<ArtifactRepositoryEntry>((fullName, index) => ({
      fullName,
      role: RepositoryRole.Additional,
      position: index + 1,
    })),
  ];

  return {
    repositories,
    source: SnapshotSource.ProjectDefaults,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build a snapshot from a Loop-style repo selection (primary + additional).
 * Used by both Loop-completion callers and the create-document path, which
 * forward the user's modal-time `repositorySelection`.
 */
export function buildSnapshotFromLoopSelection(
  input: RepositorySelectionInput
): ArtifactRepositorySnapshot {
  const repositories: ArtifactRepositoryEntry[] = [
    {
      fullName: input.primary.fullName,
      role: RepositoryRole.Primary,
      position: 0,
      ...(input.primary.branch ? { branch: input.primary.branch } : {}),
    },
    ...(input.additional ?? []).map<ArtifactRepositoryEntry>((repo, index) => ({
      fullName: repo.fullName,
      role: RepositoryRole.Additional,
      position: index + 1,
      ...(repo.branch ? { branch: repo.branch } : {}),
    })),
  ];

  return {
    repositories,
    source: SnapshotSource.LoopSelection,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Rewrite an existing snapshot's `source` to `parent_artifact`. Used by the
 * derived-artifact inheritance path (T-2.4) so that a Plan inherited from a
 * PRD records the inheritance step in its provenance.
 */
export function inheritSnapshotFromParent(
  parentSnapshot: ArtifactRepositorySnapshot
): ArtifactRepositorySnapshot {
  return {
    repositories: parentSnapshot.repositories,
    source: SnapshotSource.ParentArtifact,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Parse a stored JSON value into an `ArtifactRepositorySnapshot`. Returns null
 * (and logs) when the value does not match the schema — callers decide how to
 * surface the failure. Post-backfill (PLN-602 Migration A) every row matches;
 * a null return indicates corruption.
 */
export function parseStoredSnapshot(
  value: unknown
): ArtifactRepositorySnapshot | null {
  const parsed = artifactRepositorySnapshotSchema.safeParse(value);
  if (!parsed.success) {
    log.warn("Failed to parse stored repository_snapshot", {
      issues: parsed.error.issues,
    });
    return null;
  }
  return parsed.data;
}
