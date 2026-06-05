"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type UpdateStatus = {
  isUpdateAvailable: boolean;
  behindBy: number;
  currentBranch: string;
  trackingBranch: string | null;
};

type UseUpdateCheckerResult = {
  isUpdateAvailable: boolean;
  behindBy: number;
  dismissed: boolean;
  pulling: boolean;
  dismiss: () => void;
  pullUpdate: () => Promise<{ ok: boolean; error?: string }>;
};

const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

export function useUpdateChecker(): UseUpdateCheckerResult {
  const [status, setStatus] = useState<UpdateStatus>({
    isUpdateAvailable: false,
    behindBy: 0,
    currentBranch: "",
    trackingBranch: null,
  });
  const [dismissed, setDismissed] = useState(false);
  const [pulling, setPulling] = useState(false);
  const dismissedForRef = useRef<number>(0); // behindBy count that was dismissed

  const check = useCallback(async () => {
    try {
      const res = await fetch("/api/engineer/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync-status" }),
      });
      if (!res.ok) {
        return;
      }
      const data = await res.json();

      setStatus({
        isUpdateAvailable: data.behindBy > 0,
        behindBy: data.behindBy,
        currentBranch: data.currentBranch,
        trackingBranch: data.trackingBranch,
      });

      // If the behind count changed since dismiss, re-show
      if (data.behindBy > 0 && data.behindBy !== dismissedForRef.current) {
        setDismissed(false);
      }
    } catch {
      // Silently ignore — this is a background check
    }
  }, []);

  const pullUpdate = useCallback(async (): Promise<{
    ok: boolean;
    error?: string;
  }> => {
    setPulling(true);
    try {
      const res = await fetch("/api/engineer/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pull" }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus((prev) => ({
          ...prev,
          isUpdateAvailable: false,
          behindBy: 0,
        }));
        setDismissed(false);
        dismissedForRef.current = 0;
        return { ok: true };
      }
      return { ok: false, error: data.error };
    } catch {
      return { ok: false, error: "Network error" };
    } finally {
      setPulling(false);
    }
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    dismissedForRef.current = status.behindBy;
  }, [status.behindBy]);

  useEffect(() => {
    // Initial check after a short delay so it doesn't compete with page load
    const initialTimeout = setTimeout(check, 3000);
    const interval = setInterval(check, POLL_INTERVAL);

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
    };
  }, [check]);

  return {
    isUpdateAvailable: status.isUpdateAvailable,
    behindBy: status.behindBy,
    dismissed,
    pulling,
    dismiss,
    pullUpdate,
  };
}
