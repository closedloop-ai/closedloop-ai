import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { cn } from "@repo/design-system/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ActiveTicketCard } from "@/components/engineer/ActiveTicketCard";
import { CloseTicketDialog } from "@/components/engineer/CloseTicketDialog";
import { CodexReviewDialog } from "@/components/engineer/CodexReviewDialog";
import { CommitDialog } from "@/components/engineer/CommitDialog";
import { DeployDialog } from "@/components/engineer/DeployDialog";
import { LinkPRDialog } from "@/components/engineer/LinkPRDialog";
import type { MentionedFile } from "@/components/engineer/RepoPickerDialog";
import { RepoPickerDialog } from "@/components/engineer/RepoPickerDialog";
import { SymphonyChat } from "@/components/engineer/SymphonyChat";
import { TicketCard } from "@/components/engineer/TicketCard";
import { TicketCardSkeleton } from "@/components/engineer/TicketCardSkeleton";
import { TicketChatDialog } from "@/components/engineer/TicketChatDialog";
import {
  TicketListRow,
  TicketListRowSkeleton,
} from "@/components/engineer/TicketListRow";
import { useCodexAvailable } from "@/hooks/engineer/use-codex-available";
import type { FullTicketDetails } from "@/hooks/engineer/use-engineer-features";
import { useStartPlanLoop } from "@/hooks/engineer/use-start-plan-loop";
import { useSymphonyLaunch } from "@/hooks/engineer/useSymphonyLaunch";
import {
  clearDeployment,
  type DeployInfo,
  getActiveDeploymentForRepo,
  getDeployment,
  getDeployments,
  saveDeployment,
  updateDeployment,
} from "@/lib/engineer/deploy-tracker";
import {
  clearTicketPR,
  getTicketPR,
  saveTicketPR,
} from "@/lib/engineer/pr-tracker";
import { clearTicketPushed, isTicketPushed } from "@/lib/engineer/push-tracker";
import { triggerDeployDetect } from "@/lib/engineer/queries/deploy";
import { queryKeys } from "@/lib/engineer/queries/keys";
import { reposOptions } from "@/lib/engineer/queries/repos";
import type { SymphonyStatusResponse } from "@/lib/engineer/queries/symphony";
import { getChildTickets } from "@/lib/engineer/stack-utils";
import { deriveBaseRepoPath } from "@/lib/engineer/worktree-utils";
import { type EngineerTicket, TicketSourceType } from "@/types/engineer";

/**
 * Derive the base repo path from a worktree directory path.
 * Handles both ticket-based ({repoName}-{ticketId}) and
 * loop-based ({repoName}-loop-{slug}) naming schemes.
 */
type TicketListProps = {
  tickets: EngineerTicket[];
  isLoading?: boolean;
  onUpdateTicketStatus?: (
    ticketIdentifier: string,
    status: string
  ) => Promise<boolean>;
  getFullTicket: (ticketId: string) => Promise<FullTicketDetails>;
  onPostComment?: (ticketIdentifier: string, body: string) => Promise<void>;
  onRefresh?: () => void;
  viewMode?: "grid" | "list";
};

const LIST_SKELETON_KEYS = [
  "list-skeleton-1",
  "list-skeleton-2",
  "list-skeleton-3",
  "list-skeleton-4",
  "list-skeleton-5",
  "list-skeleton-6",
  "list-skeleton-7",
  "list-skeleton-8",
];

const GRID_SKELETON_KEYS = [
  "grid-skeleton-1",
  "grid-skeleton-2",
  "grid-skeleton-3",
  "grid-skeleton-4",
  "grid-skeleton-5",
  "grid-skeleton-6",
];

/**
 * TicketList component displays Linear tickets in a responsive grid layout.
 * When Symphony is running for a ticket, it shows in a dedicated "Active Planning" section.
 */
export function TicketList({
  tickets,
  isLoading = false,
  onUpdateTicketStatus,
  getFullTicket,
  onPostComment,
  onRefresh,
  viewMode = "grid",
}: Readonly<TicketListProps>) {
  const {
    activeSessions,
    launchingTickets,
    launch,
    clearSession,
    mergeSessionFields,
    isActive,
    getSession,
    error,
  } = useSymphonyLaunch();

  const {
    startPlanLoop,
    pendingDocuments,
    selectDocument,
    clearPendingDocuments,
  } = useStartPlanLoop(
    async (ticketIdentifier, repoPath, worktreePath, loopId, documentId) => {
      // Persist loopId + documentId in the session immediately so ActiveTicketCard
      // can use them before the gateway process starts.
      mergeSessionFields(ticketIdentifier, {
        repoPath,
        worktreePath,
        loopId,
        documentId,
      });
      // Also persist to the sessions file via the API route
      await fetch("/api/gateway/symphony/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketId: ticketIdentifier,
          repoPath,
          worktreePath,
          loopId,
          documentId,
        }),
      });
    }
  );
  const [workDirStatus, setWorkDirStatus] = useState<
    Record<
      string,
      {
        exists: boolean;
        path: string | null;
        pendingClaudeMd: string | null;
        branchStatus: { merged: boolean; remoteMissing: boolean } | null;
      }
    >
  >({});
  const [pushedStatus, setPushedStatus] = useState<Record<string, boolean>>({});
  const [prStatus, setPrStatus] = useState<
    Record<string, { url: string; number: number; repoPath?: string } | null>
  >({});
  const [creatingPR, setCreatingPR] = useState<string | null>(null); // ticketId of PR being created
  const [resumingTicketId, setResumingTicketId] = useState<string | null>(null); // ticketId being resumed
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [selectedRepoPath, setSelectedRepoPath] = useState<string>("");
  const [pendingPlanTicketId, setPendingPlanTicketId] = useState<string | null>(
    null
  );
  const [showCompleted, setShowCompleted] = useState(() => {
    if (globalThis.window === undefined) {
      return false;
    }
    return localStorage.getItem("show-completed-tickets") === "true";
  });
  const lastLaunchedTicketRef = useRef<Set<string>>(new Set());

  // Deploy state
  const [deployStatus, setDeployStatus] = useState<
    Record<string, DeployInfo | null>
  >({});
  const [deployDialogOpen, setDeployDialogOpen] = useState(false);
  const [deployTicketId, setDeployTicketId] = useState<string | null>(null);

  // Close ticket dialog state
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [closeTicketId, setCloseTicketId] = useState<string | null>(null);
  const [closeChangedFiles, setCloseChangedFiles] = useState<{
    modified: string[];
    created: string[];
    deleted: string[];
    staged: string[];
  }>({ modified: [], created: [], deleted: [], staged: [] });

  // Ask Claude dialog state
  const [ticketChatOpen, setTicketChatOpen] = useState(false);
  const [ticketChatTicket, setTicketChatTicket] =
    useState<EngineerTicket | null>(null);
  const [ticketChatRepoPath, setTicketChatRepoPath] = useState<string | null>(
    null
  );
  const [ticketChatRepoBehindBy, setTicketChatRepoBehindBy] = useState(0);
  const [pendingTicketChatTicketId, setPendingTicketChatTicketId] = useState<
    string | null
  >(null);
  const [ticketChatInitialMessage, setTicketChatInitialMessage] = useState<
    string | undefined
  >(undefined);

  // Codex review dialog state
  const [codexReviewOpen, setCodexReviewOpen] = useState(false);
  const [codexReviewTicketId, setCodexReviewTicketId] = useState<string | null>(
    null
  );
  const [codexReviewRepoPath, setCodexReviewRepoPath] = useState<string | null>(
    null
  );

  // Link PR dialog state
  const [linkPROpen, setLinkPROpen] = useState(false);
  const [linkPRTicketId, setLinkPRTicketId] = useState<string | null>(null);

  // Comments-only view state
  const [commentViewOpen, setCommentViewOpen] = useState(false);
  const [commentViewTicketId, setCommentViewTicketId] = useState<string | null>(
    null
  );

  // Check if Codex CLI is available
  const { data: codexData } = useCodexAvailable();
  const codexAvailable = codexData?.available ?? false;

  // Pagination state
  const TICKETS_PER_PAGE = viewMode === "list" ? 15 : 6;
  const [pendingPage, setPendingPage] = useState(0);
  const [donePage, setDonePage] = useState(0);

  // Reopened tickets - completed tickets the user wants back in Pending section
  const [reopenedTickets, setReopenedTickets] = useState<Set<string>>(() => {
    if (globalThis.window === undefined) {
      return new Set();
    }
    try {
      const stored = localStorage.getItem("reopened-tickets");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });

  // Starred tickets - pending tickets the user wants in the "Next Up" section
  // Stored as an ordered array to preserve the order in which tickets were starred
  const [starredTickets, setStarredTickets] = useState<string[]>(() => {
    if (globalThis.window === undefined) {
      return [];
    }
    try {
      const stored = localStorage.getItem("starred-tickets");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  const starredSet = useMemo(() => new Set(starredTickets), [starredTickets]);

  const handleToggleStar = (ticketId: string) => {
    setStarredTickets((prev) => {
      const next = prev.includes(ticketId)
        ? prev.filter((id) => id !== ticketId)
        : [...prev, ticketId];
      localStorage.setItem("starred-tickets", JSON.stringify(next));
      return next;
    });
  };

  // Reopen a completed ticket (move back to Pending in UI only)
  const handleReopenTicket = (ticketId: string) => {
    setReopenedTickets((prev) => {
      const next = new Set(prev);
      next.add(ticketId);
      localStorage.setItem("reopened-tickets", JSON.stringify([...next]));
      return next;
    });
    toast.success("Ticket moved back to pending");
  };

  // Handler for Ask Claude button - opens repo picker first
  const handleAskClaude = (ticket: EngineerTicket) => {
    setTicketChatTicket(ticket);
    setPendingTicketChatTicketId(ticket.identifier);
    setRepoPickerOpen(true);
  };

  // Handler for Codex Review button
  const handleCodexReview = (ticketId: string) => {
    const session = getSession(ticketId);
    const worktreePath = workDirStatus[ticketId]?.path;
    const repoPath = session?.repoPath || worktreePath;

    if (!repoPath) {
      toast.error("No worktree found for this ticket");
      return;
    }

    setCodexReviewTicketId(ticketId);
    setCodexReviewRepoPath(repoPath);
    setCodexReviewOpen(true);
  };

  // Handler for Link PR button
  const handleLinkPR = (ticketId: string) => {
    setLinkPRTicketId(ticketId);
    setLinkPROpen(true);
  };

  // Handler for when a PR is linked from the dialog
  const handlePRLinked = (
    prUrl: string,
    prNumber: number,
    repoPath: string
  ) => {
    if (!linkPRTicketId) {
      return;
    }
    saveTicketPR(linkPRTicketId, prUrl, prNumber, repoPath);
    setPrStatus((prev) => ({
      ...prev,
      [linkPRTicketId]: { url: prUrl, number: prNumber, repoPath },
    }));
    toast.success("PR linked", {
      description: `PR #${prNumber} linked to ${linkPRTicketId}`,
    });
  };

  // Handler for View PR Comments button
  const handleViewComments = (ticketId: string) => {
    setCommentViewTicketId(ticketId);
    setCommentViewOpen(true);
  };

  // Handler for when repo is selected for ticket chat
  const handleTicketChatRepoSelected = async (repoPath: string) => {
    if (!(pendingTicketChatTicketId && ticketChatTicket)) {
      return;
    }

    setPendingTicketChatTicketId(null);
    setTicketChatRepoPath(repoPath);

    // Check repo sync status
    try {
      const response = await fetch("/api/gateway/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sync-status",
          repoPath,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setTicketChatRepoBehindBy(data.behindBy || 0);
      } else {
        setTicketChatRepoBehindBy(0);
      }
    } catch (err) {
      console.error("Failed to check repo sync status:", err);
      setTicketChatRepoBehindBy(0);
    }

    // Open the chat dialog
    setTicketChatOpen(true);
  };

  // Handler for learnings indicator click
  const handleLearningsClick = (
    ticket: EngineerTicket,
    claudeMdPath: string
  ) => {
    const status = workDirStatus[ticket.identifier];
    const isMerged = status?.branchStatus?.merged;

    // Set initial message based on branch status (only for merged branches)
    const initialMsg = isMerged
      ? `The branch for this ticket has been merged. There are uncommitted changes to CLAUDE.md at:\n\n\`${claudeMdPath}\`\n\nAnalyze these learnings and provide recommended actions for handling them.`
      : undefined;

    setTicketChatTicket(ticket);
    setTicketChatInitialMessage(initialMsg);

    // Derive repo path from worktree path
    const worktreePath = status?.path;
    if (worktreePath) {
      const pathParts = worktreePath.split("/");
      const worktreeDirName = pathParts.at(-1)!;
      const parentDir = pathParts.slice(0, -1).join("/");
      const sanitizedTicket = ticket.identifier.replaceAll(
        /[^a-zA-Z0-9-_]/g,
        "_"
      );
      const repoName = worktreeDirName.replace(`-${sanitizedTicket}`, "");
      const baseRepoPath = `${parentDir}/${repoName}`;
      setTicketChatRepoPath(baseRepoPath);
    }

    setTicketChatRepoBehindBy(0);
    setTicketChatOpen(true);
  };

  // Fetch configured repos to get default
  const { data: reposData } = useQuery(reposOptions());
  const queryClient = useQueryClient();

  // Set default repo path when repos load
  useEffect(() => {
    if (reposData?.repos?.length && !selectedRepoPath) {
      setSelectedRepoPath(reposData.repos[0].path);
    }
  }, [reposData, selectedRepoPath]);

  // Clean up reopened set: remove entries for tickets that are no longer completed in Linear
  useEffect(() => {
    if (reopenedTickets.size === 0) {
      return;
    }
    const completedIds = new Set(
      tickets
        .filter((t) => t.status.type === "completed")
        .map((t) => t.identifier)
    );
    const stale = [...reopenedTickets].filter((id) => !completedIds.has(id));
    if (stale.length > 0) {
      setReopenedTickets((prev) => {
        const next = new Set(prev);
        for (const id of stale) {
          next.delete(id);
        }
        localStorage.setItem("reopened-tickets", JSON.stringify([...next]));
        return next;
      });
    }
  }, [tickets, reopenedTickets]);

  // Find all active tickets (multiple)
  const activeTickets = tickets.filter((t) => isActive(t.identifier));

  // Filter out canceled tickets entirely — they should not appear in the UI
  const visibleTickets = tickets.filter((t) => t.status.type !== "canceled");

  // Filter tickets into categories (excluding all active tickets)
  // Reopened tickets are treated as pending even if their Linear status is completed
  const isCompleted = (t: EngineerTicket) => t.status.type === "completed";
  const pendingTickets = visibleTickets.filter(
    (t) =>
      !isActive(t.identifier) &&
      (!isCompleted(t) || reopenedTickets.has(t.identifier))
  );
  const completedTickets = visibleTickets.filter(
    (t) =>
      !isActive(t.identifier) &&
      isCompleted(t) &&
      !reopenedTickets.has(t.identifier)
  );

  // Split pending tickets into starred (Next Up) vs unstarred
  // Sort starred tickets by the order they were starred (starredTickets array order)
  const starredPendingTickets = pendingTickets
    .filter((t) => starredSet.has(t.identifier))
    .sort(
      (a, b) =>
        starredTickets.indexOf(a.identifier) -
        starredTickets.indexOf(b.identifier)
    );
  const unstarredPendingTickets = pendingTickets.filter(
    (t) => !starredSet.has(t.identifier)
  );

  // Clean up starred list: remove entries for tickets that are no longer pending
  // Guard: skip cleanup while tickets are still loading to avoid wiping starred state
  useEffect(() => {
    if (starredTickets.length === 0 || tickets.length === 0) {
      return;
    }
    const pendingIds = new Set(pendingTickets.map((t) => t.identifier));
    const stale = starredTickets.filter((id) => !pendingIds.has(id));
    if (stale.length > 0) {
      setStarredTickets((prev) => {
        const staleSet = new Set(stale);
        const next = prev.filter((id) => !staleSet.has(id));
        localStorage.setItem("starred-tickets", JSON.stringify(next));
        return next;
      });
    }
  }, [tickets, starredTickets, pendingTickets]);

  // Reset pagination when underlying data or view mode changes
  useEffect(() => {
    setPendingPage(0);
  }, []);

  useEffect(() => {
    setDonePage(0);
  }, []);

  // Compute paginated slices (pagination applies to unstarred pending only)
  const pendingPageCount = Math.ceil(
    unstarredPendingTickets.length / TICKETS_PER_PAGE
  );
  const paginatedPending = unstarredPendingTickets.slice(
    pendingPage * TICKETS_PER_PAGE,
    (pendingPage + 1) * TICKETS_PER_PAGE
  );

  const donePageCount = Math.ceil(completedTickets.length / TICKETS_PER_PAGE);
  const paginatedDone = completedTickets.slice(
    donePage * TICKETS_PER_PAGE,
    (donePage + 1) * TICKETS_PER_PAGE
  );

  // Check work directory existence for all tickets
  useEffect(() => {
    const checkWorkDirectories = async () => {
      const statusMap: Record<
        string,
        {
          exists: boolean;
          path: string | null;
          pendingClaudeMd: string | null;
          branchStatus: { merged: boolean; remoteMissing: boolean } | null;
        }
      > = {};

      await Promise.all(
        tickets.map(async (ticket) => {
          try {
            const response = await fetch(
              `/api/gateway/work-directory/${ticket.identifier}`
            );
            if (response.ok) {
              const data = await response.json();
              statusMap[ticket.identifier] = {
                exists: data.exists,
                path: data.path || null,
                pendingClaudeMd: data.pendingClaudeMd || null,
                branchStatus: data.branchStatus || null,
              };
            }
          } catch (error) {
            console.error(
              `Failed to check work directory for ${ticket.identifier}:`,
              error
            );
          }
        })
      );

      setWorkDirStatus(statusMap);
    };

    if (tickets.length > 0) {
      checkWorkDirectories();
    }
  }, [tickets]);

  // Check pushed status for all tickets (from localStorage)
  useEffect(() => {
    const statusMap: Record<string, boolean> = {};
    for (const ticket of tickets) {
      statusMap[ticket.identifier] = isTicketPushed(ticket.identifier);
    }
    setPushedStatus(statusMap);
  }, [tickets]);

  // Check PR status for all tickets (from localStorage)
  useEffect(() => {
    const statusMap: Record<
      string,
      { url: string; number: number; repoPath?: string } | null
    > = {};
    for (const ticket of tickets) {
      const pr = getTicketPR(ticket.identifier);
      statusMap[ticket.identifier] = pr
        ? { url: pr.url, number: pr.number, repoPath: pr.repoPath }
        : null;
    }
    setPrStatus(statusMap);
  }, [tickets]);

  // Load deploy status from localStorage on mount, and reconcile stale "deploying" entries
  useEffect(() => {
    const deploys = getDeployments();
    const statusMap: Record<string, DeployInfo | null> = {};
    for (const ticket of tickets) {
      statusMap[ticket.identifier] = deploys[ticket.identifier] || null;
    }
    setDeployStatus(statusMap);

    // Reconcile any "deploying" entries — the process may have finished while the page was closed
    const deploying = Object.entries(deploys).filter(
      ([, d]) => d.status === "deploying"
    );
    for (const [ticketId, info] of deploying) {
      const repoPath = (() => {
        // Derive repo path from worktree
        const pathParts = info.worktreePath.split("/");
        const worktreeDirName = pathParts.at(-1)!;
        const parentDir = pathParts.slice(0, -1).join("/");
        const sanitized = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
        const repoName = worktreeDirName.replace(`-${sanitized}`, "");
        return `${parentDir}/${repoName}`;
      })();

      const params = new URLSearchParams({ repo: repoPath });
      if (info.pid) {
        params.set("pid", String(info.pid));
      }

      fetch(
        `/api/gateway/deploy/status/${encodeURIComponent(ticketId)}?${params.toString()}`
      )
        .then((r) => r.json())
        .then((data) => {
          if (data.status === "completed") {
            // Process finished successfully — extract info
            fetch("/api/gateway/deploy/extract-info", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ repoPath, logs: data.logs || "" }),
            })
              .then((r) => r.json())
              .then((extracted) => {
                updateDeployment(ticketId, {
                  status: "deployed",
                  deployedUrl: extracted.url,
                  serviceId: extracted.serviceId,
                  deployedAt: new Date().toISOString(),
                });
                setDeployStatus((prev) => ({
                  ...prev,
                  [ticketId]: {
                    ...info,
                    status: "deployed",
                    deployedUrl: extracted.url,
                    serviceId: extracted.serviceId,
                    deployedAt: new Date().toISOString(),
                  },
                }));
              })
              .catch(() => {
                // Extraction failed but deploy succeeded
                updateDeployment(ticketId, {
                  status: "deployed",
                  deployedAt: new Date().toISOString(),
                });
                setDeployStatus((prev) => ({
                  ...prev,
                  [ticketId]: {
                    ...info,
                    status: "deployed",
                    deployedAt: new Date().toISOString(),
                  },
                }));
              });
          } else if (data.status === "failed") {
            updateDeployment(ticketId, { status: "failed" });
            setDeployStatus((prev) => ({
              ...prev,
              [ticketId]: { ...info, status: "failed" },
            }));
          }
          // If still "running", leave as "deploying" — the user will see the spinner
        })
        .catch(() => {
          // Can't reach status API — leave as-is
        });
    }
  }, [tickets]);

  // Health-check deployed entries on mount — clear stale ones where the server is gone
  // Reads directly from localStorage (not React state) to avoid timing issues with
  // the deployStatus state being populated by the effect above.
  useEffect(() => {
    const allDeploys = getDeployments();
    const deployed = Object.entries(allDeploys).filter(
      ([, d]) => d.status === "deployed" && d.deployedUrl
    );
    if (deployed.length === 0) {
      return;
    }

    for (const [ticketId, info] of deployed) {
      fetch("/api/gateway/deploy/health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: info.deployedUrl }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.alive) {
            if (info.healthCheckFailed) {
              updateDeployment(ticketId, {
                healthCheckFailed: false,
                consecutiveFailures: 0,
              });
              setDeployStatus((prev) => ({
                ...prev,
                [ticketId]: prev[ticketId]
                  ? {
                      ...prev[ticketId]!,
                      healthCheckFailed: false,
                      consecutiveFailures: 0,
                    }
                  : null,
              }));
            }
          } else {
            clearDeployment(ticketId);
            setDeployStatus((prev) => ({ ...prev, [ticketId]: null }));
          }
        })
        .catch(() => {
          // Can't reach health API — leave as-is
        });
    }
  }, []);

  // Silently clean up stale PR worktrees on mount (throttled to once per hour)
  useEffect(() => {
    const THROTTLE_KEY = "lastWorktreeCleanup";
    const ONE_HOUR = 60 * 60 * 1000;
    const last = globalThis.localStorage?.getItem(THROTTLE_KEY);
    if (last && Date.now() - Number(last) < ONE_HOUR) {
      return;
    }
    fetch("/api/gateway/git/worktree", { method: "POST" })
      .then((res) => {
        if (res.ok) {
          globalThis.localStorage?.setItem(THROTTLE_KEY, Date.now().toString());
        }
      })
      .catch(() => {});
  }, []);

  // Derive base repo path from a ticket's worktree or active session
  const getRepoPathForTicket = useCallback(
    (ticketId: string): string | null => {
      const session = getSession(ticketId);
      if (session?.repoPath) {
        return session.repoPath;
      }

      const worktree = workDirStatus[ticketId];
      if (worktree?.exists && worktree.path) {
        return deriveBaseRepoPath(worktree.path, ticketId);
      }

      return null;
    },
    [getSession, workDirStatus]
  );

  // Discover external deployments (e.g., `vercel --yes` from CLI) on page load
  useEffect(() => {
    // Guard: wait for work directory status to be loaded
    if (Object.keys(workDirStatus).length === 0) {
      return;
    }
    // Guard: wait for repos data
    if (!reposData?.repos) {
      return;
    }

    // Build a set of repos that have a port configured (local dev servers)
    const checkableRepos = new Set(
      reposData.repos.filter((r) => r.deployment?.port).map((r) => r.path)
    );

    // Find tickets that are post-code-complete, have a worktree, no deploy entry,
    // and their repo supports status checking
    const ticketsToCheck = tickets.filter((t) => {
      const id = t.identifier;
      const hasWorktree = workDirStatus[id]?.exists;
      const isPostCodeComplete = pushedStatus[id] || prStatus[id];
      const noDeployEntry = !deployStatus[id];
      if (!(hasWorktree && isPostCodeComplete && noDeployEntry)) {
        return false;
      }

      const repoPath = getRepoPathForTicket(id);
      return repoPath && checkableRepos.has(repoPath);
    });

    if (ticketsToCheck.length === 0) {
      return;
    }

    // Check each ticket for external deployments (fire-and-forget, parallel)
    for (const ticket of ticketsToCheck) {
      const id = ticket.identifier;
      const repoPath = getRepoPathForTicket(id)!;
      const worktreePath = workDirStatus[id]!.path!;

      fetch("/api/gateway/deploy/check-existing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath, worktreePath }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (!data.active) {
            return;
          }

          const repoName = repoPath.split("/").pop() || "";

          saveDeployment(id, {
            ticketId: id,
            worktreePath,
            repoName,
            deployedUrl: data.url,
            serviceId: data.serviceId,
            status: "deployed",
            deployedAt: new Date().toISOString(),
          });

          setDeployStatus((prev) => ({
            ...prev,
            [id]: {
              ticketId: id,
              worktreePath,
              repoName,
              deployedUrl: data.url,
              serviceId: data.serviceId,
              status: "deployed",
              deployedAt: new Date().toISOString(),
            },
          }));
        })
        .catch(() => {
          // Silently ignore — platform CLI may not be installed
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tickets,
    workDirStatus,
    pushedStatus,
    prStatus,
    deployStatus,
    reposData,
    getRepoPathForTicket,
  ]);

  // Trigger LLM detection for repos that have a local deployment but no port
  useEffect(() => {
    if (!reposData?.repos) {
      return;
    }
    const needsDetection = reposData.repos.filter(
      (r) => r.deployment?.type === "local" && !r.deployment.port
    );
    if (needsDetection.length === 0) {
      return;
    }
    for (const repo of needsDetection) {
      triggerDeployDetect(repo.path)
        .then((result) => {
          if (result.detected) {
            queryClient.invalidateQueries({ queryKey: queryKeys.repos() });
          }
        })
        .catch(() => {});
    }
  }, [reposData, queryClient]);

  // Show toast notifications for Closedloop.dev launch errors
  useEffect(() => {
    if (error) {
      toast.error("Failed to launch Closedloop.dev", { description: error });
    }
  }, [error]);

  // Show toast when a ticket finishes launching (transitions out of launchingTickets)
  useEffect(() => {
    for (const session of activeSessions) {
      if (
        !(
          launchingTickets.has(session.ticketId) ||
          lastLaunchedTicketRef.current.has(session.ticketId)
        )
      ) {
        // New session that wasn't there before and isn't launching
        lastLaunchedTicketRef.current.add(session.ticketId);
      }
    }
  }, [activeSessions, launchingTickets]);

  // Handler for starting planning - opens repo picker dialog OR resumes existing worktree
  const handleStartPlanning = async (ticketIdentifier: string) => {
    // Clear stale state from any previous planning session
    clearTicketPushed(ticketIdentifier);
    clearTicketPR(ticketIdentifier);
    setPushedStatus((prev) => ({ ...prev, [ticketIdentifier]: false }));
    setPrStatus((prev) => ({ ...prev, [ticketIdentifier]: null }));

    // Check if there's already a worktree for this ticket
    const existingWorktree = workDirStatus[ticketIdentifier];

    if (existingWorktree?.exists && existingWorktree.path) {
      const worktreePath = existingWorktree.path;
      const baseRepoPath = deriveBaseRepoPath(worktreePath, ticketIdentifier);

      // Resume directly without showing repo picker
      const ticket = tickets.find((t) => t.identifier === ticketIdentifier);

      // For feature-sourced tickets, use the real plan-loop flow even when
      // resuming an existing worktree. This creates a Loop record and
      // dispatches via the desktop gateway.
      if (ticket?.featureId) {
        console.log(
          "[TicketList] calling startPlanLoop for feature-sourced ticket"
        );
        const result = await startPlanLoop(ticket, baseRepoPath);
        if (
          result.launched &&
          !result.alreadyRunning &&
          ticket.status.type !== "started" &&
          onUpdateTicketStatus
        ) {
          try {
            await onUpdateTicketStatus(ticketIdentifier, "In Progress");
          } catch {
            // Status update is best-effort
          }
        }
        return;
      }

      // Artifact-sourced tickets: fall back to existing local launch path
      let fullTicket: FullTicketDetails | undefined;
      if (ticket) {
        try {
          fullTicket = await getFullTicket(ticket.id);
        } catch (err) {
          console.error("Failed to fetch full ticket details:", err);
          fullTicket = {
            identifier: ticket.identifier,
            title: ticket.title,
            description: ticket.description || "",
            url: ticket.url,
          };
        }
      }

      await launch(ticketIdentifier, baseRepoPath, fullTicket);
      return;
    }

    // No existing worktree - show repo picker
    setPendingPlanTicketId(ticketIdentifier);
    setRepoPickerOpen(true);
  };

  // Handler for when repo is selected - updates status and launches Symphony
  const handleRepoSelected = async (
    repoPath: string,
    additionalContext?: string,
    contextRepoPaths?: string[],
    mentionedFiles?: MentionedFile[],
    baseBranch?: string
  ) => {
    if (!pendingPlanTicketId) {
      return;
    }

    const ticketIdentifier = pendingPlanTicketId;
    setPendingPlanTicketId(null);

    const ticket = tickets.find((t) => t.identifier === ticketIdentifier);

    // Fetch full ticket details (needed as launch arg)
    let fullTicket: FullTicketDetails | undefined;
    if (ticket) {
      try {
        const fetched = await getFullTicket(ticket.id);
        fullTicket = {
          ...fetched,
          additionalContext,
          contextRepoPaths,
          mentionedFiles,
        };
      } catch (err) {
        console.error("Failed to fetch full ticket details:", err);
        fullTicket = {
          identifier: ticket.identifier,
          title: ticket.title,
          description: ticket.description || "",
          url: ticket.url,
          additionalContext,
          contextRepoPaths,
          mentionedFiles,
        };
      }
    }

    // For feature-sourced tickets, use the real plan-loop flow which creates a Loop
    // record and dispatches to the desktop gateway. For artifact-sourced tickets,
    // fall back to the existing local launch path.
    const isFeatureTick = !!ticket?.featureId;
    const result = isFeatureTick
      ? await startPlanLoop(ticket, repoPath, baseBranch)
      : await launch(ticketIdentifier, repoPath, fullTicket, baseBranch);

    if (result.launched && !result.alreadyRunning) {
      // Update ticket status to "In Progress" if not already
      if (ticket && ticket.status.type !== "started" && onUpdateTicketStatus) {
        try {
          const updated = await onUpdateTicketStatus(
            ticketIdentifier,
            "In Progress"
          );
          if (updated) {
            toast.success("Ticket moved to In Progress");
          }
        } catch (err) {
          console.error("Failed to update ticket status:", err);
        }
      }

      // Post comment: planning started (fire-and-forget)
      onPostComment?.(
        ticketIdentifier,
        "Planning has started.\n\n-Closedloop.dev"
      ).catch(() => {});
    }
  };

  // Handler for commit & push button
  // Note: Worktrees are already on their own branch, so no branch switching needed
  const handleCommitPush = (ticketId: string, repoPath?: string) => {
    const session = getSession(ticketId);
    const defaultRepo = reposData?.repos?.[0]?.path || "";
    const baseRepoPath = repoPath || session?.repoPath || defaultRepo;
    setSelectedTicketId(ticketId);
    setSelectedRepoPath(baseRepoPath);
    setCommitDialogOpen(true);
  };

  const handleCommitSuccess = () => {
    // Update pushed status for this ticket
    if (selectedTicketId) {
      setPushedStatus((prev) => ({
        ...prev,
        [selectedTicketId]: true,
      }));
    }
    setSelectedTicketId(null);
  };

  // Helper to remove worktree
  const removeWorktree = async (worktreePath: string, force = false) => {
    try {
      const response = await fetch("/api/gateway/git/worktree", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worktreePath, force }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to remove worktree");
      }
    } catch (err) {
      console.error("[TicketList] Failed to remove worktree:", err);
    }
  };

  // Handler for closing a ticket - checks for uncommitted changes first
  const handleCloseTicket = async (ticketId: string) => {
    const session = getSession(ticketId);
    if (!session) {
      clearSession(ticketId);
      return;
    }

    try {
      // Check git status of the worktree
      const response = await fetch("/api/gateway/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "status",
          repoPath: session.worktreePath,
        }),
      });

      if (!response.ok) {
        // Can't check status, just clear the session
        clearSession(ticketId);
        return;
      }

      const data = await response.json();

      if (data.hasChanges) {
        // Show confirmation dialog
        setCloseTicketId(ticketId);
        setCloseChangedFiles(
          data.files || { modified: [], created: [], deleted: [], staged: [] }
        );
        setCloseDialogOpen(true);
      } else {
        // No changes — clear UI immediately, remove worktree in background
        clearSession(ticketId);
        toast.success("Ticket closed", { description: "Worktree removed" });
        if (session.worktreePath) {
          removeWorktree(session.worktreePath);
        }
      }
    } catch (err) {
      console.error("[TicketList] Error checking git status:", err);
      // On error, just clear the session
      clearSession(ticketId);
    }
  };

  // Handler for close dialog confirmation
  const handleCloseConfirm = (removeWorktreeFlag: boolean) => {
    if (!closeTicketId) {
      return;
    }

    const session = getSession(closeTicketId);

    // Clear UI immediately
    if (session) {
      clearSession(closeTicketId);
    }

    // Fire-and-forget worktree cleanup
    if (removeWorktreeFlag) {
      const worktreePath =
        session?.worktreePath ?? workDirStatus[closeTicketId]?.path;
      if (worktreePath) {
        removeWorktree(worktreePath, true);
        if (!session) {
          setWorkDirStatus((prev) => {
            const next = { ...prev };
            delete next[closeTicketId];
            return next;
          });
        }
      }
      toast.success("Ticket closed", {
        description: "Worktree removed (changes discarded)",
      });
    } else {
      toast.success("Worktree kept", {
        description: "Your changes are preserved",
      });
    }

    setCloseTicketId(null);
  };

  // Handler for deleting a worktree from pending tickets (no active session)
  const handleDeleteWorktree = async (
    ticketId: string,
    worktreePath: string
  ) => {
    if (!worktreePath) {
      // Session has no worktreePath (e.g., plan-loop session created before
      // the worktree path fix). Just clear the session.
      clearSession(ticketId);
      toast.success("Session cleared");
      return;
    }
    try {
      // Check git status of the worktree
      const response = await fetch("/api/gateway/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "status",
          repoPath: worktreePath,
        }),
      });

      if (!response.ok) {
        // Can't check status, ask for confirmation anyway
        setCloseTicketId(ticketId);
        setCloseChangedFiles({
          modified: [],
          created: [],
          deleted: [],
          staged: [],
        });
        setCloseDialogOpen(true);
        return;
      }

      const data = await response.json();

      if (data.hasChanges) {
        // Show confirmation dialog with changed files
        setCloseTicketId(ticketId);
        setCloseChangedFiles(
          data.files || { modified: [], created: [], deleted: [], staged: [] }
        );
        setCloseDialogOpen(true);
      } else {
        // No changes, remove worktree directly
        await removeWorktree(worktreePath);
        // Update local state
        setWorkDirStatus((prev) => {
          const next = { ...prev };
          delete next[ticketId];
          return next;
        });
        toast.success("Worktree deleted");
      }
    } catch (err) {
      console.error("[TicketList] Error checking git status:", err);
      toast.error("Failed to check worktree status");
    }
  };

  // Handler for creating a PR
  const handleCreatePR = async (ticketId: string, repoPath: string) => {
    const ticket = tickets.find((t) => t.identifier === ticketId);
    if (!ticket) {
      return;
    }

    // Construct worktree path from base repo path
    // Worktree lives as a sibling: {parentDir}/{repoName}-{ticketId}
    const repoParts = repoPath.split("/");
    const repoName = repoParts.pop() || "";
    const parentDir = repoParts.join("/");
    const sanitizedTicket = ticketId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
    const worktreePath = `${parentDir}/${repoName}-${sanitizedTicket}`;

    setCreatingPR(ticketId);
    try {
      const response = await fetch("/api/gateway/git/pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoPath: worktreePath,
          title: `[${ticket.identifier}] ${ticket.title}`,
          body: ticket.description || "",
          ticketUrl: ticket.url,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to create PR");
      }

      // Save PR info to localStorage and update state
      saveTicketPR(ticketId, data.url, data.number, repoPath);
      setPrStatus((prev) => ({
        ...prev,
        [ticketId]: { url: data.url, number: data.number, repoPath },
      }));

      // Post comment: PR created (fire-and-forget)
      onPostComment?.(
        ticketId,
        `A pull request has been raised: ${data.url}\n\n-Closedloop.dev`
      ).catch(() => {});

      // Move ticket to "In Review" status
      if (onUpdateTicketStatus) {
        try {
          await onUpdateTicketStatus(ticketId, "In Review");
        } catch (err) {
          console.error("[TicketList] Failed to update ticket status:", err);
          // Don't fail the whole operation if status update fails
        }
      }

      toast.success("Pull request created", {
        description: `PR #${data.number} created`,
        action: {
          label: "View PR",
          onClick: () => globalThis.open(data.url, "_blank"),
        },
      });

      // Refresh tickets to show updated status
      onRefresh?.();
    } catch (err) {
      toast.error("Failed to create PR", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setCreatingPR(null);
    }
  };

  // Compute isDeployable per ticket from repos data
  const deployableRepos = useMemo(() => {
    const set = new Set<string>();
    if (reposData?.repos) {
      for (const repo of reposData.repos) {
        if (repo.deployment) {
          set.add(repo.path);
        }
      }
    }
    return set;
  }, [reposData]);

  // Build deployInfo prop for a ticket from localStorage state
  const getDeployInfoProp = (ticketId: string) => {
    const d = deployStatus[ticketId];
    if (d?.status === "deployed" && d.deployedUrl) {
      return {
        url: d.deployedUrl,
        deployedAt: d.deployedAt || "",
        status: d.status,
        healthCheckFailed: d.healthCheckFailed,
      };
    }
    return null;
  };

  // Check if a ticket's repo is deployable
  const isTicketDeployable = (ticketId: string): boolean => {
    const repoPath = getRepoPathForTicket(ticketId);
    return repoPath ? deployableRepos.has(repoPath) : false;
  };

  // Handler for deploy button
  const handleDeploy = (ticketId: string) => {
    const repoPath = getRepoPathForTicket(ticketId);
    if (!repoPath) {
      return;
    }

    setDeployTicketId(ticketId);
    setDeployDialogOpen(true);
  };

  // Handler for successful deployment
  const handleDeploySuccess = (
    ticketId: string,
    info: { url?: string; serviceId?: string }
  ) => {
    const deploy = getDeployment(ticketId);
    if (deploy) {
      setDeployStatus((prev) => ({
        ...prev,
        [ticketId]: { ...deploy, ...info, status: "deployed" as const },
      }));
    }
  };

  // Handler for teardown
  const handleTeardown = async (ticketId: string) => {
    const deploy = getDeployment(ticketId);
    if (!deploy) {
      return;
    }

    const repoPath = getRepoPathForTicket(ticketId);
    if (!repoPath) {
      return;
    }

    // Extract port from deployed URL as fallback
    let port: number | undefined;
    if (deploy.deployedUrl) {
      try {
        const parsed = new URL(deploy.deployedUrl);
        if (parsed.port) {
          port = Number.parseInt(parsed.port, 10);
        }
      } catch {
        // Invalid URL
      }
    }

    try {
      const response = await fetch("/api/gateway/deploy/teardown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoPath,
          worktreePath: deploy.worktreePath,
          serviceId: deploy.serviceId,
          pid: deploy.pid,
          port,
        }),
      });

      const data = await response.json();

      if (data.success) {
        updateDeployment(ticketId, { status: "torn-down" });
        clearDeployment(ticketId);
        setDeployStatus((prev) => ({ ...prev, [ticketId]: null }));
        toast.success("Dev server stopped");
      } else {
        toast.error("Failed to stop dev server", {
          description: data.error || "Process may have already exited",
        });
      }
    } catch {
      toast.error("Failed to stop dev server");
    }
  };

  // Handler for stopping a running Symphony process
  const handleStopSymphony = async (ticketId: string) => {
    const repoPath = getRepoPathForTicket(ticketId);
    if (!repoPath) {
      toast.error("Cannot stop process", {
        description: "Unable to determine repository path",
      });
      return;
    }

    const session = getSession(ticketId);

    try {
      // For sessions with a loopId (real plan-loop flow), cancel via the gateway.
      // The gateway cancels the Loop record in the DB and kills the local process.
      if (session?.loopId) {
        const response = await fetch(
          `/api/gateway/symphony/plan-loop/${encodeURIComponent(ticketId)}/cancel`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repoPath, loopId: session.loopId }),
          }
        );

        const data = (await response.json()) as {
          cancelled?: boolean;
          warning?: string;
          error?: string;
        };

        if (data.cancelled) {
          if (data.warning) {
            // cancel-pending: process liveness uncertain. Keep session but clear
            // loopId so the UI knows cancellation was requested. The session stays
            // visible until status polling confirms processRunning === false.
            // Persist to both in-memory state and sessions file so a page reload
            // doesn't resurrect the old loopId.
            mergeSessionFields(ticketId, { loopId: undefined });
            // Persist the cleared loopId to the sessions file.
            if (session.worktreePath) {
              fetch("/api/gateway/symphony/sessions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  ticketId,
                  repoPath,
                  worktreePath: session.worktreePath,
                  loopId: "",
                }),
              }).catch(() => {
                /* best-effort persist */
              });
            }
            toast.success("Cancel requested", {
              description:
                "Loop cancelled in database. Waiting for local process to stop.",
            });
          } else {
            // Clean cancel: process confirmed gone. Clear session entirely.
            await clearSession(ticketId);
            toast.success("ClosedLoop process stopped");
          }
          queryClient.invalidateQueries({
            queryKey: queryKeys.symphonyStatus(ticketId, repoPath),
          });
        } else {
          toast.error("Failed to cancel loop", {
            description: data.error || "Unknown error",
          });
        }
        return;
      }

      // Legacy path: PID-only kill for non-loop sessions
      const response = await fetch("/api/gateway/symphony/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId, repoPath }),
      });

      const data = await response.json();

      if (data.success) {
        toast.success("ClosedLoop process stopped");
        // Invalidate status query to update UI
        queryClient.invalidateQueries({
          queryKey: queryKeys.symphonyStatus(ticketId, repoPath),
        });
      } else {
        toast.error("Failed to stop process", {
          description: data.error || "Unknown error",
        });
      }
    } catch {
      toast.error("Failed to stop process");
    }
  };

  // Refs for scrolling to parent tickets
  const ticketRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Build stack relationship map from sessions
  const stackInfo = useMemo(() => {
    const parentMap = new Map<string, string>(); // ticketId -> parentTicketId
    const childrenMap = new Map<string, string[]>(); // ticketId -> childTicketIds

    for (const session of activeSessions) {
      if (session.parentTicketId) {
        parentMap.set(session.ticketId, session.parentTicketId);
      }
      const children = getChildTickets(session.ticketId, activeSessions);
      if (children.length > 0) {
        childrenMap.set(session.ticketId, children);
      }
    }

    return { parentMap, childrenMap };
  }, [activeSessions]);

  // Handler for clicking on parent ticket badge - scrolls to and highlights parent
  const handleParentClick = useCallback((parentTicketId: string) => {
    const parentElement = ticketRefs.current.get(parentTicketId);
    if (parentElement) {
      // Scroll into view
      parentElement.scrollIntoView({ behavior: "smooth", block: "center" });

      // Add highlight effect
      parentElement.classList.add("ring-2", "ring-primary", "ring-offset-2");
      setTimeout(() => {
        parentElement.classList.remove(
          "ring-2",
          "ring-primary",
          "ring-offset-2"
        );
      }, 2000);
    }
  }, []);

  // Loading state
  if (isLoading) {
    if (viewMode === "list") {
      return (
        <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/50 bg-card">
          {LIST_SKELETON_KEYS.map((skeletonKey) => (
            <TicketListRowSkeleton key={skeletonKey} />
          ))}
        </div>
      );
    }
    return (
      <div className="grid grid-cols-1 gap-4 sm:gap-6 md:grid-cols-2 lg:grid-cols-3">
        {GRID_SKELETON_KEYS.map((skeletonKey) => (
          <TicketCardSkeleton key={skeletonKey} />
        ))}
      </div>
    );
  }

  // Empty state
  if (tickets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-16 sm:px-6 sm:py-24">
        <div className="mb-6 flex size-16 items-center justify-center rounded-2xl bg-muted sm:size-20">
          <FileText className="size-8 text-muted-foreground sm:size-10" />
        </div>
        <h3 className="mb-2 font-medium text-xl sm:text-2xl">
          No tickets found
        </h3>
        <p className="max-w-md text-center text-muted-foreground text-sm sm:text-base">
          There are no tickets to display. Try adjusting your filters or check
          back later.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Active Work Section - shown when there are active sessions */}
      {activeTickets.length > 0 && (
        <section className="mb-8">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-medium text-muted-foreground text-sm uppercase tracking-wider">
              Active Work ({activeTickets.length})
            </h2>
          </div>

          {viewMode === "list" ? (
            <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/50 bg-card">
              {activeTickets.map((ticket) => (
                <div
                  key={ticket.id}
                  ref={(el) => {
                    if (el) {
                      ticketRefs.current.set(ticket.identifier, el);
                    } else {
                      ticketRefs.current.delete(ticket.identifier);
                    }
                  }}
                >
                  <TicketListRow
                    branchMerged={
                      workDirStatus[ticket.identifier]?.branchStatus?.merged
                    }
                    codexAvailable={codexAvailable}
                    deployInfo={getDeployInfoProp(ticket.identifier)}
                    hasPushed={pushedStatus[ticket.identifier]}
                    hasWorkDirectory={workDirStatus[ticket.identifier]?.exists}
                    isDeployable={isTicketDeployable(ticket.identifier)}
                    isDeploying={
                      deployStatus[ticket.identifier]?.status === "deploying"
                    }
                    isLaunching={launchingTickets.has(ticket.identifier)}
                    isRunning={!!getSession(ticket.identifier)?.pid}
                    isStarred={starredSet.has(ticket.identifier)}
                    onAskClaude={handleAskClaude}
                    onCodexReview={handleCodexReview}
                    onDeleteWorktree={handleDeleteWorktree}
                    onDeploy={handleDeploy}
                    onLearningsClick={handleLearningsClick}
                    onLinkPR={handleLinkPR}
                    onParentClick={handleParentClick}
                    onStartPlanning={
                      ticket.sourceType !== TicketSourceType.ImplementationPlan
                        ? handleStartPlanning
                        : undefined
                    }
                    onTeardown={handleTeardown}
                    onToggleStar={handleToggleStar}
                    onViewComments={handleViewComments}
                    parentTicketId={stackInfo.parentMap.get(ticket.identifier)}
                    pendingClaudeMdPath={
                      workDirStatus[ticket.identifier]?.pendingClaudeMd
                    }
                    prInfo={prStatus[ticket.identifier] || null}
                    ticket={ticket}
                    worktreePath={
                      workDirStatus[ticket.identifier]?.path || null
                    }
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {activeTickets.map((ticket) => {
                const session = getSession(ticket.identifier);
                const repoPath = session?.repoPath || null;
                const isLaunching = launchingTickets.has(ticket.identifier);
                const parentId = stackInfo.parentMap.get(ticket.identifier);
                const childIds = stackInfo.childrenMap.get(ticket.identifier);

                return (
                  <div
                    key={ticket.identifier}
                    ref={(el) => {
                      if (el) {
                        ticketRefs.current.set(ticket.identifier, el);
                      } else {
                        ticketRefs.current.delete(ticket.identifier);
                      }
                    }}
                  >
                    <ActiveTicketCard
                      branchMerged={
                        workDirStatus[ticket.identifier]?.branchStatus?.merged
                      }
                      childTicketIds={childIds}
                      codexAvailable={codexAvailable}
                      contextRepoPaths={session?.contextRepoPaths}
                      deployInfo={getDeployInfoProp(ticket.identifier)}
                      hasPushed={pushedStatus[ticket.identifier]}
                      hasWorkDirectory={
                        workDirStatus[ticket.identifier]?.exists
                      }
                      isCreatingPR={creatingPR === ticket.identifier}
                      isDeployable={isTicketDeployable(ticket.identifier)}
                      isDeploying={
                        deployStatus[ticket.identifier]?.status === "deploying"
                      }
                      isLaunching={isLaunching}
                      isResuming={resumingTicketId === ticket.identifier}
                      onClose={() => handleCloseTicket(ticket.identifier)}
                      onCodexReview={handleCodexReview}
                      onCommitPush={(ticketId) =>
                        handleCommitPush(ticketId, repoPath || undefined)
                      }
                      onCreatePR={
                        repoPath
                          ? (ticketId, rp) => handleCreatePR(ticketId, rp)
                          : undefined
                      }
                      onDeploy={handleDeploy}
                      onLearningsClick={handleLearningsClick}
                      onParentClick={handleParentClick}
                      onResume={
                        repoPath
                          ? async () => {
                              console.log("[TicketList] Accept Plan clicked", {
                                ticketId: ticket.identifier,
                                repoPath,
                              });
                              try {
                                const result = await launch(
                                  ticket.identifier,
                                  repoPath
                                );
                                if (result.launched && !result.alreadyRunning) {
                                  onPostComment?.(
                                    ticket.identifier,
                                    "Plan has been accepted and coding has started.\n\n-Closedloop.dev"
                                  ).catch(() => {});
                                  toast.success(
                                    "Closedloop.dev execution started",
                                    {
                                      description:
                                        "Check the logs for progress",
                                    }
                                  );
                                }
                              } catch (err) {
                                toast.error("Failed to launch Closedloop.dev", {
                                  description:
                                    err instanceof Error
                                      ? err.message
                                      : "Unknown error",
                                });
                              }
                            }
                          : undefined
                      }
                      onResumeExecution={
                        repoPath
                          ? async (ticketId) => {
                              setResumingTicketId(ticketId);
                              try {
                                const result = await launch(ticketId, repoPath);

                                if (result.launched && !result.alreadyRunning) {
                                  queryClient.setQueryData(
                                    queryKeys.symphonyStatus(
                                      ticketId,
                                      repoPath
                                    ),
                                    (
                                      old: SymphonyStatusResponse | undefined
                                    ) => ({
                                      ...old,
                                      exists: true,
                                      status: "STARTING",
                                    })
                                  );

                                  toast.success("Execution resumed", {
                                    description:
                                      "Closedloop.dev is re-running with updated plan",
                                  });
                                }
                              } catch (err) {
                                toast.error("Failed to resume execution", {
                                  description:
                                    err instanceof Error
                                      ? err.message
                                      : "Unknown error",
                                });
                              } finally {
                                setResumingTicketId(null);
                              }
                            }
                          : undefined
                      }
                      onStopSymphony={handleStopSymphony}
                      onTeardown={handleTeardown}
                      parentTicketId={parentId}
                      pendingClaudeMdPath={
                        workDirStatus[ticket.identifier]?.pendingClaudeMd
                      }
                      prInfo={prStatus[ticket.identifier] || null}
                      repoPath={repoPath}
                      sessionArtifactId={session?.documentId}
                      ticket={ticket}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Next Up Section - starred pending tickets */}
      {starredPendingTickets.length > 0 && (
        <section className="mb-8">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-medium text-muted-foreground text-sm uppercase tracking-wider">
              Next Up ({starredPendingTickets.length})
            </h2>
          </div>
          {viewMode === "list" ? (
            <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/50 bg-card">
              {starredPendingTickets.map((ticket) => (
                <TicketListRow
                  branchMerged={
                    workDirStatus[ticket.identifier]?.branchStatus?.merged
                  }
                  codexAvailable={codexAvailable}
                  deployInfo={getDeployInfoProp(ticket.identifier)}
                  hasPushed={pushedStatus[ticket.identifier]}
                  hasWorkDirectory={workDirStatus[ticket.identifier]?.exists}
                  isDeployable={isTicketDeployable(ticket.identifier)}
                  isDeploying={
                    deployStatus[ticket.identifier]?.status === "deploying"
                  }
                  isStarred={true}
                  key={ticket.id}
                  onAskClaude={handleAskClaude}
                  onCodexReview={handleCodexReview}
                  onDeleteWorktree={handleDeleteWorktree}
                  onDeploy={handleDeploy}
                  onLearningsClick={handleLearningsClick}
                  onLinkPR={handleLinkPR}
                  onStartPlanning={
                    ticket.sourceType !== TicketSourceType.ImplementationPlan
                      ? handleStartPlanning
                      : undefined
                  }
                  onTeardown={handleTeardown}
                  onToggleStar={handleToggleStar}
                  onViewComments={handleViewComments}
                  pendingClaudeMdPath={
                    workDirStatus[ticket.identifier]?.pendingClaudeMd
                  }
                  prInfo={prStatus[ticket.identifier] || null}
                  ticket={ticket}
                  worktreePath={workDirStatus[ticket.identifier]?.path || null}
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:gap-6 md:grid-cols-2 lg:grid-cols-3">
              {starredPendingTickets.map((ticket) => (
                <TicketCard
                  branchMerged={
                    workDirStatus[ticket.identifier]?.branchStatus?.merged
                  }
                  codexAvailable={codexAvailable}
                  deployInfo={getDeployInfoProp(ticket.identifier)}
                  hasPushed={pushedStatus[ticket.identifier]}
                  hasWorkDirectory={workDirStatus[ticket.identifier]?.exists}
                  isDeployable={isTicketDeployable(ticket.identifier)}
                  isDeploying={
                    deployStatus[ticket.identifier]?.status === "deploying"
                  }
                  isStarred={true}
                  key={ticket.id}
                  onAskClaude={handleAskClaude}
                  onCodexReview={handleCodexReview}
                  onDeleteWorktree={handleDeleteWorktree}
                  onDeploy={handleDeploy}
                  onLearningsClick={handleLearningsClick}
                  onLinkPR={handleLinkPR}
                  onStartPlanning={
                    ticket.sourceType !== TicketSourceType.ImplementationPlan
                      ? handleStartPlanning
                      : undefined
                  }
                  onTeardown={handleTeardown}
                  onToggleStar={handleToggleStar}
                  onViewComments={handleViewComments}
                  pendingClaudeMdPath={
                    workDirStatus[ticket.identifier]?.pendingClaudeMd
                  }
                  prInfo={prStatus[ticket.identifier] || null}
                  ticket={ticket}
                  worktreePath={workDirStatus[ticket.identifier]?.path || null}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* Pending Work Section */}
      {unstarredPendingTickets.length > 0 && (
        <section className="mb-8">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-medium text-muted-foreground text-sm uppercase tracking-wider">
              Pending Work ({unstarredPendingTickets.length})
            </h2>
          </div>
          {pendingPageCount > 1 && (
            <div className="mb-4 flex items-center justify-center gap-3">
              <button
                className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                disabled={pendingPage === 0}
                onClick={() => setPendingPage((p) => Math.max(0, p - 1))}
                type="button"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="text-muted-foreground text-xs tabular-nums">
                Page {pendingPage + 1} of {pendingPageCount}
              </span>
              <button
                className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                disabled={pendingPage >= pendingPageCount - 1}
                onClick={() =>
                  setPendingPage((p) => Math.min(pendingPageCount - 1, p + 1))
                }
                type="button"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          )}
          {viewMode === "list" ? (
            <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/50 bg-card">
              {paginatedPending.map((ticket) => (
                <TicketListRow
                  branchMerged={
                    workDirStatus[ticket.identifier]?.branchStatus?.merged
                  }
                  codexAvailable={codexAvailable}
                  deployInfo={getDeployInfoProp(ticket.identifier)}
                  hasPushed={pushedStatus[ticket.identifier]}
                  hasWorkDirectory={workDirStatus[ticket.identifier]?.exists}
                  isDeployable={isTicketDeployable(ticket.identifier)}
                  isDeploying={
                    deployStatus[ticket.identifier]?.status === "deploying"
                  }
                  isStarred={starredSet.has(ticket.identifier)}
                  key={ticket.id}
                  onAskClaude={handleAskClaude}
                  onCodexReview={handleCodexReview}
                  onDeleteWorktree={handleDeleteWorktree}
                  onDeploy={handleDeploy}
                  onLearningsClick={handleLearningsClick}
                  onLinkPR={handleLinkPR}
                  onStartPlanning={
                    ticket.sourceType !== TicketSourceType.ImplementationPlan
                      ? handleStartPlanning
                      : undefined
                  }
                  onTeardown={handleTeardown}
                  onToggleStar={handleToggleStar}
                  onViewComments={handleViewComments}
                  pendingClaudeMdPath={
                    workDirStatus[ticket.identifier]?.pendingClaudeMd
                  }
                  prInfo={prStatus[ticket.identifier] || null}
                  ticket={ticket}
                  worktreePath={workDirStatus[ticket.identifier]?.path || null}
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:gap-6 md:grid-cols-2 lg:grid-cols-3">
              {paginatedPending.map((ticket) => (
                <TicketCard
                  branchMerged={
                    workDirStatus[ticket.identifier]?.branchStatus?.merged
                  }
                  codexAvailable={codexAvailable}
                  deployInfo={getDeployInfoProp(ticket.identifier)}
                  hasPushed={pushedStatus[ticket.identifier]}
                  hasWorkDirectory={workDirStatus[ticket.identifier]?.exists}
                  isDeployable={isTicketDeployable(ticket.identifier)}
                  isDeploying={
                    deployStatus[ticket.identifier]?.status === "deploying"
                  }
                  isStarred={starredSet.has(ticket.identifier)}
                  key={ticket.id}
                  onAskClaude={handleAskClaude}
                  onCodexReview={handleCodexReview}
                  onDeleteWorktree={handleDeleteWorktree}
                  onDeploy={handleDeploy}
                  onLearningsClick={handleLearningsClick}
                  onLinkPR={handleLinkPR}
                  onStartPlanning={
                    ticket.sourceType !== TicketSourceType.ImplementationPlan
                      ? handleStartPlanning
                      : undefined
                  }
                  onTeardown={handleTeardown}
                  onToggleStar={handleToggleStar}
                  onViewComments={handleViewComments}
                  pendingClaudeMdPath={
                    workDirStatus[ticket.identifier]?.pendingClaudeMd
                  }
                  prInfo={prStatus[ticket.identifier] || null}
                  ticket={ticket}
                  worktreePath={workDirStatus[ticket.identifier]?.path || null}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* Done toggle — standalone row between Pending and Done sections */}
      {completedTickets.length > 0 && (
        <div className="my-6 flex justify-center">
          <button
            className={cn(
              "group flex cursor-pointer items-center gap-2 rounded-full px-3 py-1.5 font-medium text-xs transition-all duration-200",
              "border",
              showCompleted
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-border bg-transparent text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground"
            )}
            onClick={() => {
              const next = !showCompleted;
              setShowCompleted(next);
              localStorage.setItem("show-completed-tickets", String(next));
            }}
            type="button"
          >
            <span
              className={cn(
                "size-1.5 rounded-full transition-colors",
                showCompleted ? "bg-emerald-500" : "bg-muted-foreground/40"
              )}
            />
            <span>{completedTickets.length} Done</span>
            <span
              className={cn(
                "transition-transform duration-200",
                showCompleted ? "rotate-180" : ""
              )}
            >
              <svg
                aria-hidden="true"
                className="opacity-60"
                fill="none"
                height="10"
                viewBox="0 0 10 10"
                width="10"
              >
                <path
                  d="M2.5 4L5 6.5L7.5 4"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.5"
                />
              </svg>
            </span>
          </button>
        </div>
      )}

      {/* Done Work Section */}
      {showCompleted && completedTickets.length > 0 && (
        <section className="fade-in slide-in-from-bottom-4 mt-12 animate-in duration-300">
          <div className="mb-6 flex items-center gap-4">
            <div className="h-px flex-1 bg-gradient-to-r from-transparent via-border to-transparent" />
            <span className="flex items-center gap-2 font-medium text-muted-foreground/70 text-xs uppercase tracking-wider">
              <svg
                aria-hidden="true"
                className="text-emerald-500/60"
                fill="none"
                height="12"
                viewBox="0 0 12 12"
                width="12"
              >
                <path
                  d="M10 3L4.5 8.5L2 6"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.5"
                />
              </svg>
              Completed
            </span>
            <div className="h-px flex-1 bg-gradient-to-r from-transparent via-border to-transparent" />
          </div>
          {donePageCount > 1 && (
            <div className="mb-4 flex items-center justify-center gap-3">
              <button
                className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                disabled={donePage === 0}
                onClick={() => setDonePage((p) => Math.max(0, p - 1))}
                type="button"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="text-muted-foreground text-xs tabular-nums">
                Page {donePage + 1} of {donePageCount}
              </span>
              <button
                className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                disabled={donePage >= donePageCount - 1}
                onClick={() =>
                  setDonePage((p) => Math.min(donePageCount - 1, p + 1))
                }
                type="button"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          )}
          {viewMode === "list" ? (
            <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/50 bg-card opacity-60 transition-opacity duration-200 hover:opacity-100">
              {paginatedDone.map((ticket) => (
                <TicketListRow
                  branchMerged={
                    workDirStatus[ticket.identifier]?.branchStatus?.merged
                  }
                  codexAvailable={codexAvailable}
                  deployInfo={getDeployInfoProp(ticket.identifier)}
                  hasPushed={pushedStatus[ticket.identifier]}
                  hasWorkDirectory={workDirStatus[ticket.identifier]?.exists}
                  isDeployable={isTicketDeployable(ticket.identifier)}
                  isDeploying={
                    deployStatus[ticket.identifier]?.status === "deploying"
                  }
                  key={ticket.id}
                  onAskClaude={handleAskClaude}
                  onCodexReview={handleCodexReview}
                  onDeleteWorktree={handleDeleteWorktree}
                  onDeploy={handleDeploy}
                  onLearningsClick={handleLearningsClick}
                  onReopen={handleReopenTicket}
                  onTeardown={handleTeardown}
                  onViewComments={handleViewComments}
                  pendingClaudeMdPath={
                    workDirStatus[ticket.identifier]?.pendingClaudeMd
                  }
                  prInfo={prStatus[ticket.identifier] || null}
                  ticket={ticket}
                  worktreePath={workDirStatus[ticket.identifier]?.path || null}
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:gap-6 md:grid-cols-2 lg:grid-cols-3">
              {paginatedDone.map((ticket) => (
                <div
                  className="opacity-60 transition-opacity duration-200 hover:opacity-100"
                  key={ticket.id}
                >
                  <TicketCard
                    branchMerged={
                      workDirStatus[ticket.identifier]?.branchStatus?.merged
                    }
                    codexAvailable={codexAvailable}
                    deployInfo={getDeployInfoProp(ticket.identifier)}
                    hasPushed={pushedStatus[ticket.identifier]}
                    hasWorkDirectory={workDirStatus[ticket.identifier]?.exists}
                    isDeployable={isTicketDeployable(ticket.identifier)}
                    isDeploying={
                      deployStatus[ticket.identifier]?.status === "deploying"
                    }
                    onAskClaude={handleAskClaude}
                    onCodexReview={handleCodexReview}
                    onDeleteWorktree={handleDeleteWorktree}
                    onDeploy={handleDeploy}
                    onLearningsClick={handleLearningsClick}
                    onReopen={handleReopenTicket}
                    onTeardown={handleTeardown}
                    onViewComments={handleViewComments}
                    pendingClaudeMdPath={
                      workDirStatus[ticket.identifier]?.pendingClaudeMd
                    }
                    prInfo={prStatus[ticket.identifier] || null}
                    ticket={ticket}
                    worktreePath={
                      workDirStatus[ticket.identifier]?.path || null
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {selectedTicketId && (
        <CommitDialog
          onOpenChange={setCommitDialogOpen}
          onSuccess={handleCommitSuccess}
          open={commitDialogOpen}
          repoPath={selectedRepoPath}
          ticketId={selectedTicketId}
        />
      )}

      {(pendingPlanTicketId || pendingTicketChatTicketId) && (
        <RepoPickerDialog
          onConfirm={(
            repoPath,
            additionalContext,
            contextRepoPaths,
            mentionedFiles,
            baseBranch
          ) => {
            if (pendingTicketChatTicketId) {
              // For ticket chat - no additional context, just repo selection
              handleTicketChatRepoSelected(repoPath);
            } else {
              // For planning - pass through to existing handler
              handleRepoSelected(
                repoPath,
                additionalContext,
                contextRepoPaths,
                mentionedFiles,
                baseBranch
              );
            }
          }}
          onOpenChange={(open) => {
            setRepoPickerOpen(open);
            if (!open) {
              setPendingPlanTicketId(null);
              setPendingTicketChatTicketId(null);
            }
          }}
          open={repoPickerOpen}
          skipContextStep={!!pendingTicketChatTicketId}
          ticketIdentifier={
            pendingPlanTicketId || pendingTicketChatTicketId || ""
          }
        />
      )}

      {closeTicketId && (
        <CloseTicketDialog
          changedFiles={closeChangedFiles}
          onConfirmClose={handleCloseConfirm}
          onOpenChange={setCloseDialogOpen}
          open={closeDialogOpen}
          ticketId={closeTicketId}
        />
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            // Dismissing clears picker state; user can retry Start Planning
            clearPendingDocuments();
          }
        }}
        open={pendingDocuments !== null && pendingDocuments.length > 0}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Select Implementation Plan</DialogTitle>
            <DialogDescription>
              This feature has multiple linked plans. Select which one to use
              for planning.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {pendingDocuments?.map((doc) => (
              <Button
                className="h-auto w-full justify-start whitespace-normal text-left"
                key={doc.id}
                onClick={() => selectDocument(doc.id)}
                variant="outline"
              >
                {doc.title}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {ticketChatTicket && ticketChatRepoPath && (
        <TicketChatDialog
          initialMessage={ticketChatInitialMessage}
          onOpenChange={(open) => {
            setTicketChatOpen(open);
            if (!open) {
              // Clear state when dialog closes
              setTicketChatRepoPath(null);
              setTicketChatRepoBehindBy(0);
              setTicketChatInitialMessage(undefined);
            }
          }}
          open={ticketChatOpen}
          repoBehindBy={ticketChatRepoBehindBy}
          repoPath={ticketChatRepoPath}
          ticket={ticketChatTicket}
        />
      )}

      {deployTicketId &&
        (() => {
          const repoPath = getRepoPathForTicket(deployTicketId) || "";
          const repoName = repoPath.split("/").pop() || "";
          const sanitizedTicket = deployTicketId.replaceAll(
            /[^a-zA-Z0-9-_]/g,
            "_"
          );
          const worktreePath = repoPath
            ? `${repoPath.replace(/\/[^/]+$/, "")}/${repoName}-${sanitizedTicket}`
            : "";
          const existingConflict = getActiveDeploymentForRepo(repoName);
          const conflict =
            existingConflict && existingConflict.ticketId !== deployTicketId
              ? {
                  ticketId: existingConflict.ticketId,
                  url: existingConflict.deployedUrl,
                }
              : null;

          return (
            <DeployDialog
              existingDeployment={conflict}
              onOpenChange={(open) => {
                setDeployDialogOpen(open);
                if (!open) {
                  setDeployTicketId(null);
                }
              }}
              onSuccess={(info) => handleDeploySuccess(deployTicketId, info)}
              open={deployDialogOpen}
              repoName={repoName}
              repoPath={repoPath}
              ticketId={deployTicketId}
              worktreePath={worktreePath}
            />
          );
        })()}

      {codexReviewTicketId && codexReviewRepoPath && (
        <CodexReviewDialog
          onOpenChange={(open) => {
            setCodexReviewOpen(open);
            if (!open) {
              setCodexReviewTicketId(null);
              setCodexReviewRepoPath(null);
            }
          }}
          open={codexReviewOpen}
          repoPath={codexReviewRepoPath}
          ticketId={codexReviewTicketId}
        />
      )}

      {linkPRTicketId && (
        <LinkPRDialog
          onLinked={handlePRLinked}
          onOpenChange={(open) => {
            setLinkPROpen(open);
            if (!open) {
              setLinkPRTicketId(null);
            }
          }}
          open={linkPROpen}
          ticketId={linkPRTicketId}
        />
      )}

      {commentViewTicketId && prStatus[commentViewTicketId] && (
        <SymphonyChat
          initialTab="comments"
          isOpen={commentViewOpen}
          onClose={() => {
            setCommentViewOpen(false);
            setCommentViewTicketId(null);
          }}
          prInfo={prStatus[commentViewTicketId]}
          repoPath={
            prStatus[commentViewTicketId]!.repoPath ||
            getRepoPathForTicket(commentViewTicketId) ||
            ""
          }
          ticketId={commentViewTicketId}
          ticketTitle={
            tickets.find((t) => t.identifier === commentViewTicketId)?.title
          }
        />
      )}
    </>
  );
}
