"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Home, LayoutGrid, List, MessageCircle, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { HeaderOverflowMenu } from "@/components/engineer/HeaderOverflowMenu";
import { LearningsDialog } from "@/components/engineer/LearningsDialog";
import { TerminalChatDialog } from "@/components/engineer/TerminalChatDialog";
import { TicketList } from "@/components/engineer/TicketList";
import { useEngineerIssues } from "@/hooks/engineer/use-engineer-issues";
import { useFeatureSeen } from "@/hooks/engineer/use-feature-seen";
import { useTerminalStatus } from "@/hooks/engineer/useTerminalStatus";
import { terminalBus } from "@/lib/engineer/terminal-bus";
import type { EngineerTicket } from "@/types/engineer";
import { ComputeTargetSelector } from "./compute-target-selector";

export function EngineerDashboard() {
  const router = useRouter();
  const {
    tickets,
    isLoading,
    isFetching,
    error,
    user,
    updateTicketStatus,
    getFullTicket,
    postComment,
    refetch,
  } = useEngineerIssues();

  const [learningsOpen, setLearningsOpen] = useState(false);
  const [terminalChatOpen, setTerminalChatOpen] = useState(false);

  // View mode (grid/list) persisted in localStorage
  const viewModeKey = "ticket-view-mode";
  const viewModeSubscribe = useCallback((cb: () => void) => {
    const handler = (e: StorageEvent) => {
      if (e.key === viewModeKey) {
        cb();
      }
    };
    globalThis.addEventListener("storage", handler);
    return () => globalThis.removeEventListener("storage", handler);
  }, []);
  const viewModeSnapshot = useCallback(
    () => (localStorage.getItem(viewModeKey) as "grid" | "list") || "grid",
    []
  );
  const viewModeServerSnapshot = useCallback(() => "grid" as const, []);
  const viewMode = useSyncExternalStore(
    viewModeSubscribe,
    viewModeSnapshot,
    viewModeServerSnapshot
  );
  const setViewMode = useCallback(
    (updater: (prev: "grid" | "list") => "grid" | "list") => {
      const next = updater(viewModeSnapshot());
      localStorage.setItem(viewModeKey, next);
      globalThis.dispatchEvent(
        new StorageEvent("storage", { key: viewModeKey })
      );
    },
    [viewModeSnapshot]
  );
  const { seen: listViewSeen, markSeen: markListViewSeen } =
    useFeatureSeen("list-view");

  const [processingLearnings, setProcessingLearnings] = useState<{
    ticketId: string;
    repoPath: string;
  } | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Listen for the custom event from SymphonyChat
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        ticketId: string;
        repoPath: string;
      };
      setProcessingLearnings(detail);
      terminalBus.send("processing learnings...", { persistId: "learnings" });
    };
    globalThis.addEventListener("learnings-processing", handler);
    return () =>
      globalThis.removeEventListener("learnings-processing", handler);
  }, []);

  // Poll processing status while processingLearnings is set
  useEffect(() => {
    if (!processingLearnings) {
      return;
    }

    // Batch processing status polling is handled by the dialog itself
    if (processingLearnings.ticketId === "__batch__") {
      return;
    }

    const { ticketId, repoPath } = processingLearnings;

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/engineer/symphony/process-learnings?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}`
        );
        const data = await res.json();
        if (data.status === "completed") {
          setProcessingLearnings(null);
          terminalBus.clear("learnings");
          terminalBus.send("learnings processed", { prefix: "ok" });
        } else if (data.status === "error") {
          setProcessingLearnings(null);
          terminalBus.clear("learnings");
          terminalBus.send("learnings processing failed", { prefix: "err" });
        }
      } catch {
        // Ignore polling errors
      }
    };

    poll();
    pollingRef.current = setInterval(poll, 3000);

    const timeout = setTimeout(() => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      setProcessingLearnings(null);
      terminalBus.clear("learnings");
    }, 120_000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      clearTimeout(timeout);
    };
  }, [processingLearnings]);

  const handleProcessPending = useCallback(async () => {
    try {
      const res = await fetch("/api/engineer/symphony/process-all-learnings", {
        method: "POST",
      });
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      if (data.status !== "processing") {
        return;
      }
      setProcessingLearnings({ ticketId: "__batch__", repoPath: "" });
      terminalBus.send("processing all learnings...", {
        persistId: "learnings",
      });
    } catch {
      // Ignore errors — dialog handles status
    }
  }, []);

  const handleBatchProcessingComplete = useCallback(() => {
    setProcessingLearnings(null);
    terminalBus.clear("learnings");
    terminalBus.send("learnings processed", { prefix: "ok" });
  }, []);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="container mx-auto px-2 py-10 sm:px-6 sm:py-16 md:px-8">
        {/* Header */}
        <header className="mb-10 flex flex-wrap items-start justify-between gap-4 sm:mb-12">
          <div className="w-full sm:w-auto">
            <div className="overflow-hidden rounded-lg border border-border sm:inline-block sm:min-w-[320px]">
              <div className="flex items-center gap-1.5 border-border border-b bg-muted/50 px-3 py-1.5">
                <span className="size-2 rounded-full bg-red-400" />
                <span className="size-2 rounded-full bg-yellow-400" />
                <span className="size-2 rounded-full bg-green-400" />
                <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                  ~/engineer
                </span>
              </div>
              <div className="space-y-1 px-4 py-3">
                <div className="font-[family-name:var(--font-pixel)] text-foreground text-lg leading-none">
                  Closedloop.dev
                </div>
                <p className="mt-1 text-muted-foreground text-xs tracking-wide">
                  AI-assisted development workspace
                </p>
                <div className="font-mono text-xs">
                  <TerminalStatus tickets={tickets} user={user} />
                </div>
              </div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <ComputeTargetSelector />
            <Button
              className="gap-2"
              onClick={() => router.push("/")}
              size="sm"
              variant="outline"
            >
              <Home className="size-4" />
              Home
            </Button>
            <Button
              className="size-10 cursor-pointer rounded-full"
              disabled={isLoading}
              onClick={async () => {
                toast("Syncing issues...");
                await refetch();
                toast.success("Issues refreshed");
              }}
              size="icon"
              title="Refresh issues"
              variant="ghost"
            >
              <RefreshCw
                className={`size-4 ${isFetching ? "animate-spin" : ""}`}
              />
            </Button>
            <button
              aria-label={
                viewMode === "grid"
                  ? "Switch to list view"
                  : "Switch to grid view"
              }
              className="relative flex size-10 cursor-pointer items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-300 ease-out hover:scale-105 hover:border-primary/30 hover:text-primary hover:shadow-md focus:outline-none focus-visible:border-transparent focus-visible:ring-[3px] focus-visible:ring-primary/50 active:scale-95"
              onClick={() => {
                markListViewSeen();
                setViewMode((prev) => (prev === "grid" ? "list" : "grid"));
              }}
              title={viewMode === "grid" ? "List view" : "Grid view"}
              type="button"
            >
              {viewMode === "grid" ? (
                <List className="size-[18px]" strokeWidth={1.5} />
              ) : (
                <LayoutGrid className="size-[18px]" strokeWidth={1.5} />
              )}
              {!listViewSeen && (
                <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-emerald-400" />
              )}
            </button>
            <HeaderOverflowMenu
              isProcessingLearnings={!!processingLearnings}
              onOpenLearnings={() => setLearningsOpen(true)}
            />
          </div>
        </header>

        {/* Error state with retry */}
        {error && (
          <div className="mb-8 rounded-xl border border-destructive/20 bg-destructive/10 p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="text-destructive">
                <p className="font-semibold">Error loading issues</p>
                <p className="mt-1 text-sm opacity-80">{error.message}</p>
              </div>
              <Button
                className="shrink-0 gap-2 border-destructive/30 text-destructive hover:bg-destructive/10"
                onClick={() => refetch()}
                size="sm"
                variant="outline"
              >
                <RefreshCw className="size-4" />
                Retry
              </Button>
            </div>
          </div>
        )}

        {/* Main content */}
        <main>
          <TicketList
            getFullTicket={getFullTicket}
            isLoading={isLoading}
            onPostComment={postComment}
            onRefresh={refetch}
            onUpdateTicketStatus={updateTicketStatus}
            tickets={tickets}
            viewMode={viewMode}
          />
        </main>
      </div>
      <LearningsDialog
        isProcessingLearnings={!!processingLearnings}
        onBatchProcessingComplete={handleBatchProcessingComplete}
        onOpenChange={setLearningsOpen}
        onProcessPending={handleProcessPending}
        open={learningsOpen}
      />
      <TerminalChatDialog
        onOpenChange={setTerminalChatOpen}
        open={terminalChatOpen}
      />
      {/* Floating chat button */}
      <div className="group fixed right-6 bottom-6 z-50">
        <span className="absolute inset-0 rounded-full bg-violet-500 opacity-0 transition-opacity group-hover:animate-ping group-hover:opacity-40" />
        <button
          aria-label="Open chat"
          className="relative flex size-12 cursor-pointer items-center justify-center rounded-full bg-violet-600 text-white shadow-lg shadow-violet-900/50 transition-all hover:scale-105 hover:bg-violet-500 hover:shadow-violet-700/60 active:scale-95"
          onClick={() => setTerminalChatOpen(true)}
          type="button"
        >
          <MessageCircle className="size-5" />
        </button>
      </div>
    </div>
  );
}

function TerminalStatus({
  tickets,
  user,
}: Readonly<{
  tickets: EngineerTicket[];
  user: { name: string; email: string } | null;
}>) {
  const {
    displayText,
    prefix: statusPrefix,
    phase,
    isTypewriter,
    persistentMsg,
  } = useTerminalStatus();

  if (tickets.length === 0 && !user) {
    return <div className="text-muted-foreground/60">$ loading issues...</div>;
  }

  function statusClassName() {
    if (isTypewriter) {
      return "text-muted-foreground";
    }
    if (phase === "entering") {
      return "text-muted-foreground translate-y-0 opacity-100 transition-all duration-200";
    }
    if (phase === "exiting") {
      return "text-muted-foreground -translate-y-2 opacity-0 transition-all duration-300";
    }
    return "text-muted-foreground";
  }

  return (
    <>
      {persistentMsg && (
        <div className="text-muted-foreground">
          <span className="text-muted-foreground/50">$</span>{" "}
          <span className="animate-pulse text-amber-400">
            {persistentMsg.text}
          </span>
        </div>
      )}
      <div className="flex h-5 items-center gap-1.5 overflow-hidden">
        <span className="text-muted-foreground/50">$</span>
        {displayText === null ? (
          <span className="animate-pulse text-muted-foreground/30">_</span>
        ) : (
          <span className={statusClassName()}>
            {statusPrefix && (
              <span className="text-violet-400">[{statusPrefix}] </span>
            )}
            {displayText}
            {isTypewriter && <span className="animate-pulse">_</span>}
          </span>
        )}
      </div>
    </>
  );
}
