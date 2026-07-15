"use client";

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@closedloop-ai/design-system/components/ui/tooltip";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { StarIcon } from "lucide-react";

type FavoriteButtonProps = {
  isFavorite: boolean;
  isPending?: boolean;
  size?: "sm" | "default";
  onToggle?: (nextIsFavorite: boolean) => void;
  addLabel?: string;
  removeLabel?: string;
};

export function FavoriteButton({
  isFavorite,
  isPending = false,
  size = "sm",
  onToggle,
  addLabel = "Add to favorites",
  removeLabel = "Remove from favorites",
}: FavoriteButtonProps) {
  const label = isFavorite ? removeLabel : addLabel;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          disabled={isPending}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggle?.(!isFavorite);
          }}
          size={size === "sm" ? "icon-sm" : "icon"}
          variant="ghost"
        >
          <StarIcon
            className={cn(
              "h-4 w-4",
              isFavorite && "fill-yellow-400 text-yellow-400"
            )}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
