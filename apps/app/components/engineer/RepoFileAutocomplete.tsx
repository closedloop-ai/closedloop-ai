"use client";

import { cn } from "@repo/design-system/lib/utils";
import { useQueries } from "@tanstack/react-query";
import { File, FileCode, FileText, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { fileSearchBaseOptions } from "@/lib/engineer/queries/files";

type RepoFileAutocompleteProps = {
  repos: { name: string; path: string }[];
  query: string;
  isOpen: boolean;
  onSelect: (display: string, repoPath: string, filePath: string) => void;
  onClose: () => void;
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onFilesChange?: (files: MergedFileResult[]) => void;
};

type MergedFileResult = {
  repoName: string;
  repoPath: string;
  filePath: string;
  display: string;
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
 * RepoFileAutocomplete component
 * Shows a dropdown of file suggestions from multiple repos when @ is typed.
 * Makes parallel queries per repo and merges results.
 */
export function RepoFileAutocomplete({
  repos,
  query,
  isOpen,
  onSelect,
  onClose,
  selectedIndex,
  onSelectedIndexChange,
  onFilesChange,
}: Readonly<RepoFileAutocompleteProps>) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const prevFilesRef = useRef<string>("");

  // Make parallel queries for each repo
  const queryResults = useQueries({
    queries: repos.map((repo) => ({
      ...fileSearchBaseOptions(repo.path, query),
      enabled: isOpen,
      staleTime: 30_000,
    })),
  });

  const isLoading = queryResults.some((r) => r.isLoading);

  // Merge results from all repos, interleaved, limited to 10 total
  const mergedFiles = useMemo(() => {
    const perRepo: MergedFileResult[][] = repos.map((repo, i) => {
      const files = queryResults[i]?.data?.files || [];
      return files.map((filePath) => ({
        repoName: repo.name,
        repoPath: repo.path,
        filePath,
        display: `${repo.name}/${filePath}`,
      }));
    });

    // Interleave: take one from each repo in round-robin
    const merged: MergedFileResult[] = [];
    let round = 0;
    while (merged.length < 10) {
      let added = false;
      for (const repoFiles of perRepo) {
        if (round < repoFiles.length && merged.length < 10) {
          merged.push(repoFiles[round]);
          added = true;
        }
      }
      if (!added) {
        break;
      }
      round++;
    }

    return merged;
  }, [repos, queryResults]);

  // Report files to parent when they actually change
  useEffect(() => {
    const filesKey = mergedFiles.map((f) => f.display).join(",");
    if (filesKey !== prevFilesRef.current) {
      prevFilesRef.current = filesKey;
      onFilesChange?.(mergedFiles);
    }
  }, [mergedFiles, onFilesChange]);

  // Reset selected index when files change
  useEffect(() => {
    if (mergedFiles.length > 0 && selectedIndex >= mergedFiles.length) {
      onSelectedIndexChange(0);
    }
  }, [mergedFiles.length, selectedIndex, onSelectedIndexChange]);

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
      {isLoading ? (
        <div className="flex items-center justify-center py-4 text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          <span className="font-mono text-xs">Searching files...</span>
        </div>
      ) : mergedFiles.length === 0 ? (
        <div className="px-3 py-4 text-center">
          <span className="font-mono text-muted-foreground text-xs">
            {query ? `No files matching "${query}"` : "No files found"}
          </span>
        </div>
      ) : (
        <div className="py-1">
          {mergedFiles.map((file, index) => {
            const Icon = getFileIcon(file.filePath);
            const isSelected = index === selectedIndex;

            return (
              <button
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                  "cursor-pointer transition-colors",
                  isSelected
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted/50"
                )}
                key={`${file.repoPath}:${file.filePath}`}
                onClick={() =>
                  onSelect(file.display, file.repoPath, file.filePath)
                }
                onMouseEnter={() => onSelectedIndexChange(index)}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="shrink-0 text-muted-foreground text-xs">
                  {file.repoName}/
                </span>
                <span
                  className="truncate font-mono text-xs"
                  title={file.filePath}
                >
                  {file.filePath}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export type { MergedFileResult };
