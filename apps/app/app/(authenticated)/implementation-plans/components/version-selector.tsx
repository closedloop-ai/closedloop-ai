"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { ChevronDownIcon, LoaderIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useArtifactVersions } from "@/hooks/queries/use-artifacts";

// Type definitions (API-first ordering)
type VersionOption = Pick<ArtifactWithWorkstream, "id" | "version">;

type VersionSelectorProps = {
  artifactId: string;
  currentVersion: number;
  compact?: boolean;
};

// Component implementation
export function VersionSelector({
  artifactId,
  currentVersion,
  compact = false,
}: VersionSelectorProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);

  // Fetch versions only when dropdown is open
  const { data: artifactVersions = [], isLoading, error } = useArtifactVersions(artifactId, {
    enabled: isOpen,
  });

  // Sort versions in descending order (newest first)
  const versions: VersionOption[] = useMemo(() => {
    return artifactVersions
      .map((artifact) => ({
        id: artifact.id,
        version: artifact.version,
      }))
      .sort((a, b) => b.version - a.version);
  }, [artifactVersions]);

  const handleVersionSelect = (versionId: string) => {
    router.push(`/implementation-plans/${versionId}`);
    setIsOpen(false);
  };

  const versionText = `v${currentVersion}`;

  return (
    <DropdownMenu onOpenChange={setIsOpen} open={isOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Select version"
          className={compact ? "h-7 px-2 text-xs" : "h-8 px-3 text-sm"}
          variant="ghost"
        >
          <span className="font-mono text-muted-foreground">{versionText}</span>
          <ChevronDownIcon className="ml-1 h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[160px]">
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <LoaderIcon className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : null}

        {!!error && !isLoading ? (
          <div className="px-2 py-3 text-muted-foreground text-sm">{error.message}</div>
        ) : null}

        {!(isLoading || error) && versions.length === 0 && isOpen && (
          <div className="px-2 py-3 text-muted-foreground text-sm">
            No versions found
          </div>
        )}

        {!(isLoading || error) &&
          versions.map((version) => (
            <DropdownMenuItem
              className="font-mono"
              disabled={version.version === currentVersion}
              key={version.id}
              onClick={() => handleVersionSelect(version.id)}
            >
              v{version.version}
              {version.version === currentVersion && (
                <span className="ml-auto text-muted-foreground text-xs">
                  current
                </span>
              )}
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
