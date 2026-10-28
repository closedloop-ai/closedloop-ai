import { BRANCH_NAME_MAX_LENGTH } from "@repo/api/src/types/artifact";
import type { SyncedCommitArtifactRef } from "@repo/api/src/types/session-artifact-link";
import {
  type ArtifactRefRelation,
  ArtifactRefTargetKind,
  COMMIT_SHA_PATTERN,
  MAX_SYNCED_COMMIT_MESSAGE_LENGTH,
} from "@repo/api/src/types/session-artifact-link";
import { validIso } from "./db-helpers.js";
import type { SqliteArtifactLinkRow } from "./db-row-types.js";

/**
 * FEA-2731 / PRD-510 D7: one stored commit link → its wire `commit` artifactRef,
 * or `undefined` when any required field cannot be emitted within its bound.
 * `repositoryFullName` and `relation` are resolved by the caller; a malformed
 * sha or an over-bound branch name omits the whole ref (see `toSyncedCommitSha`).
 * The desktop store holds no commit LOC (ISS-12709), so none is sent.
 */
export function buildCommitArtifactRef(
  link: SqliteArtifactLinkRow,
  repositoryFullName: string,
  relation: ArtifactRefRelation
): SyncedCommitArtifactRef | undefined {
  const sha = toSyncedCommitSha(link.sha);
  if (
    !(link.branch_name && sha) ||
    link.branch_name.length > BRANCH_NAME_MAX_LENGTH
  ) {
    return undefined;
  }
  const committedAt = toSyncedCommitTimestamp(link.artifact_committed_at);
  return {
    kind: ArtifactRefTargetKind.Commit,
    repositoryFullName,
    branchName: link.branch_name,
    sha,
    method: link.method,
    relation,
    ...(link.title
      ? { message: link.title.slice(0, MAX_SYNCED_COMMIT_MESSAGE_LENGTH) }
      : {}),
    ...(committedAt ? { committedAt } : {}),
  };
}

/**
 * Normalize a stored commit timestamp for the wire: emit the trimmed value only
 * when it is a parseable ISO-8601 date, else `undefined`. The cloud's
 * `isoTimestampSchema` rejects unparseable timestamps, and the whole batch is
 * validated in one parse — so a single malformed `committed_at` must be dropped
 * here rather than stall sync for every session in the batch (FEA-2731).
 */
function toSyncedCommitTimestamp(value: string | null): string | undefined {
  return validIso(value?.trim()) ?? undefined;
}

/**
 * Normalize a locally-stored commit sha for the wire: lowercase + trim, emit only
 * when it is 7–40 hex (COMMIT_SHA_PATTERN), else `undefined`. `commit` is a KNOWN
 * ref kind, so the cloud STRICTLY validates the sha (it is the ref's identity and
 * cannot be forward-compat-dropped like an unknown kind) — a malformed local sha
 * would fail the single batch parse and stall sync for every session in the tick.
 * A commit ref with no valid sha is useless, so callers omit the whole ref rather
 * than emit a field-less one (FEA-2731).
 */
function toSyncedCommitSha(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return COMMIT_SHA_PATTERN.test(normalized) ? normalized : undefined;
}
