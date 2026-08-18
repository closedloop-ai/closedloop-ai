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
  ShieldCheckIcon,
  StarIcon,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { type Pack, visibilityFor } from "../mock";
import {
  contentSummary,
  formatStars,
  InstallerStack,
  VisibilityBadge,
} from "./pack-meta";

type PackCardProps = {
  pack: Pack;
  onSelect: (pack: Pack) => void;
};

// Opening the pack's GitHub page is how the web surface "installs" — there is
// no local filesystem to write to, so the primary action is a redirect.
const InstallAction = ({ pack }: { pack: Pack }) => {
  if (pack.installedByMe) {
    return (
      <Button className="gap-1.5" disabled size="sm" variant="secondary">
        <CheckIcon className="size-3.5" />
        Installed
      </Button>
    );
  }
  return (
    <Button asChild className="gap-1.5" size="sm">
      {/* Stop the redirect click from also opening the card's detail dialog. */}
      <a
        href={pack.githubUrl}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        rel="noreferrer"
        target="_blank"
      >
        <DownloadIcon className="size-3.5" />
        Install
      </a>
    </Button>
  );
};

export const PackCard = ({ pack, onSelect }: PackCardProps) => {
  const open = () => onSelect(pack);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };

  return (
    <Card
      className="flex cursor-pointer flex-col transition-shadow hover:shadow-md"
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
            <span className="block truncate text-muted-foreground text-xs">
              {pack.publisher}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <VisibilityBadge visibility={visibilityFor(pack)} />
            <span className="flex items-center gap-1 text-amber-600 text-sm tabular-nums dark:text-amber-400">
              <StarIcon className="size-3.5 fill-current" />
              {formatStars(pack.stars)}
            </span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        <p className="line-clamp-2 text-muted-foreground text-sm">
          {pack.description}
        </p>

        <p className="text-muted-foreground text-xs">{contentSummary(pack)}</p>

        <div className="mt-auto flex items-center justify-between gap-3 border-border border-t pt-3">
          <InstallerStack max={3} users={pack.installers} />
          <div className="shrink-0">
            <InstallAction pack={pack} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
