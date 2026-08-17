"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Chip } from "@repo/design-system/components/ui/chip";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { BotIcon, FolderIcon, GitBranchIcon, TicketIcon } from "lucide-react";
import type { ReactNode } from "react";
import { formatAgo, type SessionRow } from "../mock";

// How many overlapping avatars to render before collapsing the rest into a
// "+N" chip, so a busy session never blows out the Collaborators column.
const MAX_VISIBLE_AVATARS = 3;

/** Collaborators as an overlapping avatar stack (PRD-557 FEA-4208). */
export function CollaboratorsCell({
  collaborators,
}: {
  collaborators: SessionRow["collaborators"];
}): ReactNode {
  if (collaborators.length === 0) {
    return <GridEmptyValue />;
  }
  const visible = collaborators.slice(0, MAX_VISIBLE_AVATARS);
  const overflow = collaborators.length - visible.length;
  return (
    <span className="flex min-w-0 items-center">
      <span className="flex items-center -space-x-1.5">
        {visible.map((person) => (
          <Avatar
            className="size-5 ring-2 ring-background"
            key={person.name}
            title={person.name}
          >
            <AvatarFallback className="bg-muted text-[10px] text-muted-foreground">
              {person.initials}
            </AvatarFallback>
          </Avatar>
        ))}
      </span>
      {overflow > 0 ? (
        <span className="ml-1.5 text-muted-foreground text-xs tabular-nums">
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

/** Projects the session contributes to, as chips (PRD-557 FEA-4209). */
export function ProjectsCell({
  projects,
}: {
  projects: SessionRow["projects"];
}): ReactNode {
  if (projects.length === 0) {
    return <GridEmptyValue />;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {projects.map((project) => (
        <Chip className="min-w-0 gap-1" key={project} variant="muted">
          <FolderIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{project}</span>
        </Chip>
      ))}
    </span>
  );
}

/** Linked issues as deep-linked slug chips (PRD-557 FEA-4210). */
export function LinkedIssuesCell({
  issues,
}: {
  issues: SessionRow["linkedIssues"];
}): ReactNode {
  if (issues.length === 0) {
    return <GridEmptyValue />;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {issues.map((issue) => (
        <Chip
          asChild
          className="min-w-0 gap-1"
          interactive
          key={issue.slug}
          title={issue.title}
          variant="outline"
        >
          <a href={issue.url} rel="noreferrer" target="_blank">
            <TicketIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{issue.slug}</span>
          </a>
        </Chip>
      ))}
    </span>
  );
}

/** Linked agents / components as chips (PRD-557 FEA-4212). */
export function LinkedAgentsCell({
  agents,
}: {
  agents: SessionRow["linkedAgents"];
}): ReactNode {
  if (agents.length === 0) {
    return <GridEmptyValue />;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {agents.map((agent) => (
        <Chip className="min-w-0 gap-1" key={agent.name} variant="muted">
          <BotIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{agent.name}</span>
        </Chip>
      ))}
    </span>
  );
}

/** Session tags as quiet muted chips (PRD-557 FEA-4213). */
export function TagsCell({ tags }: { tags: SessionRow["tags"] }): ReactNode {
  if (tags.length === 0) {
    return <GridEmptyValue />;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <Chip className="min-w-0" key={tag.label} variant="muted">
          <span className="truncate">{tag.label}</span>
        </Chip>
      ))}
    </span>
  );
}

/**
 * The consolidated "Linked branches" column (PRD-557 FEA-4211): a single
 * primary-branch chip that truncates on overflow, with a "+N" count when the
 * session has more than one branch. The chip links to the PR when there is one
 * and carries the merge status in its tooltip, so the cell stays one line
 * instead of wrapping a branch + PR + merge stack.
 */
export function LinkedBranchesCell({ item }: { item: SessionRow }): ReactNode {
  const branches = [item.branch, ...(item.extraBranches ?? [])].filter(
    (branch): branch is string => branch != null
  );
  if (branches.length === 0) {
    return <GridEmptyValue />;
  }
  const [primary, ...rest] = branches;
  const tooltip = item.mergeStatusLabel
    ? `${primary} · ${item.mergeStatusLabel}`
    : primary;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {item.prUrl == null ? (
        <Chip className="min-w-0 gap-1" title={tooltip} variant="outline">
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{primary}</span>
        </Chip>
      ) : (
        <Chip
          asChild
          className="min-w-0 gap-1"
          interactive
          title={tooltip}
          variant="outline"
        >
          <a href={item.prUrl} rel="noreferrer" target="_blank">
            <GitBranchIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{primary}</span>
          </a>
        </Chip>
      )}
      {rest.length > 0 ? (
        <Chip className="shrink-0" title={rest.join(", ")} variant="muted">
          +{rest.length}
        </Chip>
      ) : null}
    </span>
  );
}

/** "Updated" activity timestamp from Claude Code (PRD-557 FEA-4214). */
export function UpdatedCell({ minutes }: { minutes: number }): ReactNode {
  return (
    <span className="text-muted-foreground text-xs">{formatAgo(minutes)}</span>
  );
}
