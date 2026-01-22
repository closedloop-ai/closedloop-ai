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
import { useEffect, useState } from "react";
import { getArtifactVersions } from "@/app/actions/artifacts";

// Type definitions (API-first ordering)
type VersionOption = Pick<ArtifactWithWorkstream, "id" | "version">;

type VersionSelectorProps = {
  artifactId: string;
  currentVersion: number;
  compact?: boolean;
};

type VersionsState = {
  versions: VersionOption[];
  isLoading: boolean;
  error: string | null;
};

// Component implementation
export function VersionSelector({
  artifactId,
  currentVersion,
  compact = false,
}: VersionSelectorProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [state, setState] = useState<VersionsState>({
    versions: [],
    isLoading: false,
    error: null,
  });

  // Cache invalidation: reset when currentVersion changes
  // Cache invalidation: reset when currentVersion changes
  useEffect(() => {
    setState({
      versions: [],
      isLoading: false,
      error: null,
    });
  }, [currentVersion, artifactId]); // Reset when version or artifact changes
    setState({
      versions: [],
      isLoading: false,
      error: null,
    });
  }, []);

  // Lazy loading: fetch versions when dropdown opens
  useEffect(() => {
    const loadVersions = async () => {
      setState((prev) => ({ ...prev, isLoading: true, error: null }));

      const result = await getArtifactVersions(artifactId);

      if (result.success) {
        // Sort versions in descending order (newest first)
        const sortedVersions = result.data
          .map((artifact) => ({
            id: artifact.id,
            version: artifact.version,
          }))
          .sort((a, b) => b.version - a.version);

        setState({
          versions: sortedVersions,
          isLoading: false,
          error: null,
        });
      } else {
        setState({
          versions: [],
          isLoading: false,
          error: result.error,
        });
      }
    };

    if (isOpen && state.versions.length === 0 && !state.isLoading) {
      loadVersions();
    }
  }, [artifactId, isOpen, state.isLoading, state.versions.length]);

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
        {state.isLoading ? (
          <div className="flex items-center justify-center py-4">
            <LoaderIcon className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : null}

        {!!state.error && !state.isLoading ? (
          <div className="px-2 py-3 text-muted-foreground text-sm">
            {state.error}
          </div>
        ) : null}

        {!(state.isLoading || state.error) &&
          state.versions.length === 0 &&
          isOpen && (
            <div className="px-2 py-3 text-muted-foreground text-sm">
              No versions found
            </div>
          )}

        {!(state.isLoading || state.error) &&
          state.versions.map((version) => (
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
