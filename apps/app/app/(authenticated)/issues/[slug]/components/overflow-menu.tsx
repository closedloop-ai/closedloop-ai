"use client";

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
        <button
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          type="button"
        >
          <EllipsisIcon className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onUnlink(linkId)}>
          <Unlink2Icon className="mr-2 h-4 w-4" />
          Unlink
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
