"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { AlertTriangleIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { ColorConflict } from "./style-browser-color-conflicts";
import type { TokenDefinition, TokenEdits } from "./style-browser-editor-data";

export function TokenTile({
  token,
  edits,
  selectedToken,
  addedTokenIds,
  removedTokenIds,
  colorConflicts,
  onSelectToken,
  children,
}: TokenTileContext & {
  token: TokenDefinition;
  children: ReactNode;
}) {
  const value = removedTokenIds.has(token.id)
    ? token.initialValue
    : (edits[token.id] ?? token.initialValue);
  const isAdded = addedTokenIds.has(token.id);
  const isRemoved = removedTokenIds.has(token.id);
  const isEdited = edits[token.id] !== undefined && !isAdded;
  const isSelected = selectedToken.id === token.id;
  const colorConflict = colorConflicts.get(token.id);
  return (
    <Button
      className={cn(
        "style-lab-control h-auto min-w-0 justify-start whitespace-normal rounded-sm border bg-card p-2 text-left font-normal transition-colors hover:bg-muted/30",
        isSelected
          ? "border-primary/60 ring-2 ring-primary/15"
          : "border-border",
        isRemoved && "opacity-55"
      )}
      onClick={() => onSelectToken(token)}
      type="button"
      variant="ghost"
    >
      <span className={cn("block", isRemoved && "grayscale")}>{children}</span>
      <span className="mt-2 flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span
            className={cn(
              "block truncate font-medium text-xs",
              isRemoved && "line-through"
            )}
          >
            {token.label}
          </span>
          <span className="block truncate text-muted-foreground text-xs">
            --{token.cssName}
          </span>
          <span className="mt-1 block truncate text-muted-foreground text-xs">
            {value}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          {isAdded ? <Badge variant="success">Added</Badge> : null}
          {isRemoved ? <Badge variant="destructive">Removed</Badge> : null}
          {isEdited ? <Badge variant="info">Edited</Badge> : null}
          {colorConflict && !isRemoved ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  aria-label={`Visual overlap with --${colorConflict.nearestToken.cssName}`}
                  variant="warning"
                >
                  <AlertTriangleIcon />
                  Close
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="left">
                Visual overlap with --{colorConflict.nearestToken.cssName}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </span>
      </span>
    </Button>
  );
}

export type TokenTileContext = {
  edits: TokenEdits;
  selectedToken: TokenDefinition;
  addedTokenIds: ReadonlySet<string>;
  removedTokenIds: ReadonlySet<string>;
  colorConflicts: ReadonlyMap<string, ColorConflict>;
  onSelectToken: (token: TokenDefinition) => void;
};
