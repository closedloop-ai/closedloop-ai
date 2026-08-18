"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Chip } from "@repo/design-system/components/ui/chip";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { cn } from "@repo/design-system/lib/utils";
import { FolderGit2Icon } from "lucide-react";
import type { ReactNode } from "react";
import {
  AUTONOMY_TIER_CONFIG,
  autonomyTier,
  HARNESS_CONFIG,
  MODEL_PROVIDER_CONFIG,
  modelProvider,
  SESSION_STATUS_CONFIG,
  type SessionRow,
  type SessionStatus,
  shortRepoName,
} from "../mock";

export function SessionStatusChip({ status }: { status: SessionStatus }) {
  const config = SESSION_STATUS_CONFIG[status];
  return (
    <Chip variant={config.variant}>
      <span
        className={cn(
          "size-1.5 rounded-full bg-current",
          config.pulse && "animate-pulse"
        )}
      />
      {config.label}
    </Chip>
  );
}

export function HarnessChip({ harness }: { harness: SessionRow["harness"] }) {
  return <Chip variant="outline">{HARNESS_CONFIG[harness].label}</Chip>;
}

/**
 * Autonomy as a Low / Medium / High colored chip (PRD-557 FEA-4206). The raw
 * numeric score stays on the row and is surfaced on the Session Detail page.
 */
export function AutonomyCell({ autonomy }: { autonomy: number | null }) {
  if (autonomy == null) {
    return <GridEmptyValue />;
  }
  const config = AUTONOMY_TIER_CONFIG[autonomyTier(autonomy)];
  return (
    <Chip title={`Autonomy score ${autonomy} of 100`} variant={config.variant}>
      {config.label}
    </Chip>
  );
}

export function RepoChip({ repo }: { repo: string | null }) {
  if (repo == null) {
    return <GridEmptyValue />;
  }
  return (
    <Chip className="min-w-0 gap-1" variant="outline">
      <FolderGit2Icon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{shortRepoName(repo)}</span>
    </Chip>
  );
}

export function OwnerCell({ user }: { user: SessionRow["user"] }) {
  if (!user) {
    return <GridEmptyValue />;
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar className="size-5 shrink-0">
        <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
          {user.initials}
        </AvatarFallback>
      </Avatar>
      <span className="truncate text-sm" title={user.name}>
        {user.name}
      </span>
    </span>
  );
}

/**
 * Model as a neutral outline chip with a small provider-colored dot (PRD-557
 * FEA-4221): the dot separates Anthropic / OpenAI / Google at a glance while
 * Status keeps the semantic traffic-light palette to itself.
 */
export function ModelCell({ model }: { model: string | null }): ReactNode {
  if (!model) {
    return <GridEmptyValue />;
  }
  const config = MODEL_PROVIDER_CONFIG[modelProvider(model)];
  return (
    <Chip
      className="min-w-0 gap-1.5"
      title={`${config.label} · ${model}`}
      variant="outline"
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-current",
          config.dotClass
        )}
      />
      <span className="truncate">{model}</span>
    </Chip>
  );
}

const INITIALS_SPLIT = /[\s-]+/;

export function getInitials(name: string): string {
  const parts = name.split(INITIALS_SPLIT).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
