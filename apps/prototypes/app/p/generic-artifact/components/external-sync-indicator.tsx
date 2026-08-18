"use client";

import { cn } from "@repo/design-system/lib/utils";
import {
  ExternalLinkIcon,
  GithubIcon,
  Link2Icon,
  type LucideIcon,
} from "lucide-react";
import type {
  ExternalSyncProvider,
  ExternalSyncRelationship,
} from "./external-sync-contract";

const PROVIDER_ICONS: Record<ExternalSyncProvider, LucideIcon> = {
  github: GithubIcon,
  linear: Link2Icon,
  google: Link2Icon,
  other: Link2Icon,
};

export function ExternalSyncIndicator({
  className,
  relationship,
}: {
  className?: string;
  relationship: ExternalSyncRelationship;
}) {
  const ProviderIcon = PROVIDER_ICONS[relationship.provider];
  let stateLabel = "Synced with";
  if (relationship.state === "syncing") {
    stateLabel = "Syncing with";
  } else if (relationship.state === "error") {
    stateLabel = "Sync issue with";
  }
  const content = (
    <>
      <ProviderIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">
        {stateLabel} {relationship.label}
      </span>
      {relationship.href ? (
        <ExternalLinkIcon aria-hidden className="size-3 shrink-0 opacity-70" />
      ) : null}
    </>
  );
  const sharedClassName = cn(
    "inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground",
    relationship.state === "error" && "text-destructive",
    className
  );

  if (!relationship.href) {
    return <span className={sharedClassName}>{content}</span>;
  }

  return (
    <a
      aria-label={`${stateLabel} ${relationship.label}; open external record`}
      className={cn(
        sharedClassName,
        "rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
      href={relationship.href}
      onClick={(event) => event.stopPropagation()}
      rel="noreferrer"
      target="_blank"
    >
      {content}
    </a>
  );
}
