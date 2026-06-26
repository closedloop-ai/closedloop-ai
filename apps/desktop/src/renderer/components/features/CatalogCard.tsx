import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Download, ExternalLink, GitFork, Star, Trash2 } from "lucide-react";
import type { CatalogEntry } from "../../../shared/agent-db-contract";
import { cx, DashboardCard } from "../layout/page-shell";
import { Sparkline } from "./Sparkline";

export type CatalogCardProps = {
  entry: CatalogEntry;
  onInstall: (packId: string, harness: string) => void;
  onUninstall: (packId: string, harness: string) => void;
  onClick: (packId: string) => void;
  installing?: Record<string, boolean>;
};

export function CatalogCard({
  entry,
  onInstall,
  onUninstall,
  onClick,
  installing,
}: CatalogCardProps) {
  const harnesses = catalogHarnesses(entry);
  const installedHarnesses = catalogInstalledHarnesses(entry);
  const isInstalled = installedHarnesses.length > 0;
  const starHistory = catalogStarHistory(entry);
  const openDetails = () => onClick(entry.packId);

  return (
    <DashboardCard
      className={cx(
        "cursor-pointer transition-shadow hover:shadow-md",
        isInstalled && "border-[var(--primary)]/30"
      )}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a real button would contain the GitHub link below, which is invalid interactive nesting. */}
      <div
        className="space-y-3"
        onClick={openDetails}
        onKeyDown={(event) => {
          if (event.currentTarget !== event.target) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openDetails();
          }
        }}
        role="button"
        tabIndex={0}
      >
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-semibold text-sm">
              {entry.displayName}
            </h3>
            {entry.category && (
              <span className="text-[var(--muted-foreground)] text-xs">
                {entry.category}
              </span>
            )}
          </div>
          {isInstalled ? (
            <Badge className="shrink-0 text-[10px]" variant="default">
              Installed
            </Badge>
          ) : (
            <Badge className="shrink-0 text-[10px]" variant="outline">
              Available
            </Badge>
          )}
        </div>

        {/* Description */}
        {entry.description && (
          <p className="line-clamp-2 text-[var(--muted-foreground)] text-xs">
            {entry.description}
          </p>
        )}

        {/* Stats row */}
        <div className="flex items-center gap-4 text-[var(--muted-foreground)] text-xs">
          {entry.stars != null && (
            <span className="flex items-center gap-1">
              <Star className="h-3 w-3" />
              {formatCount(entry.stars)}
            </span>
          )}
          {entry.forks != null && (
            <span className="flex items-center gap-1">
              <GitFork className="h-3 w-3" />
              {formatCount(entry.forks)}
            </span>
          )}
          {starHistory.length >= 2 && <Sparkline data={starHistory} />}
          {entry.githubUrl && (
            <a
              className="ml-auto hover:text-[var(--foreground)]"
              href={entry.githubUrl}
              onClick={(e) => e.stopPropagation()}
              rel="noreferrer"
              target="_blank"
              title="View on GitHub"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

        {/* Harness badges */}
        <div className="flex flex-wrap gap-1">
          {harnesses.map((h) => (
            <Badge className="text-[10px]" key={h} variant="outline">
              {h}
            </Badge>
          ))}
        </div>
      </div>

      {/* Per-harness install/uninstall buttons */}
      <div className="mt-3 flex flex-wrap gap-2 border-[var(--border)] border-t pt-3">
        {harnesses.map((harness) => {
          const installed = installedHarnesses.includes(harness);
          const busy = installing?.[`${entry.packId}:${harness}`] ?? false;

          return installed ? (
            <Button
              className="h-7 gap-1 text-xs"
              disabled={busy}
              key={harness}
              onClick={() => onUninstall(entry.packId, harness)}
              size="sm"
              variant="outline"
            >
              <Trash2 className="h-3 w-3" />
              {busy ? "..." : `Uninstall (${harness})`}
            </Button>
          ) : (
            <Button
              className="h-7 gap-1 text-xs"
              disabled={busy || !!entry.placeholderReason}
              key={harness}
              onClick={() => onInstall(entry.packId, harness)}
              size="sm"
              title={entry.placeholderReason ?? undefined}
              variant="default"
            >
              <Download className="h-3 w-3" />
              {busy ? "..." : `Install (${harness})`}
            </Button>
          );
        })}
      </div>
    </DashboardCard>
  );
}

function catalogHarnesses(entry: CatalogEntry): string[] {
  return Array.isArray(entry.harnesses) ? entry.harnesses : [];
}

function catalogInstalledHarnesses(entry: CatalogEntry): string[] {
  return Array.isArray(entry.installedHarnesses)
    ? entry.installedHarnesses
    : [];
}

function catalogStarHistory(entry: CatalogEntry): number[] {
  return Array.isArray(entry.history) ? entry.history.map((h) => h.stars) : [];
}

function formatCount(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}
