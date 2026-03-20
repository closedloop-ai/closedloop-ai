"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { cn } from "@repo/design-system/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Eye,
  FolderGit2,
  GitBranch,
  GitFork,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { PathAutocomplete } from "@/components/engineer/PathAutocomplete";
import {
  type MergedFileResult,
  RepoFileAutocomplete,
} from "@/components/engineer/RepoFileAutocomplete";
import { branchesOptions } from "@/lib/engineer/queries/git";
import { queryKeys } from "@/lib/engineer/queries/keys";
import {
  addRepo,
  removeRepo,
  reposOptions,
} from "@/lib/engineer/queries/repos";

type DialogStep = "select-repo" | "add-context";

export type MentionedFile = {
  repoPath: string;
  filePath: string;
};

type MentionState = {
  isOpen: boolean;
  query: string;
  rawLength: number; // characters after @ to replace (before repo prefix stripping)
  startIndex: number;
  selectedIndex: number;
};

type RepoPickerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketIdentifier: string;
  onConfirm: (
    repoPath: string,
    additionalContext?: string,
    contextRepoPaths?: string[],
    mentionedFiles?: MentionedFile[],
    baseBranch?: string
  ) => void;
  /** Skip the "add context" step and confirm immediately after repo selection */
  skipContextStep?: boolean;
};

/**
 * Dialog for selecting which repository to start planning in.
 * Shows a list of configured repos and lets the user add new ones.
 * Step 2 supports @-mention file autocomplete across selected repos.
 */
export function RepoPickerDialog({
  open,
  onOpenChange,
  ticketIdentifier,
  onConfirm,
  skipContextStep = false,
}: Readonly<RepoPickerDialogProps>) {
  const [step, setStep] = useState<DialogStep>("select-repo");
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [contextRepos, setContextRepos] = useState<Set<string>>(new Set());
  const [additionalContext, setAdditionalContext] = useState("");
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [newRepoPath, setNewRepoPath] = useState("~/");
  const [addError, setAddError] = useState<string | null>(null);

  // Branch selection state (collapsed by default)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [branchSearch, setBranchSearch] = useState("");
  const [copied, setCopied] = useState(false);

  // @ mention state
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const [mentionFiles, setMentionFiles] = useState<MergedFileResult[]>([]);
  const [mentionedFiles, setMentionedFiles] = useState<MentionedFile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  const queryClient = useQueryClient();

  // Fetch repos from API
  const { data, isLoading } = useQuery({
    ...reposOptions(),
    enabled: open,
  });

  const repos = useMemo(() => data?.repos || [], [data?.repos]);

  // Fetch branches when a repo is selected
  const { data: branchesData, isLoading: branchesLoading } = useQuery({
    ...branchesOptions(selectedRepo || ""),
    enabled: open && !!selectedRepo,
  });

  // Reset branch selection when repo changes
  const handleRepoSelect = (path: string) => {
    setSelectedRepo(path);
    setSelectedBranch(null); // Reset to default branch
    setShowAdvanced(false);
    setBranchSearch("");
    // Remove from context if selecting as primary
    setContextRepos((prev) => {
      if (!prev.has(path)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  };

  // Build the list of repos available for @ mention (primary + context)
  const mentionRepos = useMemo(
    () =>
      repos
        .filter((r) => r.path === selectedRepo || contextRepos.has(r.path))
        .map((r) => ({ name: r.name, path: r.path })),
    [repos, selectedRepo, contextRepos]
  );

  // Derive a basename lookup for mentioned files chips
  const repoNameByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of repos) {
      map.set(r.path, r.name);
    }
    return map;
  }, [repos]);

  // Add repo mutation
  const addRepoMutation = useMutation({
    mutationFn: addRepo,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.repos() });
      setShowAddRepo(false);
      setNewRepoPath("~/");
      setAddError(null);
    },
    onError: (error: Error) => {
      setAddError(error.message);
    },
  });

  // Remove repo mutation
  const removeRepoMutation = useMutation({
    mutationFn: removeRepo,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.repos() });
      // Clear selection if removed repo was selected
      setSelectedRepo(null);
    },
  });

  const handleToggleContext = (path: string, e: React.SyntheticEvent) => {
    e.stopPropagation();
    setContextRepos((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleNext = () => {
    if (selectedRepo) {
      if (skipContextStep) {
        // For ticket chat - skip context step and confirm immediately
        const branch = selectedBranch || branchesData?.defaultBranch;
        onConfirm(selectedRepo, undefined, undefined, undefined, branch);
        onOpenChange(false);
        setSelectedRepo(null);
        setSelectedBranch(null);
        setShowAdvanced(false);
        setContextRepos(new Set());
      } else {
        setStep("add-context");
      }
    }
  };

  const handleBack = () => {
    setStep("select-repo");
  };

  const handleStartPlanning = () => {
    if (selectedRepo) {
      const context = additionalContext.trim() || undefined;
      const ctxPaths = contextRepos.size > 0 ? [...contextRepos] : undefined;
      const mentions = mentionedFiles.length > 0 ? mentionedFiles : undefined;
      const branch = selectedBranch || branchesData?.defaultBranch;
      onConfirm(selectedRepo, context, ctxPaths, mentions, branch);
      onOpenChange(false);
      // Reset state
      setSelectedRepo(null);
      setSelectedBranch(null);
      setShowAdvanced(false);
      setContextRepos(new Set());
      setAdditionalContext("");
      setMentionState(null);
      setMentionFiles([]);
      setMentionedFiles([]);
      setStep("select-repo");
    }
  };

  const handleCancel = () => {
    onOpenChange(false);
    setSelectedRepo(null);
    setSelectedBranch(null);
    setShowAdvanced(false);
    setBranchSearch("");
    setContextRepos(new Set());
    setAdditionalContext("");
    setMentionState(null);
    setMentionFiles([]);
    setMentionedFiles([]);
    setStep("select-repo");
    setShowAddRepo(false);
    setNewRepoPath("~/");
    setAddError(null);
  };

  const handleAddRepo = (path: string) => {
    setAddError(null);
    addRepoMutation.mutate(path);
  };

  const handleRemoveRepo = (path: string, e: React.SyntheticEvent) => {
    e.stopPropagation();
    removeRepoMutation.mutate(path);
    setContextRepos((prev) => {
      if (!prev.has(path)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  };

  // Build the display string for a mentioned file (used for insertion and sync)
  const getMentionDisplay = (repoPath: string, filePath: string) => {
    const repoName = repoNameByPath.get(repoPath) || "repo";
    return `@${repoName}/${filePath}`;
  };

  // @ mention: handle textarea input changes
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const cursorPos = e.target.selectionStart;
    setAdditionalContext(newValue);

    // Sync mentionedFiles: remove any whose display string is no longer in the text
    setMentionedFiles((prev) => {
      const filtered = prev.filter((f) =>
        newValue.includes(getMentionDisplay(f.repoPath, f.filePath))
      );
      if (filtered.length === prev.length) {
        return prev;
      }
      return filtered;
    });

    // Find if we're in a mention context
    let mentionStart = -1;
    for (let i = cursorPos - 1; i >= 0; i--) {
      const char = newValue[i];
      if (char === "@") {
        if (i === 0 || /\s/.test(newValue[i - 1])) {
          mentionStart = i;
        }
        break;
      }
      if (/\s/.test(char)) {
        break;
      }
    }

    if (mentionStart >= 0) {
      const rawQuery = newValue.slice(mentionStart + 1, cursorPos);
      let query = rawQuery;

      // Strip repo name prefix (e.g. "claude_code/.github/..." → ".github/...")
      // so the API receives only the file path portion
      for (const repo of mentionRepos) {
        if (query.startsWith(`${repo.name}/`)) {
          query = query.slice(repo.name.length + 1);
          break;
        }
      }

      setMentionState({
        isOpen: true,
        query,
        rawLength: rawQuery.length,
        startIndex: mentionStart,
        selectedIndex: 0,
      });
    } else {
      setMentionState(null);
    }
  };

  // @ mention: handle file selection from autocomplete
  const handleFileSelect = (
    display: string,
    repoPath: string,
    filePath: string
  ) => {
    if (!mentionState) {
      return;
    }

    // Insert @display (keep the @ that triggered the mention)
    const beforeMention = additionalContext.slice(0, mentionState.startIndex);
    const afterMention = additionalContext.slice(
      mentionState.startIndex + 1 + mentionState.rawLength
    );
    const insertText = `@${display}`;
    const newValue = `${beforeMention + insertText} ${afterMention}`;

    setAdditionalContext(newValue);
    setMentionState(null);

    // Track the mentioned file (avoid duplicates)
    setMentionedFiles((prev) => {
      const exists = prev.some(
        (f) => f.repoPath === repoPath && f.filePath === filePath
      );
      if (exists) {
        return prev;
      }
      return [...prev, { repoPath, filePath }];
    });

    // Focus textarea and set cursor after inserted text
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const newCursorPos = beforeMention.length + insertText.length + 1;
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
      }
    }, 0);
  };

  const closeMention = () => {
    setMentionState(null);
  };

  // @ mention: keyboard handling
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!mentionState?.isOpen) {
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMentionState((prev) =>
        prev ? { ...prev, selectedIndex: prev.selectedIndex + 1 } : null
      );
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setMentionState((prev) =>
        prev
          ? { ...prev, selectedIndex: Math.max(0, prev.selectedIndex - 1) }
          : null
      );
      return;
    }
    if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      const selected = mentionFiles[mentionState.selectedIndex];
      if (selected) {
        handleFileSelect(
          selected.display,
          selected.repoPath,
          selected.filePath
        );
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeMention();
      return;
    }
    if (e.key === " ") {
      closeMention();
    }
  };

  // Find the selected repo for display
  const selectedRepoInfo = repos.find((r) => r.path === selectedRepo);
  const contextRepoInfos = repos.filter((r) => contextRepos.has(r.path));

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        {step === "select-repo" ? (
          <>
            <DialogHeader>
              <DialogTitle>Select Repository</DialogTitle>
              <DialogDescription>
                Choose which repository to start planning {ticketIdentifier} in.
                A new git worktree will be created for this ticket.
              </DialogDescription>
            </DialogHeader>

            <div className="max-h-[60vh] space-y-2 overflow-y-auto py-4">
              {isLoading && (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="mr-2 size-5 animate-spin" />
                  <span className="text-sm">Loading repositories...</span>
                </div>
              )}
              {!isLoading && repos.length === 0 && !showAddRepo && (
                <div className="py-8 text-center text-muted-foreground">
                  <p className="mb-4 text-sm">No repositories configured</p>
                  <Button
                    onClick={() => setShowAddRepo(true)}
                    size="sm"
                    variant="outline"
                  >
                    <Plus className="mr-2 size-4" />
                    Add Repository
                  </Button>
                </div>
              )}
              {!isLoading && (repos.length > 0 || showAddRepo) && (
                <>
                  {repos.map((repo) => {
                    const isPrimary = selectedRepo === repo.path;
                    const isContext = contextRepos.has(repo.path);

                    return (
                      <div
                        className={cn(
                          "group flex w-full cursor-pointer items-center gap-3 rounded-lg border p-3 text-left transition-colors",
                          isPrimary && "border-primary bg-primary/5",
                          isContext &&
                            !isPrimary &&
                            "border-blue-400/50 bg-blue-500/5",
                          !(isPrimary || isContext) &&
                            "border-border hover:bg-muted/50"
                        )}
                        key={repo.path}
                        onClick={() => handleRepoSelect(repo.path)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleRepoSelect(repo.path);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                      >
                        <div
                          className={cn(
                            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                            isPrimary
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted"
                          )}
                        >
                          {isPrimary ? (
                            <Check className="h-5 w-5" />
                          ) : (
                            <FolderGit2 className="h-5 w-5" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{repo.name}</p>
                          <p className="truncate text-muted-foreground text-sm">
                            {repo.description || repo.path}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          {selectedRepo && !isPrimary && (
                            <button
                              className={cn(
                                "rounded-md p-2 transition-all",
                                isContext
                                  ? "bg-blue-500/10 text-blue-500 opacity-100 hover:bg-blue-500/20"
                                  : "opacity-0 hover:bg-blue-500/10 hover:text-blue-500 group-hover:opacity-100",
                                "focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                              )}
                              onClick={(e) => handleToggleContext(repo.path, e)}
                              title={
                                isContext
                                  ? "Remove as context repo"
                                  : "Add as read-only context"
                              }
                              type="button"
                            >
                              <Eye className="size-4" />
                            </button>
                          )}
                          <button
                            className={cn(
                              "rounded-md p-2 opacity-0 transition-opacity group-hover:opacity-100",
                              "hover:bg-destructive/10 hover:text-destructive",
                              "focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-destructive/50"
                            )}
                            onClick={(e) => handleRemoveRepo(repo.path, e)}
                            title="Remove repository"
                            type="button"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  {/* Help text for context repos */}
                  {selectedRepo && repos.length > 1 && (
                    <p className="px-1 text-muted-foreground text-xs">
                      Click the{" "}
                      <Eye className="inline size-3 align-text-bottom" /> icon
                      on other repos to include them as read-only context.
                    </p>
                  )}

                  {/* Add Repository Section - placed before Advanced */}
                  {showAddRepo ? (
                    <div className="space-y-3 rounded-lg border border-border border-dashed p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-sm">
                          Add Repository
                        </span>
                        <button
                          className="rounded p-1 hover:bg-muted"
                          onClick={() => {
                            setShowAddRepo(false);
                            setNewRepoPath("~/");
                            setAddError(null);
                          }}
                        >
                          <X className="size-4 text-muted-foreground" />
                        </button>
                      </div>

                      <PathAutocomplete
                        autoFocus
                        onChange={setNewRepoPath}
                        onSelect={handleAddRepo}
                        placeholder="~/Source/my-repo"
                        value={newRepoPath}
                      />

                      {addError && (
                        <p className="text-destructive text-sm">{addError}</p>
                      )}

                      <p className="text-muted-foreground text-xs">
                        Navigate to a git repository and press Enter to add it.
                      </p>
                    </div>
                  ) : (
                    <button
                      className={cn(
                        "flex w-full items-center justify-center gap-2 rounded-lg p-3",
                        "border border-border border-dashed",
                        "text-muted-foreground hover:border-foreground/50 hover:text-foreground",
                        "cursor-pointer transition-colors"
                      )}
                      onClick={() => setShowAddRepo(true)}
                    >
                      <Plus className="size-4" />
                      <span className="text-sm">Add Repository</span>
                    </button>
                  )}

                  {/* Empty repo warning */}
                  {selectedRepo && branchesData?.isEmpty && (
                    <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                      <div>
                        <p className="font-medium text-amber-600 dark:text-amber-400">
                          This repository has no commits
                        </p>
                        <p className="mt-1 text-muted-foreground">
                          Create an initial commit before starting:
                        </p>
                        <button
                          className="mt-1.5 flex items-center gap-1.5 rounded bg-muted px-2 py-1 font-mono text-xs transition-colors hover:bg-muted/80"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(
                                'git commit --allow-empty -m "Initial commit"'
                              );
                              setCopied(true);
                              setTimeout(() => setCopied(false), 2000);
                            } catch {
                              // Silently fail — clipboard may not be available
                            }
                          }}
                          type="button"
                        >
                          <code>
                            git commit --allow-empty -m &quot;Initial
                            commit&quot;
                          </code>
                          {copied ? (
                            <Check className="size-3 shrink-0 text-green-500" />
                          ) : (
                            <ClipboardCopy className="size-3 shrink-0 text-muted-foreground" />
                          )}
                        </button>
                        <button
                          className="mt-2 flex items-center gap-1.5 text-amber-600 text-xs hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
                          onClick={() => {
                            queryClient.invalidateQueries({
                              queryKey: queryKeys.gitBranches(selectedRepo!),
                            });
                          }}
                          type="button"
                        >
                          <RefreshCw className="size-3" />
                          Recheck
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Advanced: Branch Selection - shown when repo is selected */}
                  {selectedRepo && (
                    <div className="mt-4">
                      <button
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-3 py-2",
                          "text-muted-foreground text-sm hover:text-foreground",
                          "cursor-pointer transition-colors",
                          showAdvanced && "text-foreground"
                        )}
                        onClick={() => setShowAdvanced(!showAdvanced)}
                        type="button"
                      >
                        {showAdvanced ? (
                          <ChevronDown className="size-4" />
                        ) : (
                          <ChevronRight className="size-4" />
                        )}
                        <GitBranch className="size-4" />
                        <span>Advanced: Change base branch</span>
                      </button>

                      {showAdvanced && (
                        <div className="mt-2 space-y-3 rounded-lg border border-border p-3">
                          {branchesLoading ? (
                            <div className="flex items-center justify-center py-4 text-muted-foreground">
                              <Loader2 className="mr-2 size-4 animate-spin" />
                              <span className="text-sm">
                                Loading branches...
                              </span>
                            </div>
                          ) : (
                            <>
                              {/* Current selection display */}
                              <div className="flex items-center gap-2 text-sm">
                                <span className="text-muted-foreground">
                                  Base:
                                </span>
                                <span className="font-medium">
                                  {selectedBranch ||
                                    branchesData?.defaultBranch ||
                                    "default"}
                                  {!selectedBranch && " (default)"}
                                </span>
                              </div>

                              {/* Active Worktrees */}
                              {branchesData?.worktrees &&
                                branchesData.worktrees.length > 0 && (
                                  <div className="space-y-1.5">
                                    <p className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
                                      Active Worktrees
                                    </p>
                                    {branchesData.worktrees.map((wt) => (
                                      <button
                                        className={cn(
                                          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                                          "cursor-pointer transition-colors",
                                          selectedBranch === wt.branch
                                            ? "border border-primary/30 bg-primary/10 text-primary"
                                            : "hover:bg-muted"
                                        )}
                                        key={wt.path}
                                        onClick={() =>
                                          setSelectedBranch(wt.branch)
                                        }
                                        type="button"
                                      >
                                        <GitFork className="size-3.5 shrink-0 text-muted-foreground" />
                                        <span className="truncate font-mono text-xs">
                                          {wt.ticketId && (
                                            <span className="font-semibold">
                                              {wt.ticketId} →{" "}
                                            </span>
                                          )}
                                          {wt.branch}
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                )}

                              {/* All Branches with Search */}
                              {branchesData?.branches &&
                                branchesData.branches.length > 0 && (
                                  <div className="space-y-1.5">
                                    <p className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
                                      All Branches
                                    </p>
                                    {/* Search input - only show if more than 5 branches */}
                                    {branchesData.branches.length > 5 && (
                                      <div className="relative">
                                        <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                                        <input
                                          className={cn(
                                            "w-full rounded-md border border-input-border py-1.5 pr-2 pl-7",
                                            "bg-transparent text-xs placeholder:text-muted-foreground",
                                            "focus:outline-none focus:ring-1 focus:ring-ring"
                                          )}
                                          onChange={(e) =>
                                            setBranchSearch(e.target.value)
                                          }
                                          placeholder="Search branches..."
                                          type="text"
                                          value={branchSearch}
                                        />
                                      </div>
                                    )}
                                    <div className="max-h-40 space-y-0.5 overflow-y-auto">
                                      {branchesData.branches
                                        .filter(
                                          (br) =>
                                            !branchSearch ||
                                            br.name
                                              .toLowerCase()
                                              .includes(
                                                branchSearch.toLowerCase()
                                              )
                                        )
                                        .map((br) => {
                                          const isDefault =
                                            br.name ===
                                            branchesData.defaultBranch;
                                          const isSelected =
                                            selectedBranch === br.name ||
                                            (!selectedBranch && isDefault);

                                          return (
                                            <button
                                              className={cn(
                                                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                                                "cursor-pointer transition-colors",
                                                isSelected
                                                  ? "border border-primary/30 bg-primary/10 text-primary"
                                                  : "hover:bg-muted"
                                              )}
                                              key={br.name}
                                              onClick={() =>
                                                setSelectedBranch(
                                                  isDefault ? null : br.name
                                                )
                                              }
                                              type="button"
                                            >
                                              <div
                                                className={cn(
                                                  "size-2 shrink-0 rounded-full",
                                                  isSelected
                                                    ? "bg-primary"
                                                    : "bg-muted-foreground/30"
                                                )}
                                              />
                                              <span className="truncate font-mono text-xs">
                                                {br.name}
                                                {isDefault && (
                                                  <span className="ml-1 text-muted-foreground">
                                                    (default)
                                                  </span>
                                                )}
                                              </span>
                                            </button>
                                          );
                                        })}
                                    </div>
                                  </div>
                                )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <DialogFooter className="gap-3">
              <Button onClick={handleCancel} variant="outline">
                Cancel
              </Button>
              <Button
                disabled={
                  !selectedRepo ||
                  addRepoMutation.isPending ||
                  branchesData?.isEmpty
                }
                onClick={handleNext}
              >
                {addRepoMutation.isPending && (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Adding...
                  </>
                )}
                {!addRepoMutation.isPending && skipContextStep && "Select"}
                {!(addRepoMutation.isPending || skipContextStep) && "Next"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Additional Context</DialogTitle>
              <DialogDescription>
                Optionally provide additional instructions or context to include
                with the requirements from {ticketIdentifier}.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {/* Show selected repo */}
              <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 p-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <FolderGit2 className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm">
                    {selectedRepoInfo?.name || selectedRepo}
                  </p>
                </div>
              </div>

              {/* Show context repos */}
              {contextRepoInfos.length > 0 &&
                contextRepoInfos.map((repo) => (
                  <div
                    className="flex items-center gap-3 rounded-lg border border-blue-400/30 bg-blue-500/5 p-3"
                    key={repo.path}
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
                      <Eye className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-sm">
                        {repo.name}
                      </p>
                    </div>
                    <span className="text-muted-foreground text-xs">
                      context
                    </span>
                  </div>
                ))}

              {/* Additional context textarea with @ mention */}
              <div className="space-y-2">
                <label
                  className="font-medium text-sm"
                  htmlFor="additional-context"
                >
                  Additional Instructions{" "}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </label>
                <div className="relative">
                  {mentionState?.isOpen && mentionRepos.length > 0 && (
                    <RepoFileAutocomplete
                      isOpen={mentionState.isOpen}
                      onClose={closeMention}
                      onFilesChange={setMentionFiles}
                      onSelect={handleFileSelect}
                      onSelectedIndexChange={(idx) =>
                        setMentionState((prev) =>
                          prev ? { ...prev, selectedIndex: idx } : null
                        )
                      }
                      query={mentionState.query}
                      repos={mentionRepos}
                      selectedIndex={mentionState.selectedIndex}
                    />
                  )}
                  {/* Highlight overlay — mirrors textarea text with colored mention backgrounds */}
                  <div
                    aria-hidden="true"
                    className={cn(
                      "absolute inset-0 rounded-md border border-transparent px-3 py-2",
                      "pointer-events-none overflow-hidden whitespace-pre-wrap break-words text-sm"
                    )}
                    ref={highlightRef}
                  >
                    {renderHighlightedText(
                      additionalContext,
                      mentionedFiles,
                      repoNameByPath
                    )}
                  </div>
                  <textarea
                    className={cn(
                      "block min-h-[120px] w-full rounded-md border border-input-border px-3 py-2",
                      "relative bg-transparent text-sm placeholder:text-muted-foreground",
                      "focus:outline-none focus:ring-2 focus:ring-ring",
                      "resize-y"
                    )}
                    id="additional-context"
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    onScroll={() => {
                      if (textareaRef.current && highlightRef.current) {
                        highlightRef.current.scrollTop =
                          textareaRef.current.scrollTop;
                      }
                    }}
                    placeholder="e.g., Focus on performance optimizations... (@ to mention files)"
                    ref={textareaRef}
                    spellCheck={false}
                    value={additionalContext}
                  />
                </div>
                <p className="text-muted-foreground text-xs">
                  Type{" "}
                  <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                    @
                  </kbd>{" "}
                  to mention files. This will be included alongside the Linear
                  ticket description.
                </p>

                {/* Mentioned file chips */}
                {mentionedFiles.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {mentionedFiles.map((f) => {
                      const repoName = repoNameByPath.get(f.repoPath) || "repo";
                      const fileName =
                        f.filePath.split("/").pop() || f.filePath;
                      return (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-xs"
                          key={`${f.repoPath}:${f.filePath}`}
                          title={`${repoName}/${f.filePath}`}
                        >
                          <span className="text-muted-foreground">
                            {repoName}/
                          </span>
                          <span>{fileName}</span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <DialogFooter className="gap-3">
              <Button onClick={handleBack} variant="outline">
                <ChevronLeft className="mr-1 size-4" />
                Back
              </Button>
              <Button onClick={handleStartPlanning}>Start Planning</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Render textarea text with highlighted @mention spans.
 * All text is rendered with `color: transparent` so only the textarea text is visible,
 * but @mention tokens get a visible background highlight that shows through.
 */
function renderHighlightedText(
  text: string,
  mentionedFiles: MentionedFile[],
  repoNameByPath: Map<string, string>
) {
  if (mentionedFiles.length === 0) {
    return <span className="text-transparent">{text || "\u00A0"}</span>;
  }

  // Build the set of display strings to highlight
  const displayStrings = mentionedFiles.map((f) => {
    const repoName = repoNameByPath.get(f.repoPath) || "repo";
    return `@${repoName}/${f.filePath}`;
  });

  // Split text by mention tokens, preserving the tokens
  const parts: { text: string; isMention: boolean }[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let earliestIdx = -1;
    let earliestMatch = "";

    for (const display of displayStrings) {
      const idx = remaining.indexOf(display);
      if (idx >= 0 && (earliestIdx === -1 || idx < earliestIdx)) {
        earliestIdx = idx;
        earliestMatch = display;
      }
    }

    if (earliestIdx === -1) {
      parts.push({ text: remaining, isMention: false });
      break;
    }

    if (earliestIdx > 0) {
      parts.push({ text: remaining.slice(0, earliestIdx), isMention: false });
    }
    parts.push({ text: earliestMatch, isMention: true });
    remaining = remaining.slice(earliestIdx + earliestMatch.length);
  }

  return (
    <>
      {parts.map((part, i) =>
        part.isMention ? (
          <span
            className="rounded bg-sky-500/25 px-0.5 text-transparent"
            key={`${i}-${part.text}`}
          >
            {part.text}
          </span>
        ) : (
          <span className="text-transparent" key={`${i}-${part.text}`}>
            {part.text}
          </span>
        )
      )}
    </>
  );
}
