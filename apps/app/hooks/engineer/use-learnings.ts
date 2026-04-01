"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type UseLearningsOptions = {
  ticketId: string;
  repoPath: string;
  activeTab?: string;
};

type UseLearningsReturn = {
  status: "none" | "processing" | "completed";
  count: number;
  poll: () => void;
  triggerExtract: (chatFile?: string) => void;
  handleClose: () => void;
  stopPolling: () => void;
};

export function useLearnings({
  ticketId,
  repoPath,
  activeTab,
}: Readonly<UseLearningsOptions>): UseLearningsReturn {
  const selfLearningEnabled =
    useFeatureFlag("self-learning")?.enabled !== false;
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState<"none" | "processing" | "completed">(
    "none"
  );
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const poll = useCallback(() => {
    stopPolling();
    setStatus("processing");

    pollingRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/engineer/symphony/learnings-status/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`
        );
        const data = await res.json();
        if (data.status === "completed") {
          setStatus("completed");
          setCount(data.count || 0);
          stopPolling();
        } else if (data.status === "error") {
          setStatus("none");
          stopPolling();
        }
      } catch {
        // Ignore polling errors
      }
    }, 3000);

    // Stop polling after 2 minutes max; reset status if still processing
    setTimeout(() => {
      stopPolling();
      setStatus((prev) => (prev === "processing" ? "none" : prev));
    }, 120_000);
  }, [ticketId, repoPath, stopPolling]);

  const triggerExtract = useCallback(
    (chatFile?: string) => {
      if (!selfLearningEnabled) {
        return;
      }
      setStatus("processing");
      toast("Collecting learnings for this ticket...", {
        description: ticketId,
      });
      fetch("/api/engineer/symphony/extract-learnings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId, repoPath, activeTab, chatFile }),
      })
        .then(() => {
          poll();
        })
        .catch((err) => {
          console.error("Failed to trigger learning extraction:", err);
          setStatus("none");
          toast.error("Failed to extract learnings");
        });
    },
    [selfLearningEnabled, ticketId, repoPath, activeTab, poll]
  );

  const handleClose = useCallback(() => {
    stopPolling();

    if (!selfLearningEnabled) {
      setCount(0);
      setStatus("none");
      return;
    }

    if (count > 0) {
      toast(
        `Processing ${count} learning${count === 1 ? "" : "s"} from ${ticketId}...`,
        {
          icon: "\u{1F9E0}",
        }
      );
      fetch("/api/engineer/symphony/process-learnings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId, repoPath }),
      }).catch((err) => {
        console.error("Failed to trigger learnings processing:", err);
      });
    } else if (status === "processing") {
      toast(
        "Learnings extraction in progress \u2014 processing will start when done.",
        {
          icon: "\u{1F9E0}",
        }
      );
      fetch("/api/engineer/symphony/process-learnings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId, repoPath, waitForExtraction: true }),
      }).catch((err) => {
        console.error("Failed to queue learnings processing:", err);
      });
    }

    // Notify the page header to start pulsing the brain icon
    if (count > 0 || status === "processing") {
      globalThis.dispatchEvent(
        new CustomEvent("learnings-processing", {
          detail: { ticketId, repoPath },
        })
      );
    }

    // Reset learnings state so stale counts don't show on next open
    setCount(0);
    setStatus("none");
  }, [selfLearningEnabled, ticketId, repoPath, count, status, stopPolling]);

  // Cleanup polling on unmount
  useEffect(() => stopPolling, [stopPolling]);

  return { status, count, poll, triggerExtract, handleClose, stopPolling };
}
