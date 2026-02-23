"use client";

import { useCallback, useMemo, useState } from "react";

export type SlashCommand = {
  command: string;
  description: string;
};

type SlashCommandState = {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
};

export function useSlashCommands(
  commands: readonly SlashCommand[],
  onSelect: (command: string) => void
) {
  const [slashState, setSlashState] = useState<SlashCommandState | null>(null);

  const filteredCommands = useMemo(() => {
    if (!slashState?.isOpen) {
      return [];
    }
    const q = slashState.query.toLowerCase();
    return commands.filter((cmd) =>
      cmd.command.toLowerCase().slice(1).startsWith(q)
    );
  }, [slashState, commands]);

  const detectSlash = useCallback((value: string, cursorPos: number) => {
    const beforeCursor = value.slice(0, cursorPos);
    const slashMatch = /^\/(\S*)$/.exec(beforeCursor);
    if (slashMatch && !/\s/.test(beforeCursor)) {
      setSlashState({
        isOpen: true,
        query: slashMatch[1],
        selectedIndex: 0,
      });
    } else {
      setSlashState(null);
    }
  }, []);

  const selectCommand = useCallback(
    (command: string) => {
      setSlashState(null);
      onSelect(command);
    },
    [onSelect]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!slashState?.isOpen || filteredCommands.length === 0) {
        return false;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashState((prev) =>
          prev
            ? {
                ...prev,
                selectedIndex: Math.min(
                  prev.selectedIndex + 1,
                  filteredCommands.length - 1
                ),
              }
            : null
        );
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashState((prev) =>
          prev
            ? { ...prev, selectedIndex: Math.max(prev.selectedIndex - 1, 0) }
            : null
        );
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const selected = filteredCommands[slashState.selectedIndex];
        if (selected) {
          selectCommand(selected.command);
        }
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashState(null);
        return true;
      }
      return false;
    },
    [slashState, filteredCommands, selectCommand]
  );

  const close = useCallback(() => setSlashState(null), []);

  return {
    slashState,
    filteredCommands,
    detectSlash,
    handleKeyDown,
    selectCommand,
    close,
  };
}
