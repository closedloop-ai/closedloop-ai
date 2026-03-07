"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Ticket details to pass to Symphony
 */
export type TicketDetails = {
  identifier: string;
  title: string;
  description?: string;
  url: string;
  additionalContext?: string;
  contextRepoPaths?: string[];
  mentionedFiles?: { repoPath: string; filePath: string }[];
};

/**
 * Active session from the sessions API
 */
export type ActiveSession = {
  ticketId: string;
  repoPath: string;
  worktreePath: string;
  pid?: number;
  contextRepoPaths?: string[];
  /** The branch this worktree was created from (e.g., "main" or "feature/AI-100") */
  baseBranch?: string;
  /** If stacked on another ticket's branch, the parent ticket ID (e.g., "AI-100") */
  parentTicketId?: string;
  startedAt?: string;
  lastAccessedAt?: string;
};

/**
 * Result from the useSymphonyLaunch hook
 * Supports multiple active sessions simultaneously
 */
export type UseSymphonyLaunchResult = {
  // Multiple sessions
  activeSessions: ActiveSession[];

  // Per-ticket status tracking
  launchingTickets: Set<string>;

  // Actions
  launch: (
    ticketIdentifier: string,
    repoPath: string,
    ticket?: TicketDetails,
    baseBranch?: string
  ) => Promise<void>;
  clearSession: (ticketId: string) => void;
  clearAllSessions: () => void;

  // Helpers
  isActive: (ticketId: string) => boolean;
  getSession: (ticketId: string) => ActiveSession | undefined;

  // Error state
  error: string | null;
};

/**
 * Hook to launch Symphony run-loop.sh script for tickets.
 * Sessions are persisted to ~/.symphony/sessions.json via API.
 * Supports multiple active sessions simultaneously.
 */
export function useSymphonyLaunch(): UseSymphonyLaunchResult {
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [launchingTickets, setLaunchingTickets] = useState<Set<string>>(
    new Set()
  );
  const [error, setError] = useState<string | null>(null);

  // Load all sessions from API on mount
  useEffect(() => {
    fetch("/api/engineer/symphony/sessions")
      .then((res) => res.json())
      .then((data) => {
        const sessions: ActiveSession[] = data.sessions || [];
        setActiveSessions(sessions);
      })
      .catch((err) => {
        console.error("[useSymphonyLaunch] Failed to load sessions:", err);
      });
  }, []);

  // Helper: check if a ticket is active
  const isActive = useCallback(
    (ticketId: string) => activeSessions.some((s) => s.ticketId === ticketId),
    [activeSessions]
  );

  // Helper: get session for a ticket
  const getSession = useCallback(
    (ticketId: string) => activeSessions.find((s) => s.ticketId === ticketId),
    [activeSessions]
  );

  // Launch Symphony for a ticket
  const launch = useCallback(
    async (
      ticketIdentifier: string,
      repoPath: string,
      ticket?: TicketDetails,
      baseBranch?: string
    ) => {
      console.log("[useSymphonyLaunch] launch called", {
        ticketIdentifier,
        repoPath,
        baseBranch,
      });

      // Mark as launching
      setLaunchingTickets((prev) => new Set(prev).add(ticketIdentifier));
      setError(null);

      try {
        console.log(
          "[useSymphonyLaunch] Making POST to /api/engineer/symphony/launch"
        );
        const response = await fetch("/api/engineer/symphony/launch", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ticketIdentifier,
            repoPath,
            ticket,
            baseBranch,
          }),
        });

        const data = await response.json();
        console.log("[useSymphonyLaunch] Response:", { ok: response.ok, data });

        if (!response.ok) {
          throw new Error(data.error || "Failed to launch Symphony");
        }

        // Save session to ~/.symphony/sessions.json via API
        // Local handler returns `workDir`, Electron relay returns `worktreePath`.
        const resolvedWorktreePath = data.workDir ?? data.worktreePath;
        const contextRepoPaths = ticket?.contextRepoPaths;
        await fetch("/api/engineer/symphony/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticketId: ticketIdentifier,
            repoPath,
            worktreePath: resolvedWorktreePath,
            pid: data.pid,
            contextRepoPaths,
            baseBranch: data.baseBranch,
            parentTicketId: data.parentTicketId,
          }),
        });

        // Add to local state (or update if already exists)
        const newSession: ActiveSession = {
          ticketId: ticketIdentifier,
          repoPath,
          worktreePath: resolvedWorktreePath,
          pid: data.pid,
          contextRepoPaths,
          baseBranch: data.baseBranch,
          parentTicketId: data.parentTicketId,
        };
        setActiveSessions((prev) => {
          const filtered = prev.filter((s) => s.ticketId !== ticketIdentifier);
          return [...filtered, newSession];
        });
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error occurred";
        setError(errorMessage);
        throw err;
      } finally {
        // Remove from launching set
        setLaunchingTickets((prev) => {
          const next = new Set(prev);
          next.delete(ticketIdentifier);
          return next;
        });
      }
    },
    []
  );

  // Clear a specific session and kill the associated process
  const clearSession = useCallback(
    (ticketId: string) => {
      // Find the session to get the PID
      const session = activeSessions.find((s) => s.ticketId === ticketId);

      // Kill the process if we have a PID
      if (session?.pid) {
        fetch("/api/engineer/symphony/kill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pid: session.pid }),
        }).catch((err) => {
          console.error("[useSymphonyLaunch] Failed to kill process:", err);
        });
      }

      // Remove from API
      fetch(
        `/api/engineer/symphony/sessions?ticketId=${encodeURIComponent(ticketId)}`,
        {
          method: "DELETE",
        }
      ).catch((err) => {
        console.error("[useSymphonyLaunch] Failed to delete session:", err);
      });

      // Remove from local state
      setActiveSessions((prev) => prev.filter((s) => s.ticketId !== ticketId));
    },
    [activeSessions]
  );

  // Clear all sessions and kill all associated processes
  const clearAllSessions = useCallback(() => {
    // Kill processes and remove each session from API
    activeSessions.forEach((session) => {
      // Kill the process if we have a PID
      if (session.pid) {
        fetch("/api/engineer/symphony/kill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pid: session.pid }),
        }).catch((err) => {
          console.error("[useSymphonyLaunch] Failed to kill process:", err);
        });
      }

      fetch(
        `/api/engineer/symphony/sessions?ticketId=${encodeURIComponent(session.ticketId)}`,
        {
          method: "DELETE",
        }
      ).catch((err) => {
        console.error("[useSymphonyLaunch] Failed to delete session:", err);
      });
    });

    // Clear local state
    setActiveSessions([]);
    setError(null);
  }, [activeSessions]);

  // Memoize the launchingTickets set to avoid creating new references
  const stableLaunchingTickets = useMemo(
    () => launchingTickets,
    [launchingTickets]
  );

  return {
    activeSessions,
    launchingTickets: stableLaunchingTickets,
    launch,
    clearSession,
    clearAllSessions,
    isActive,
    getSession,
    error,
  };
}
