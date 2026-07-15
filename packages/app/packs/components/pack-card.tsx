"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
} from "@repo/design-system/components/ui/card";
import {
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  ShieldCheckIcon,
  StarIcon,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import type { PackView } from "../lib/pack-view";
import type { PacksContext } from "../lib/packs-context";
import {
  contentSummary,
  formatStars,
  InstallerStack,
  visibleContentKinds,
} from "./pack-meta";

type PackCardProps = {
  pack: PackView;
  context: PacksContext;
  selected?: boolean;
  onSelect: (packId: string) => void;
  /** Local install (desktop). When absent on an install-capable surface, the
   *  card falls back to a GitHub redirect. */
  onInstall?: (packId: string) => void;
};

// The primary card action adapts to the surface: local install on desktop, a
// GitHub redirect on the web (no local filesystem to write to).
const InstallAction = ({
  pack,
  context,
  onInstall,
}: {
  pack: PackView;
  context: PacksContext;
  onInstall?: (packId: string) => void;
}) => {
  if (pack.installedByMe) {
    return (
      <Button className="gap-1.5" disabled size="sm" variant="secondary">
        <CheckIcon className="size-3.5" />
        Installed
      </Button>
    );
  }

  if (context.capabilities.installLocally && onInstall) {
    return (
      <Button
        className="gap-1.5"
        onClick={(event) => {
          event.stopPropagation();
          onInstall(pack.id);
        }}
        size="sm"
      >
        <DownloadIcon className="size-3.5" />
        Install
      </Button>
    );
  }

  if (pack.githubUrl) {
    return (
      <Button asChild className="gap-1.5" size="sm" variant="outline">
        {/* Stop the redirect click from also opening the card detail. */}
        <a
          href={pack.githubUrl}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLinkIcon className="size-3.5" />
          GitHub
        </a>
      </Button>
    );
  }

  return null;
};

export const PackCard = ({
  pack,
  context,
  selected = false,
  onSelect,
  onInstall,
}: PackCardProps) => {
  const open = () => onSelect(pack.id);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };

  const summary = contentSummary(
    pack,
    visibleContentKinds(context.capabilities.showExtendedContentKinds)
  );
  const showInstallers =
    context.capabilities.showTeamUsage &&
    (pack.teamUsage?.installers.length ?? 0) > 0;

  return (
    <Card
      className={`flex cursor-pointer flex-col transition-shadow hover:shadow-md ${
        selected ? "ring-1 ring-primary/40" : ""
      }`}
      data-testid={`pack-card-${pack.id}`}
      onClick={open}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={0}
    >
      <CardHeader className="gap-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate font-semibold text-base">
                {pack.name}
              </span>
              {pack.verified ? (
                <ShieldCheckIcon
                  aria-label="Verified"
                  className="size-3.5 shrink-0 text-primary"
                />
              ) : null}
            </span>
            {pack.publisher ? (
              <span className="block truncate text-muted-foreground text-xs">
                {pack.publisher}
              </span>
            ) : null}
          </div>
          <span className="flex shrink-0 items-center gap-1 text-amber-600 text-sm tabular-nums dark:text-amber-400">
            <StarIcon className="size-3.5 fill-current" />
            {formatStars(pack.stars)}
          </span>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        {pack.description ? (
          <p className="line-clamp-2 text-muted-foreground text-sm">
            {pack.description}
          </p>
        ) : null}

        {summary ? (
          <p className="text-muted-foreground text-xs">{summary}</p>
        ) : null}

        <div className="mt-auto flex items-center justify-between gap-3 border-border border-t pt-3">
          {showInstallers && pack.teamUsage ? (
            <InstallerStack max={3} users={pack.teamUsage.installers} />
          ) : (
            <span />
          )}
          <div className="shrink-0">
            <InstallAction
              context={context}
              onInstall={onInstall}
              pack={pack}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
