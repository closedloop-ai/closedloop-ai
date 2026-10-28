import {
  GenericArtifactStatus,
  genericArtifactStatusFromRaw,
} from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import {
  ArtifactKind,
  type GenericArtifact,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { type BranchRow, shortRepoName } from "./mock";
import { buildBranchDetail } from "./mock-detail";

const REFERENCE_NOW = Date.parse("2026-07-28T19:00:00Z");
const BRANCH_ID_PREFIX_PATTERN = /^br_/;
const PERSON_NAME_PARTS_PATTERN = /\s+/;

export function branchSlug(row: BranchRow): string {
  if (row.prNumber) {
    return `BR-${row.prNumber}`;
  }
  return `BR-${row.id.replace(BRANCH_ID_PREFIX_PATTERN, "").replaceAll("_", "-").toUpperCase()}`;
}

export function branchHeadSha(row: BranchRow): string {
  let hash = 17;
  for (const character of `${row.id}:${row.branchName}`) {
    hash = (hash * 31 + character.charCodeAt(0)) % 0xf_ff_ff_ff;
  }
  return hash.toString(16).padStart(7, "0").slice(0, 7);
}

/** The shared artifact revision is an integer; the commit SHA remains branch metadata. */
export function branchVersion(row: BranchRow): string {
  return String(Math.max(1, row.sessionCount));
}

export function branchToGenericArtifact(row: BranchRow): GenericArtifact {
  const detail = buildBranchDetail(row);
  const updatedAgoMinutes = Math.max(
    0,
    Math.round((REFERENCE_NOW - Date.parse(row.lastActivityAt)) / 60_000)
  );
  const spend = Number.parseFloat(detail.costLabel.replace(/[$,]/g, "")) || 0;
  const status =
    genericArtifactStatusFromRaw(ArtifactKind.Branch, row.status) ??
    GenericArtifactStatus.Canceled;

  return {
    activityCount: (row.additions ?? 0) + (row.deletions ?? 0),
    aiSpend: spend,
    collaborators: row.collaborators,
    commentCount: row.commentCount ?? 0,
    createdAgoDays: Math.max(1, Math.ceil(updatedAgoMinutes / 1440) + 2),
    currentVersion: branchVersion(row),
    id: row.id,
    kind: ArtifactKind.Branch,
    outcomeScore: 78,
    owner: row.owner ?? "Unattributed",
    ownerInitials: initials(row.owner ?? "Unattributed"),
    project: shortRepoName(row.repo),
    relationshipCount:
      row.sessionCount + row.collaborators.length + (row.prNumber ? 1 : 0),
    repository: row.repo,
    slug: branchSlug(row),
    status,
    statusRaw: row.status,
    summary:
      row.prTitle ??
      `Working branch based on ${row.baseBranch} in ${row.repo}.`,
    tags: row.tags,
    timeToReadyMinutes: Math.max(1, Math.round(detail.idlePct * 1.4)),
    title: row.branchName,
    updated: row.lastActivityLabel,
    updatedAgoMinutes,
  };
}

function initials(name: string): string {
  return name
    .split(PERSON_NAME_PARTS_PATTERN)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
