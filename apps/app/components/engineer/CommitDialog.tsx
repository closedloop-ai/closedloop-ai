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
import { Input } from "@repo/design-system/components/ui/input";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  FileEdit,
  FilePlus,
  FileX,
  Loader2,
  Sparkles,
} from "lucide-react";
import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { getWorktreePath } from "@/lib/engineer/chat-utils";
import { markTicketPushed } from "@/lib/engineer/push-tracker";
import { reposOptions } from "@/lib/engineer/queries/repos";

// Module-level cache: persists across dialog open/close, resets on page reload
const commitMessageCache = new Map<
  string,
  { title: string; description: string }
>();

type GitFiles = {
  modified: string[];
  created: string[];
  deleted: string[];
  staged: string[];
};

type CommitDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketId: string;
  repoPath: string;
  onSuccess: () => void;
};

/**
 * CommitDialog component provides a dialog for committing and pushing changes.
 *
 * Features:
 * - Auto-generated commit message from log.md or Claude
 * - Separate title and description fields
 * - Cancel and "Commit & Push" buttons
 * - Loading state during fetch and commit/push operations
 * - Success/error feedback via toast notifications
 * - Closes automatically on success
 */
export function CommitDialog({
  open,
  onOpenChange,
  ticketId,
  repoPath,
  onSuccess,
}: Readonly<CommitDialogProps>) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [files, setFiles] = useState<GitFiles | null>(null);
  const [filesExpanded, setFilesExpanded] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const { data: reposData } = useQuery(reposOptions());

  const worktreePath = getWorktreePath(
    repoPath,
    ticketId,
    reposData?.settings?.worktreeParentDir
  );

  const fetchGitStatus = useCallback(
    async (signal?: AbortSignal) => {
      const statusResponse = await fetch("/api/engineer/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status", repoPath: worktreePath }),
        signal,
      }).catch(() => null);

      if (signal?.aborted) {
        return;
      }

      if (statusResponse?.ok) {
        const data = await statusResponse.json();
        setFiles(data.files || null);
      } else {
        setFiles(null);
      }
    },
    [worktreePath]
  );

  const fetchCommitMessage = useCallback(
    async (signal?: AbortSignal) => {
      const messageResponse = await fetch(
        `/api/engineer/symphony/commit-message/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
        { signal }
      ).catch(() => null);

      if (signal?.aborted) {
        return;
      }

      if (messageResponse?.ok) {
        const data = await messageResponse.json();
        const newTitle = data.title || `Work on ${ticketId}`;
        const newDescription = data.description || "";
        setTitle(newTitle);
        setDescription(newDescription);
        commitMessageCache.set(ticketId, {
          title: newTitle,
          description: newDescription,
        });
      } else {
        const fallbackTitle = `Work on ${ticketId}`;
        setTitle(fallbackTitle);
        setDescription("");
        commitMessageCache.set(ticketId, {
          title: fallbackTitle,
          description: "",
        });
      }
    },
    [ticketId, repoPath]
  );

  // Fetch suggested commit message and git status when dialog opens
  useEffect(() => {
    if (!open) {
      return;
    }

    const abortController = new AbortController();
    abortRef.current = abortController;
    const cached = commitMessageCache.get(ticketId);

    const fetchData = async () => {
      setIsFetching(true);

      if (cached) {
        // Use cached message, only fetch git status
        setTitle(cached.title);
        setDescription(cached.description);
        await fetchGitStatus(abortController.signal);
      } else {
        // Fetch both in parallel
        await Promise.all([
          fetchCommitMessage(abortController.signal),
          fetchGitStatus(abortController.signal),
        ]);
      }

      if (!abortController.signal.aborted) {
        setIsFetching(false);
      }
    };

    fetchData();

    return () => {
      abortController.abort();
      abortRef.current = null;
    };
  }, [open, ticketId, fetchCommitMessage, fetchGitStatus]);

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Only reset files on close; title/description are preserved via cache
      setFiles(null);
    }
    onOpenChange(newOpen);
  };

  const handleRegenerate = async () => {
    commitMessageCache.delete(ticketId);
    setIsFetching(true);
    await fetchCommitMessage();
    setIsFetching(false);
  };

  // Count total files to be committed
  const totalFiles = files
    ? files.modified.length + files.created.length + files.deleted.length
    : 0;

  const handleSubmit = async (e: SyntheticEvent) => {
    e.preventDefault();

    if (!title.trim()) {
      toast.error("Commit title is required");
      return;
    }

    // Combine title and description into full commit message
    const fullMessage = description.trim()
      ? `${title.trim()}\n\n${description.trim()}`
      : title.trim();

    setIsLoading(true);

    try {
      // Stage all changes and commit (use worktree path)
      const commitResponse = await fetch("/api/engineer/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "commit",
          message: fullMessage,
          repoPath: worktreePath,
        }),
      });

      if (!commitResponse.ok) {
        const data = await commitResponse.json();
        throw new Error(data.error || "Failed to commit changes");
      }

      // Push to remote (use worktree path)
      const pushResponse = await fetch("/api/engineer/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "push", repoPath: worktreePath }),
      });

      if (!pushResponse.ok) {
        const data = await pushResponse.json();
        throw new Error(data.error || "Failed to push changes");
      }

      // Mark ticket as pushed so we don't show the button again
      markTicketPushed(ticketId);

      // Clear cached commit message so next commit gets a fresh one
      commitMessageCache.delete(ticketId);

      toast.success("Changes committed and pushed", {
        description: `Committed: "${title}"`,
      });

      // Close dialog and notify parent
      onOpenChange(false);
      onSuccess();
    } catch (error) {
      toast.error("Failed to commit and push", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const isDisabled = isLoading || isFetching;

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="overflow-hidden sm:max-w-lg">
        <form className="min-w-0" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Commit & Push Changes</DialogTitle>
            <DialogDescription>
              Review and edit the commit message for {ticketId}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {isFetching ? (
              <div className="flex flex-col items-center justify-center gap-3 py-8">
                <div className="flex items-center text-muted-foreground">
                  <Loader2 className="mr-2 size-5 animate-spin" />
                  Generating commit message...
                </div>
                <button
                  className="cursor-pointer text-muted-foreground/60 text-xs transition-colors hover:text-muted-foreground"
                  onClick={() => {
                    setIsFetching(false);
                    if (!title) {
                      setTitle(`Work on ${ticketId}`);
                    }
                  }}
                  type="button"
                >
                  Skip and write manually
                </button>
              </div>
            ) : (
              <>
                {/* Files to be committed */}
                {files && totalFiles > 0 && (
                  <div className="rounded-lg border bg-muted/30">
                    <button
                      className="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-left font-medium text-sm transition-colors hover:bg-muted/50"
                      onClick={() => setFilesExpanded(!filesExpanded)}
                      type="button"
                    >
                      <span>
                        {totalFiles} file{totalFiles === 1 ? "" : "s"} to be
                        committed
                      </span>
                      {filesExpanded ? (
                        <ChevronDown className="size-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-4 text-muted-foreground" />
                      )}
                    </button>
                    {filesExpanded && (
                      <div className="max-h-40 space-y-2 overflow-y-auto px-3 pb-3">
                        {files.modified.length > 0 && (
                          <div className="space-y-1">
                            {files.modified.map((file) => (
                              <div
                                className="flex items-center gap-2 text-xs"
                                key={file}
                              >
                                <FileEdit className="size-3.5 shrink-0 text-amber-500" />
                                <span
                                  className="truncate text-muted-foreground"
                                  title={file}
                                >
                                  {file}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {files.created.length > 0 && (
                          <div className="space-y-1">
                            {files.created.map((file) => (
                              <div
                                className="flex items-center gap-2 text-xs"
                                key={file}
                              >
                                <FilePlus className="size-3.5 shrink-0 text-emerald-500" />
                                <span
                                  className="truncate text-muted-foreground"
                                  title={file}
                                >
                                  {file}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {files.deleted.length > 0 && (
                          <div className="space-y-1">
                            {files.deleted.map((file) => (
                              <div
                                className="flex items-center gap-2 text-xs"
                                key={file}
                              >
                                <FileX className="size-3.5 shrink-0 text-red-500" />
                                <span
                                  className="truncate text-muted-foreground"
                                  title={file}
                                >
                                  {file}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-2">
                  <label className="font-medium text-sm" htmlFor="title">
                    Title
                  </label>
                  <Input
                    autoFocus
                    disabled={isDisabled}
                    id="title"
                    onChange={(e) => {
                      setTitle(e.target.value);
                      const cached = commitMessageCache.get(ticketId);
                      commitMessageCache.set(ticketId, {
                        title: e.target.value,
                        description: cached?.description ?? description,
                      });
                    }}
                    placeholder={`Work on ${ticketId}`}
                    value={title}
                  />
                </div>

                <div className="space-y-2">
                  <label className="font-medium text-sm" htmlFor="description">
                    Description{" "}
                    <span className="text-muted-foreground">(optional)</span>
                  </label>
                  <Textarea
                    disabled={isDisabled}
                    id="description"
                    onChange={(e) => {
                      setDescription(e.target.value);
                      const cached = commitMessageCache.get(ticketId);
                      commitMessageCache.set(ticketId, {
                        title: cached?.title ?? title,
                        description: e.target.value,
                      });
                    }}
                    placeholder="Additional details about the changes..."
                    rows={4}
                    value={description}
                  />
                </div>

                <div className="flex justify-end">
                  <button
                    className="inline-flex cursor-pointer items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                    disabled={isDisabled}
                    onClick={handleRegenerate}
                    type="button"
                  >
                    <Sparkles
                      className={`size-3 ${isFetching ? "animate-pulse" : ""}`}
                    />
                    Regenerate message
                  </button>
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button
              disabled={isLoading}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={isDisabled || !title.trim()} type="submit">
              {isLoading && <Loader2 className="mr-2 animate-spin" />}
              Commit & Push
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
