import type { ArtifactRepositorySnapshot } from "@repo/api/src/types/document";
import { MetadataSection } from "@repo/design-system/components/ui/metadata-panel";
import { cn } from "@repo/design-system/lib/utils";
import { GitBranch } from "lucide-react";

export type ArtifactRepositoriesSummaryProps = {
  snapshot: ArtifactRepositorySnapshot;
  /**
   * "horizontal" = inline pills for metadata bars; "vertical" = stacked block
   * for sidebar/detail layouts. Default "horizontal".
   */
  layout?: "horizontal" | "vertical";
  /**
   * Vertical-layout only: section title rendered above the repo list.
   */
  title?: string;
  /**
   * Vertical-layout only: whether to render the top-border separator.
   */
  separator?: boolean;
};

/**
 * Read-only summary of the repositories an artifact was created against.
 * The primary repo is ordered first, marked visually, and any branch/ref
 * hints are shown as secondary text.
 */
export function ArtifactRepositoriesSummary({
  snapshot,
  layout = "horizontal",
  title,
  separator = false,
}: Readonly<ArtifactRepositoriesSummaryProps>) {
  const entries = orderedEntries(snapshot);

  if (layout === "horizontal") {
    if (entries.length === 0) {
      return (
        <span className="text-muted-foreground text-sm">No repositories</span>
      );
    }

    return (
      <>
        {entries.map((entry) => (
          <RepoPill entry={entry} key={`${entry.position}-${entry.fullName}`} />
        ))}
      </>
    );
  }

  return (
    <MetadataSection separator={separator}>
      {title ? <h4 className="font-medium text-sm">{title}</h4> : null}
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">No repositories</p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map((entry) => (
            <li
              className="flex items-center gap-2 text-sm"
              key={`${entry.position}-${entry.fullName}`}
            >
              <GitBranch
                aria-hidden="true"
                className="h-3.5 w-3.5 text-muted-foreground"
              />
              <span
                className={cn(
                  entry.role === "primary" ? "font-medium" : undefined
                )}
              >
                {entry.fullName}
              </span>
              {entry.role === "primary" ? (
                <span className="text-muted-foreground text-xs uppercase tracking-wide">
                  Primary
                </span>
              ) : null}
              {entry.branch || entry.ref ? (
                <span className="text-muted-foreground text-xs">
                  {entry.branch ?? entry.ref}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </MetadataSection>
  );
}

function RepoPill({
  entry,
}: Readonly<{ entry: ReturnType<typeof orderedEntries>[number] }>) {
  return (
    <span
      className={cn(
        "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-sm",
        entry.role === "primary"
          ? "bg-muted/50 font-medium"
          : "text-muted-foreground"
      )}
      title={
        entry.role === "primary"
          ? `${entry.fullName} (primary)`
          : entry.fullName
      }
    >
      <GitBranch aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{entry.fullName}</span>
      {entry.branch || entry.ref ? (
        <span className="shrink-0 text-muted-foreground text-xs">
          @{entry.branch ?? entry.ref}
        </span>
      ) : null}
    </span>
  );
}

function orderedEntries(snapshot: ArtifactRepositorySnapshot) {
  return [...snapshot.repositories].sort((a, b) => {
    if (a.role === "primary" && b.role !== "primary") {
      return -1;
    }
    if (b.role === "primary" && a.role !== "primary") {
      return 1;
    }
    return a.position - b.position;
  });
}
