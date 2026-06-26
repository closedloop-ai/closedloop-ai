"use client";

import { Input } from "@repo/design-system/components/ui/input";
import { cn } from "@repo/design-system/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Folder, FolderGit2, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { directoriesOptions } from "@/lib/engineer/queries/files";
import type { DirectoryEntry } from "@/types/repos";

type PathAutocompleteProps = {
  value: string;
  onChange: (value: string) => void;
  onSelect: (path: string) => void;
  placeholder: string;
  className?: string;
  autoFocus?: boolean;
};

/**
 * PathAutocomplete component
 * Text input where user types a path with dropdown showing matching subdirectories
 */
export function PathAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder,
  className,
  autoFocus = false,
}: Readonly<PathAutocompleteProps>) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Get the parent directory path to query
  // For a partially typed path, query the parent directory.
  const getQueryPath = useCallback(() => {
    if (!value) {
      return "~";
    }

    // If the value ends with /, query that directory
    if (value.endsWith("/")) {
      return value.slice(0, -1);
    }

    // Otherwise query the parent directory
    const lastSlash = value.lastIndexOf("/");
    if (lastSlash === -1) {
      return "~";
    }
    return value.slice(0, lastSlash) || "~";
  }, [value]);

  // Get the partial name being typed (for filtering)
  const getPartialName = useCallback(() => {
    if (!value || value.endsWith("/")) {
      return "";
    }

    const lastSlash = value.lastIndexOf("/");
    if (lastSlash === -1) {
      return value;
    }
    return value.slice(lastSlash + 1);
  }, [value]);

  const queryPath = getQueryPath();
  const partialName = getPartialName();

  // Fetch directories
  const { data, isLoading } = useQuery({
    ...directoriesOptions(queryPath),
    enabled: isOpen && queryPath.length > 0,
    staleTime: 10_000, // Cache for 10 seconds
  });

  // Filter directories based on partial name
  const directories = (data?.directories || []).filter((dir) =>
    partialName
      ? dir.name.toLowerCase().startsWith(partialName.toLowerCase())
      : true
  );

  // Compute effective selected index (clamp to valid range)
  const effectiveSelectedIndex =
    directories.length > 0
      ? Math.min(selectedIndex, directories.length - 1)
      : 0;

  // Scroll selected item into view
  useEffect(() => {
    if (
      effectiveSelectedIndex >= 0 &&
      itemRefs.current[effectiveSelectedIndex]
    ) {
      itemRefs.current[effectiveSelectedIndex]?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [effectiveSelectedIndex]);

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        setIsOpen(true);
        e.preventDefault();
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % Math.max(directories.length, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex(
          (i) =>
            (i - 1 + Math.max(directories.length, 1)) %
            Math.max(directories.length, 1)
        );
        break;
      case "Tab":
        e.preventDefault();
        if (directories[effectiveSelectedIndex]) {
          const dir = directories[effectiveSelectedIndex];
          // Autocomplete to directory path + /
          onChange(`${dir.path}/`);
        }
        break;
      case "Enter":
        e.preventDefault();
        if (directories[effectiveSelectedIndex]) {
          const dir = directories[effectiveSelectedIndex];
          if (dir.isGitRepo) {
            // Select git repo
            onSelect(dir.path);
            setIsOpen(false);
          } else {
            // Navigate into directory
            onChange(`${dir.path}/`);
          }
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        break;
      default:
        break;
    }
  };

  // Handle click outside
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (
        inputRef.current &&
        !inputRef.current.contains(e.target as Node) &&
        listRef.current &&
        !listRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // When autoFocus is set, place cursor at end instead of selecting all text
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      const input = inputRef.current;
      const len = input.value.length;
      requestAnimationFrame(() => {
        input.setSelectionRange(len, len);
      });
    }
  }, [autoFocus]);

  // Handle directory selection
  const handleSelect = (dir: DirectoryEntry) => {
    if (dir.isGitRepo) {
      onSelect(dir.path);
      setIsOpen(false);
    } else {
      onChange(`${dir.path}/`);
      inputRef.current?.focus();
    }
  };

  return (
    <div className={cn("relative", className)}>
      <Input
        aria-label={placeholder}
        autoFocus={autoFocus}
        className="font-mono text-sm"
        onChange={(e) => {
          onChange(e.target.value);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        ref={inputRef}
        value={value}
      />

      {isOpen && (
        <div
          className={cn(
            "absolute top-full right-0 left-0 mt-1",
            "rounded-lg border border-border bg-popover shadow-lg",
            "max-h-64 overflow-y-auto",
            "z-50"
          )}
          ref={listRef}
        >
          {isLoading && (
            <div className="flex items-center justify-center py-4 text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              <span className="text-xs">Loading directories...</span>
            </div>
          )}
          {!isLoading && directories.length === 0 && (
            <div className="px-3 py-4 text-center">
              <span className="text-muted-foreground text-xs">
                {partialName
                  ? `No directories matching "${partialName}"`
                  : "No directories found"}
              </span>
            </div>
          )}
          {!isLoading && directories.length > 0 && (
            <div className="py-1">
              {directories.map((dir, index) => {
                const isSelected = index === effectiveSelectedIndex;
                const Icon = dir.isGitRepo ? FolderGit2 : Folder;

                return (
                  <button
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                      "cursor-pointer transition-colors",
                      isSelected
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted/50"
                    )}
                    key={dir.path}
                    onClick={() => handleSelect(dir)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    ref={(el) => {
                      itemRefs.current[index] = el;
                    }}
                    type="button"
                  >
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        dir.isGitRepo
                          ? "text-orange-500"
                          : "text-muted-foreground"
                      )}
                    />
                    <span className="flex-1 truncate text-sm">{dir.name}</span>
                    {dir.isGitRepo && (
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                        git
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
