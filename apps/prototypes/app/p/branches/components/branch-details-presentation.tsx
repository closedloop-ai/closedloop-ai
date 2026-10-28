import {
  branchHeadSha,
  branchVersion,
} from "@repo/app/branches/components/prototype-preview/generic-adapter";
import type {
  BranchDetail,
  BranchRow,
} from "@repo/app/branches/components/prototype-preview/mock";
import type { ArtifactDetailsPresentation } from "@repo/app/shared/components/generic-artifact-surface/preview/components/generic-artifact-detail-shell";
import { Chip } from "@repo/design-system/components/ui/chip";
import { FileTextIcon, GitPullRequestIcon, Link2Icon } from "lucide-react";

const VERSION_PREFIX_PATTERN = /^v/;

/** Branch-only data added to the shared generic Details surface. */
export function buildBranchDetailsPresentation(
  detail: BranchDetail,
  row: BranchRow
): ArtifactDetailsPresentation {
  const currentSha = branchHeadSha(row);
  const currentVersion = branchVersion(row);
  return {
    additionalRows: [
      {
        editableValue: row.baseBranch,
        id: "base-branch",
        label: "Base branch",
        value: row.baseBranch,
      },
      {
        id: "pull-request",
        label: "Pull request",
        value: row.prNumber ? (
          <span className="inline-flex items-center gap-2">
            <GitPullRequestIcon className="size-4 text-muted-foreground" />#
            {row.prNumber} {row.prTitle}
          </span>
        ) : (
          <span className="text-muted-foreground">No pull request</span>
        ),
      },
    ],
    linkedArtifacts: [
      ...(row.prNumber
        ? [
            {
              icon: GitPullRequestIcon,
              name: row.prTitle ?? "Untitled pull request",
              relationship: "Reviews",
              slug: `PR-${row.prNumber}`,
              type: "Pull request",
            },
          ]
        : []),
      ...detail.deliveredArtifacts.map((artifact) => ({
        icon: FileTextIcon,
        name: artifact.slug,
        relationship: "Delivered by",
        slug: artifact.slug,
        type: "Artifact",
      })),
      ...detail.sessions.slice(0, 3).map((session) => ({
        icon: Link2Icon,
        name: `${session.actor} · ${session.sub}`,
        relationship: "Contributed to",
        slug: session.id,
        type: "Session",
      })),
    ],
    versions: [
      {
        author: row.owner ?? "Unattributed",
        id: currentVersion,
        state: "Current",
        updated: row.lastActivityLabel,
      },
      {
        author: row.owner ?? "Unattributed",
        id: previousVersion(currentVersion, 1),
        state: "Published",
        updated: "earlier",
      },
      {
        author: row.owner ?? "Unattributed",
        id: previousVersion(currentVersion, 2),
        state: "Published",
        updated: "first push",
      },
    ],
    activity: [
      {
        actor: row.owner ?? "A contributor",
        body: <>pushed {currentSha}</>,
        date: row.lastActivityLabel,
        id: "head-pushed",
        kind: "event",
      },
      ...(row.prNumber
        ? [
            {
              actor: row.owner ?? "A contributor",
              body: <>updated pull request #{row.prNumber}</>,
              date: "previously",
              id: "pull-request-updated",
              kind: "event" as const,
            },
          ]
        : []),
      {
        actor: row.owner ?? "A contributor",
        body: (
          <>
            linked{" "}
            <Chip variant="muted">{detail.sessions.length} sessions</Chip>
          </>
        ),
        date: "previously",
        id: "sessions-linked",
        kind: "event",
      },
    ],
  };
}

function previousVersion(version: string, decrement: number): string {
  const numericVersion = Number(version.replace(VERSION_PREFIX_PATTERN, ""));
  return String(Math.max(1, numericVersion - decrement));
}
