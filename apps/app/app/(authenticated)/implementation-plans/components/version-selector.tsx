"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { ChevronDownIcon } from "lucide-react";

type VersionSelectorProps = {
  currentVersion: number;
  latestVersion: number;
  onVersionChange: (version: number) => void;
  compact?: boolean;
};

export function VersionSelector({
  currentVersion,
  latestVersion,
  onVersionChange,
  compact = false,
}: VersionSelectorProps) {
  // Generate linear version list: [latestVersion, ..., 2, 1] (newest first)
  const versions = Array.from(
    { length: latestVersion },
    (_, i) => latestVersion - i
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Select version"
          className={compact ? "h-7 px-2 text-xs" : "h-8 px-3 text-sm"}
          variant="ghost"
        >
          <span className="font-mono text-muted-foreground">
            v{currentVersion}
          </span>
          <ChevronDownIcon className="ml-1 h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[160px]">
        {versions.map((version) => (
          <DropdownMenuItem
            className="font-mono"
            disabled={version === currentVersion}
            key={version}
            onClick={() => onVersionChange(version)}
          >
            v{version}
            {version === latestVersion && (
              <span className="ml-auto text-muted-foreground text-xs">
                latest
              </span>
            )}
            {version === currentVersion && version !== latestVersion && (
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
