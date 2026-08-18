"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
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
  TrendingUpIcon,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import type { PackView } from "../lib/pack-view";
import type { PacksContext } from "../lib/packs-context";
import { contentSummary, formatStars, InstallerStack } from "./pack-meta";

type PackCardProps = {
  pack: PackView;
  context: PacksContext;
  selected?: boolean;
  onSelect: (packId: string) => void;
  /** Local install (desktop). When absent on an install-capable surface, the
   *  card falls back to a GitHub redirect. */
  onInstall?: (packId: string) => void;
  /** Secondary qualifier (kind / version / id) shown under the name when this
   *  pack shares its display name with another in the catalog (FEA-3972). */
  disambiguator?: string;
  /** Whether this pack stands out as trending relative to the catalog — the
   *  workspace decides this once over the full set (`trendingPackIds`) so the
   *  marker is selective, not per-card-always-on (FEA-3236). */
  trending?: boolean;
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
  disambiguator,
  trending = false,
}: PackCardProps) => {
  const open = () => onSelect(pack.id);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };

  const summary = contentSummary(pack);
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
            {disambiguator || pack.publisher || trending ? (
              <span className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
                {/* The qualifier is the signal — lead with it and keep it whole,
                 *  so a long publisher or a narrow card never drops the one bit
                 *  that tells same-named cards apart (FEA-3972). */}
                {disambiguator ? (
                  <span className="shrink-0 font-medium text-foreground/70">
                    {disambiguator}
                  </span>
                ) : null}
                {disambiguator && pack.publisher ? (
                  <span aria-hidden="true" className="shrink-0">
                    ·
                  </span>
                ) : null}
                {pack.publisher ? (
                  <span className="truncate">{pack.publisher}</span>
                ) : null}
                {/* Trending lives on the meta row, not the name row: the name is
                 *  truncate and the badge is shrink-0, so badging it there would
                 *  eat characters off the one thing a grid is scanned for. It's
                 *  a muted pill so trust (the Verified shield) still outranks
                 *  momentum in the header (FEA-3236). */}
                {trending ? (
                  <Badge
                    aria-label="Trending"
                    className="ms-auto"
                    variant="muted"
                  >
                    <TrendingUpIcon aria-hidden="true" />
                    Trending
                  </Badge>
                ) : null}
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
