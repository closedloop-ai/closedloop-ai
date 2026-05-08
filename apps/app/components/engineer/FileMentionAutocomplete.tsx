"use client";

import { cn } from "@repo/design-system/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { File, FileCode, FileText, Loader2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { fileSearchOptions } from "@/lib/engineer/queries/files";

type FileMentionAutocompleteProps = {
  query: string;
  isOpen: boolean;
  onSelect: (file: string) => void;
  onClose: () => void;
  ticketId: string;
  repoPath: string;
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onFilesChange?: (files: string[]) => void;
};

/**
 * Get icon based on file extension
 */
function getFileIcon(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase();

  const codeExtensions = [
    "ts",
    "tsx",
    "js",
    "jsx",
    "py",
    "go",
    "rs",
    "java",
    "c",
    "cpp",
    "h",
  ];
  const textExtensions = [
    "md",
    "txt",
    "json",
    "yaml",
    "yml",
    "toml",
    "xml",
    "html",
    "css",
  ];

  if (codeExtensions.includes(ext || "")) {
    return FileCode;
  }
  if (textExtensions.includes(ext || "")) {
    return FileText;
  }
  return File;
}

/**
 * FileMentionAutocomplete component
 * Shows a dropdown of file suggestions when @ is typed in the chat input
 */
export function FileMentionAutocomplete({
  query,
  isOpen,
  onSelect,
  onClose,
  ticketId,
  repoPath,
  selectedIndex,
  onSelectedIndexChange,
  onFilesChange,
}: Readonly<FileMentionAutocompleteProps>) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const prevFilesRef = useRef<string>("");

  // Fetch files matching the query
  const { data, isLoading } = useQuery({
    ...fileSearchOptions(ticketId, repoPath, query),
    enabled: isOpen,
    staleTime: 30_000, // Cache for 30 seconds
  });

  const rawFiles = useMemo(() => data?.files || [], [data?.files]);

  // Prepend @claude and @codex as special entries when the query is a prefix match
  const showClaudeEntry = useMemo(
    () => query === "" || "claude".startsWith(query.toLowerCase()),
    [query]
  );
  const showCodexEntry = useMemo(
    () => query === "" || "codex".startsWith(query.toLowerCase()),
    [query]
  );
  const files = useMemo(() => {
    const mentions: string[] = [];
    if (showClaudeEntry) {
      mentions.push("@claude");
    }
    if (showCodexEntry) {
      mentions.push("@codex");
    }
    return [...mentions, ...rawFiles];
  }, [showClaudeEntry, showCodexEntry, rawFiles]);

  // Report files to parent when they actually change (compare by value, not reference)
  useEffect(() => {
    const filesKey = files.join(",");
    if (filesKey !== prevFilesRef.current) {
      prevFilesRef.current = filesKey;
      onFilesChange?.(files);
    }
  }, [files, onFilesChange]);

  // Reset selected index when files change
  useEffect(() => {
    if (files.length > 0 && selectedIndex >= files.length) {
      onSelectedIndexChange(0);
    }
  }, [files.length, selectedIndex, onSelectedIndexChange]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex >= 0 && itemRefs.current[selectedIndex]) {
      itemRefs.current[selectedIndex]?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [selectedIndex]);

  // Handle click outside to close
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // Delay adding listener to avoid immediate close
    const timeout = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 10);

    return () => {
      clearTimeout(timeout);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className={cn(
        "absolute right-0 bottom-full left-0 mb-2",
        "rounded-lg border border-border bg-popover shadow-lg",
        "max-h-64 overflow-y-auto",
        "z-50"
      )}
      ref={listRef}
    >
      <FileSearchResults
        files={files}
        isLoading={isLoading}
        itemRefs={itemRefs}
        onSelect={onSelect}
        onSelectedIndexChange={onSelectedIndexChange}
        query={query}
        selectedIndex={selectedIndex}
        truncated={data?.truncated}
      />
    </div>
  );
}

type FileSearchResultsProps = {
  isLoading: boolean;
  files: string[];
  query: string;
  truncated?: boolean;
  selectedIndex: number;
  onSelect: (file: string) => void;
  onSelectedIndexChange: (index: number) => void;
  itemRefs: React.RefObject<(HTMLButtonElement | null)[]>;
};

function FileSearchResults({
  isLoading,
  files,
  query,
  truncated,
  selectedIndex,
  onSelect,
  onSelectedIndexChange,
  itemRefs,
}: Readonly<FileSearchResultsProps>) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4 text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        <span className="font-mono text-xs">Searching files...</span>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="px-3 py-4 text-center">
        <span className="font-mono text-muted-foreground text-xs">
          {query ? `No files matching "${query}"` : "No files found"}
        </span>
      </div>
    );
  }

  return (
    <div className="py-1">
      {files.map((file, index) => {
        const isClaudeEntry = file === "@claude";
        const isCodexEntry = file === "@codex";
        const isSpecialEntry = isClaudeEntry || isCodexEntry;
        const providerName = isClaudeEntry ? "Claude" : "Codex";
        const Icon = isSpecialEntry ? Sparkles : getFileIcon(file);
        const isSelected = index === selectedIndex;
        // Show border after the last special entry (before file list starts)
        const nextFile = files[index + 1];
        const isLastSpecial =
          isSpecialEntry &&
          (!nextFile || (nextFile !== "@claude" && nextFile !== "@codex"));

        return (
          <button
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left",
              "cursor-pointer transition-colors",
              isSelected
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted/50",
              isLastSpecial && "border-border border-b"
            )}
            key={file}
            onClick={() => onSelect(file)}
            onMouseEnter={() => onSelectedIndexChange(index)}
            ref={(el) => {
              itemRefs.current[index] = el;
            }}
            type="button"
          >
            <Icon
              className={cn(
                "size-4 shrink-0",
                getEntryIconColor(isClaudeEntry, isCodexEntry)
              )}
            />
            <span
              className="truncate font-mono text-xs"
              title={isSpecialEntry ? `Chat with ${providerName}` : file}
            >
              {file}
            </span>
            {isSpecialEntry && (
              <span className="ml-auto text-[10px] text-muted-foreground">
                Chat with {providerName}
              </span>
            )}
          </button>
        );
      })}
      {truncated && (
        <div className="mt-1 border-border border-t px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
          Type more to narrow results...
        </div>
      )}
    </div>
  );
}

function getEntryIconColor(
  isClaudeEntry: boolean,
  isCodexEntry: boolean
): string {
  if (isClaudeEntry) {
    return "text-emerald-600 dark:text-emerald-400";
  }
  if (isCodexEntry) {
    return "text-[oklch(0.45_0.025_260)] dark:text-[oklch(0.65_0.025_260)]";
  }
  return "text-muted-foreground";
}

/** Shared mention autocomplete state shape. */
export type MentionState = {
  isOpen: boolean;
  query: string;
  startIndex: number;
  selectedIndex: number;
};

/** Dispatch mention-autocomplete key events. Returns true if the event was consumed. */
export function dispatchMentionKeyDown(
  e: React.KeyboardEvent,
  mentionState: { selectedIndex: number },
  mentionFiles: string[],
  setMentionState: React.Dispatch<React.SetStateAction<MentionState | null>>,
  handleFileSelect: (file: string) => void
): boolean {
  if (e.key === "Escape") {
    e.preventDefault();
    setMentionState(null);
    return true;
  }
  if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
    e.preventDefault();
    const selectedFile = mentionFiles[mentionState.selectedIndex];
    if (selectedFile) {
      handleFileSelect(selectedFile);
    }
    return true;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    setMentionState((prev) =>
      prev
        ? {
            ...prev,
            selectedIndex: Math.min(
              prev.selectedIndex + 1,
              mentionFiles.length - 1
            ),
          }
        : null
    );
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    setMentionState((prev) =>
      prev
        ? { ...prev, selectedIndex: Math.max(0, prev.selectedIndex - 1) }
        : null
    );
    return true;
  }
  if (e.key === " ") {
    setMentionState(null);
    return true;
  }
  return false;
}
