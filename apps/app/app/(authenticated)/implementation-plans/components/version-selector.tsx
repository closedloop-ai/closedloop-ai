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
}: Readonly<VersionSelectorProps>) {
  // Only one version exists — show disabled indicator
  if (latestVersion <= 1) {
    return (
      <Button
        aria-label="Version"
        className={compact ? "h-7 px-2 text-xs" : "h-8 px-3 text-sm"}
        disabled
        variant="outline"
      >
        <span className="font-mono text-muted-foreground">v1</span>
      </Button>
    );
  }

  // DB versions from latestVersion down to 1
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
          variant="outline"
        >
          <span className="font-mono text-muted-foreground">
            v{currentVersion}
          </span>
          <ChevronDownIcon className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[160px]">
        {versions.map((dbVersion) => (
          <DropdownMenuItem
            className="font-mono"
            key={dbVersion}
            onClick={() => onVersionChange(dbVersion)}
          >
            v{dbVersion}
            {dbVersion === latestVersion && (
              <span className="ml-auto text-muted-foreground text-xs">
                latest
              </span>
            )}
            {dbVersion === currentVersion && dbVersion !== latestVersion && (
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
