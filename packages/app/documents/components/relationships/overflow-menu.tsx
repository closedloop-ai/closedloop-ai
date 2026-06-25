"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { EllipsisIcon, Unlink2Icon } from "lucide-react";

type OverflowMenuProps = {
  linkId: string;
  onUnlink: (linkId: string) => void;
};

export function OverflowMenu({
  linkId,
  onUnlink,
}: Readonly<OverflowMenuProps>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="More actions"
          className="text-muted-foreground"
          size="icon-sm"
          variant="ghost"
        >
          <EllipsisIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onUnlink(linkId)}>
          <Unlink2Icon className="h-4 w-4" />
          Unlink
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
