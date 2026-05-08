"use client";

import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { cn } from "@repo/design-system/lib/utils";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

type Props = {
  availableTargets: ComputeTargetConflictBody["availableTargets"];
  onSelect: (targetId: string) => void;
};

export function LoopDispatchTargetSelector({
  availableTargets,
  onSelect,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          className="min-w-[220px] justify-between"
          role="combobox"
          size="sm"
          variant="outline"
        >
          <span className="truncate">Select compute target</span>
          <ChevronDown className="ml-2 size-4 shrink-0 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[300px] p-0">
        <Command>
          <CommandList>
            <CommandEmpty>No compute targets available.</CommandEmpty>
            <CommandGroup heading="Execution targets">
              {availableTargets.map((target) => (
                <CommandItem
                  className="cursor-pointer"
                  key={target.id}
                  onSelect={() => {
                    onSelect(target.id);
                    setOpen(false);
                  }}
                  value={target.machineName}
                >
                  <span className="flex items-center">
                    <span
                      aria-hidden
                      className={cn(
                        "mr-2 inline-block size-2 rounded-full",
                        target.status === "online"
                          ? "bg-emerald-500"
                          : "bg-red-500"
                      )}
                    />
                    <span className="truncate text-sm">
                      {target.machineName}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
