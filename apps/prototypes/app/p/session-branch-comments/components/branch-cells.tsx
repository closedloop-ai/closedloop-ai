"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import {
  BotIcon,
  CopyIcon,
  EllipsisVerticalIcon,
  ExternalLinkIcon,
  EyeIcon,
  FolderGit2Icon,
  GitPullRequestIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  BRANCH_STATUS_CONFIG,
  type BranchRow,
  PR_STATE_VARIANT,
  Provenance,
  shortRepoName,
} from "../mock";

const PROVENANCE_LABELS = {
  [Provenance.Agent]: "Agent",
  [Provenance.Bot]: "Bot",
} as const;

/** Agent/Bot origin marker. Human provenance renders nothing. */
export function ProvenanceChip({
  provenance,
}: {
  provenance: Provenance;
}): ReactNode {
  if (provenance !== Provenance.Agent && provenance !== Provenance.Bot) {
    return null;
  }
  return (
    <Chip className="gap-1" variant="muted">
      <BotIcon aria-hidden className="size-3" />
      {PROVENANCE_LABELS[provenance]}
    </Chip>
  );
}

export function BranchStatusChip({ status }: { status: BranchRow["status"] }) {
  const config = BRANCH_STATUS_CONFIG[status];
  return (
    <Chip variant={config.variant}>
      <span className="size-1.5 rounded-full bg-current" />
      {config.label}
    </Chip>
  );
}

export function RepoChip({ repo }: { repo: string }) {
  return (
    <Chip className="min-w-0 gap-1" variant="outline">
      <FolderGit2Icon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{shortRepoName(repo)}</span>
    </Chip>
  );
}

export function OwnerChip({ owner }: { owner: string | null }) {
  if (owner == null) {
    return <GridEmptyValue />;
  }
  return (
    <Chip className="min-w-0 gap-1" variant="outline">
      <UserIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{owner}</span>
    </Chip>
  );
}

export function SessionsChip({ count }: { count: number }) {
  if (count <= 0) {
    return <GridEmptyValue />;
  }
  return (
    <Chip className="gap-1" variant="muted">
      <UsersIcon aria-hidden className="size-3 shrink-0" />
      {count}
    </Chip>
  );
}

/** Additions/deletions proportion bar (mirrors BranchChangesBar). */
export function BranchChangesBar({
  additions,
  deletions,
}: {
  additions: number | null;
  deletions: number | null;
}): ReactNode {
  if (additions == null || deletions == null) {
    return <GridEmptyValue />;
  }
  const total = additions + deletions;
  const additionsPct = total > 0 ? (additions / total) * 100 : 0;
  const deletionsPct = total > 0 ? (deletions / total) * 100 : 0;
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-2 font-mono text-xs tabular-nums">
        <span className="text-success">+{additions}</span>
        <span className="text-destructive">−{deletions}</span>
      </span>
      <span className="flex h-1 w-full overflow-hidden rounded-full bg-muted/50">
        <span className="bg-success" style={{ width: `${additionsPct}%` }} />
        <span
          className="bg-destructive"
          style={{ width: `${deletionsPct}%` }}
        />
      </span>
    </span>
  );
}

/** PR badge chip, lifecycle-colored (mirrors BranchPRBadge). */
export function BranchPRBadge({ item }: { item: BranchRow }): ReactNode {
  if (item.prNumber == null || item.prState == null) {
    return <GridEmptyValue />;
  }
  const variant = PR_STATE_VARIANT[item.prState];
  const label = `${shortRepoName(item.repo)}#${item.prNumber}`;
  return (
    <Chip
      asChild
      className="min-w-0 gap-1"
      interactive
      title={item.prTitle ?? label}
      variant={variant}
    >
      <a href={item.prUrl ?? "#"} rel="noreferrer" target="_blank">
        <GitPullRequestIcon className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </a>
    </Chip>
  );
}

export function ChecksCell({ item }: { item: BranchRow }): ReactNode {
  if (item.checksTotal == null) {
    return <GridEmptyValue />;
  }
  return (
    <span className="text-xs tabular-nums">
      {item.checksPassed ?? 0}/{item.checksTotal} passing
    </span>
  );
}

export function BranchRowActionsMenu({
  item,
  onOpenDetail,
}: {
  item: BranchRow;
  onOpenDetail: (item: BranchRow) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Branch actions"
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <EllipsisVerticalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onOpenDetail(item)}>
          <EyeIcon className="size-3.5" />
          Open detail
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            globalThis.navigator?.clipboard?.writeText(item.branchName);
          }}
        >
          <CopyIcon className="size-3.5" />
          Copy branch name
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={item.prUrl == null}
          onSelect={() => {
            if (item.prUrl) {
              globalThis.open(item.prUrl, "_blank", "noopener,noreferrer");
            }
          }}
        >
          <ExternalLinkIcon className="size-3.5" />
          Open PR
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
