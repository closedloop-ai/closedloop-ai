"use client";

import { cn } from "@repo/design-system/lib/utils";
import type { SlashCommand } from "@/hooks/engineer/use-slash-commands";

type SlashCommandDropdownProps = {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: string) => void;
};

export function SlashCommandDropdown({
  commands,
  selectedIndex,
  onSelect,
}: Readonly<SlashCommandDropdownProps>) {
  if (commands.length === 0) {
    return null;
  }

  return (
    <div className="absolute bottom-full left-0 z-50 mb-1 w-64 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
      {commands.map((cmd, i) => (
        <button
          className={cn(
            "flex w-full cursor-pointer flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors",
            i === selectedIndex
              ? "bg-accent text-accent-foreground"
              : "hover:bg-muted"
          )}
          key={cmd.command}
          onClick={() => onSelect(cmd.command)}
          type="button"
        >
          <span className="font-medium font-mono">{cmd.command}</span>
          <span className="text-[11px] text-muted-foreground">
            {cmd.description}
          </span>
        </button>
      ))}
    </div>
  );
}
