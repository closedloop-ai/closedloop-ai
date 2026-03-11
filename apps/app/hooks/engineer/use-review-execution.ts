"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ReviewConfig } from "@/components/engineer/CodexReviewSettingsDialog";
import type {
  ReviewFinding,
  ReviewVerdict,
} from "@/lib/engineer/codex-review-parser";
import {
  checkExistingReview,
  markFindingCommented,
  markReviewDeclined,
  postDeclineComment,
  saveReviewFindings,
} from "@/lib/engineer/review-findings-api";
import {
  buildCommentBody,
  resolveFindingPath,
  resolveFullPath,
  stripWorktreePath,
} from "@/lib/engineer/review-path-utils";
import {
  type AnnotatedFinding,
  splitReviewOutput,
} from "@/lib/engineer/review-split";
import { streamReviewOutput } from "@/lib/engineer/review-stream";

const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped"]);

type UseReviewExecutionParams = {
  ticketId: string;
  repoPath: string;
  prNumber: number;
  branchName: string;
  config: ReviewConfig;
  initialOutput?: string;
  commitSha?: string;
  prFiles?: string[];
  duplicateIndices?: Set<number>;
  prCommentDupIndices?: Set<number>;
  onReviewComplete?: (
    output: string,
    findingCount: number,
    findings?: ReviewFinding[]
  ) => void;
  onStructuredFindings?: (findings: ReviewFinding[]) => void;
  onAllCommented?: () => void;
};

type UseReviewExecutionReturn = {
  // State
  reviewOutput: string;
  isReviewing: boolean;
  reviewDone: boolean;
  reviewCommand: string | null;
  reviewContextPercent: number | null;
  effectiveVerdict: ReviewVerdict | null;
  hasDeclineVerdict: boolean;
  showFindings: boolean;
  declined: boolean;
  findingsRevealed: boolean;
  isSubmittingDecline: boolean;
  submittedFindings: Set<number>;
  submittingFindings: Set<number>;
  reviewSplit: {
    processLog: string;
    findings: AnnotatedFinding[];
    verdict?: ReviewVerdict;
  } | null;
  reviewStartedAt: string;
  // Actions
  handleStopReview: () => Promise<void>;
  handleDecline: () => Promise<void>;
  handleSubmitComment: (index: number, finding: ReviewFinding) => Promise<void>;
  setFindingsRevealed: (v: boolean) => void;
};

export function useReviewExecution(
  params: UseReviewExecutionParams
): UseReviewExecutionReturn {
  const {
    ticketId,
    repoPath,
    prNumber,
    branchName,
    config,
    initialOutput,
    commitSha,
    prFiles,
    duplicateIndices,
    prCommentDupIndices,
    onReviewComplete,
    onStructuredFindings,
    onAllCommented,
  } = params;

  // Phase 1: review streaming
  const [reviewOutput, setReviewOutput] = useState(initialOutput ?? "");
  const [isReviewing, setIsReviewing] = useState(!initialOutput);
  const [reviewDone, setReviewDone] = useState(!!initialOutput);
  const abortRef = useRef<AbortController | null>(null);
  const [submittedFindings, setSubmittedFindings] = useState<Set<number>>(
    new Set()
  );
  const [submittingFindings, setSubmittingFindings] = useState<Set<number>>(
    new Set()
  );
  const [declined, setDeclined] = useState(false);
  const [findingsRevealed, setFindingsRevealed] = useState(false);
  const [isSubmittingDecline, setIsSubmittingDecline] = useState(false);
  const [asyncVerdict, setAsyncVerdict] = useState<ReviewVerdict | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const findingsSavedRef = useRef(false);
  const [reviewCommand, setReviewCommand] = useState<string | null>(null);
  const [reviewContextPercent, setReviewContextPercent] = useState<
    number | null
  >(null);

  // Refs for parent callbacks — avoids depending on callback identity in effects
  const onReviewCompleteRef = useRef(onReviewComplete);
  onReviewCompleteRef.current = onReviewComplete;
  const onStructuredFindingsRef = useRef(onStructuredFindings);
  onStructuredFindingsRef.current = onStructuredFindings;

  // Guard against StrictMode double-mount
  const hasStartedRef = useRef(false);
  const reviewStartedAtRef = useRef(
    initialOutput ? new Date().toISOString() : ""
  );

  // Fetch persisted findings to restore commented status
  const findingsUrl = `/api/engineer/codex/review-findings/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=${encodeURIComponent(config.provider)}`;
  const { data: savedFindings } = useQuery<{
    findings: Array<{ commented: boolean }>;
    declined?: boolean;
    declineReason?: string;
  }>({
    queryKey: ["review-findings", ticketId, repoPath, config.provider],
    queryFn: () => fetch(findingsUrl).then((r) => r.json()),
    enabled: reviewDone,
  });

  // Sync submitted findings and declined status from persisted data
  useEffect(() => {
    if (!savedFindings?.findings) {
      return;
    }
    const commented = new Set<number>();
    savedFindings.findings.forEach((f, i) => {
      if (f.commented) {
        commented.add(i);
      }
    });
    if (commented.size > 0) {
      setSubmittedFindings((prev) => {
        const merged = new Set(prev);
        for (const i of commented) {
          merged.add(i);
        }
        return merged;
      });
    }
    if (savedFindings.declined) {
      setDeclined(true);
    }
  }, [savedFindings]);

  // Split completed review output into thinking (process log) + findings
  const reviewSplit = useMemo(() => {
    if (!(reviewDone && reviewOutput)) {
      return null;
    }
    const split = splitReviewOutput(reviewOutput, config.provider);
    const annotated = split.findings.map((f, i) => ({
      ...f,
      originalIndex: i,
    }));
    const filtered =
      prFiles && prFiles.length > 0
        ? annotated.filter((f) => {
            if (!f.file) {
              return true;
            }
            const short = stripWorktreePath(f.file);
            const resolved = resolveFullPath(short, prFiles);
            return resolved !== null && resolved !== "ambiguous";
          })
        : annotated;
    return {
      processLog: split.processLog,
      findings: filtered,
      verdict: split.verdict,
    };
  }, [reviewDone, reviewOutput, config.provider, prFiles]);

  // Notify parent when all findings have been individually commented (fire once)
  const allCommentedFiredRef = useRef(false);
  useEffect(() => {
    if (!reviewSplit || reviewSplit.findings.length === 0) {
      return;
    }
    if (
      reviewSplit.findings.every((f) =>
        submittedFindings.has(f.originalIndex)
      ) &&
      !allCommentedFiredRef.current
    ) {
      allCommentedFiredRef.current = true;
      onAllCommented?.();
    }
  }, [submittedFindings.size, reviewSplit, onAllCommented]);

  // Notify parent when restoring a previous review + persist findings if missing
  useEffect(() => {
    if (!initialOutput) {
      return;
    }
    const split = splitReviewOutput(initialOutput, config.provider);
    onReviewCompleteRef.current?.(
      initialOutput,
      split.findings.length,
      split.findings
    );
    if (split.findings.length > 0 && !findingsSavedRef.current) {
      findingsSavedRef.current = true;
      saveReviewFindings(
        ticketId,
        repoPath,
        config.provider,
        config.model,
        split.findings
      );
    }
  }, [config.model, config.provider, initialOutput, repoPath, ticketId]);

  /** Split output, notify callback, persist findings. Returns the split result. */
  function finalizeReviewOutput(output: string) {
    setReviewOutput(output);
    setReviewDone(true);
    const split = splitReviewOutput(output, config.provider);
    onReviewCompleteRef.current?.(
      output,
      split.findings.length,
      split.findings
    );
    if (split.findings.length > 0) {
      findingsSavedRef.current = true;
      saveReviewFindings(
        ticketId,
        repoPath,
        config.provider,
        config.model,
        split.findings
      );
    }
    return split;
  }

  /** Post-stream Claude-specific work: seed session ID, trigger extraction & verdict. */
  function handlePostStreamActions(
    split: ReturnType<typeof splitReviewOutput>
  ) {
    if (config.provider === "claude" && sessionIdRef.current) {
      fetch(
        `/api/engineer/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=claude`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sessionIdRef.current }),
        }
      ).catch((err) =>
        console.warn("[review] Failed to seed session ID:", err)
      );
    }

    if (
      config.provider === "claude" &&
      split.findings.length > 0 &&
      sessionIdRef.current
    ) {
      triggerExtraction(sessionIdRef.current);
    }

    if (!split.verdict && sessionIdRef.current) {
      triggerVerdictExtraction(sessionIdRef.current);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-shadow -- startReview is hoisted and used in the mount effect
  async function startReview(signal: AbortSignal) {
    reviewStartedAtRef.current = new Date().toISOString();
    setIsReviewing(true);
    setReviewDone(false);
    let accumulatedOutput = "";

    try {
      const existing = await checkExistingReview(
        ticketId,
        repoPath,
        config.provider,
        signal
      );

      if (existing.kind === "completed" || existing.kind === "terminal") {
        finalizeReviewOutput(existing.log);
        return;
      }

      if (existing.kind === "running") {
        setReviewOutput(existing.log);
        await pollRunningReview(signal);
        return;
      }

      setReviewOutput("");

      const response = await fetch(
        `/api/engineer/codex/review/${encodeURIComponent(ticketId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instructions: config.instructions || undefined,
            model: config.model,
            reasoningEffort: config.reasoningEffort,
            reviewMode: config.reviewMode,
            baseBranch: "main",
            repoPath,
            branchName,
            provider: config.provider || "codex",
            useBaseRepo: config.useBaseRepo || undefined,
          }),
          signal,
        }
      );

      console.log(
        "[review-stream] POST response:",
        response.status,
        "body?",
        !!response.body,
        "headers:",
        Object.fromEntries(response.headers.entries())
      );

      if (response.status === 409) {
        console.log("[review-stream] 409 — falling back to poll");
        await pollRunningReview(signal);
        return;
      }
      if (!response.ok) {
        const errBody = await response.json().catch(() => null);
        throw new Error(
          errBody?.error ?? `Failed to start review: ${response.status}`
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      console.log("[review-stream] Starting stream read");
      const { text: accumulated, completed } = await streamReviewOutput(
        reader,
        (text) => {
          accumulatedOutput = text;
          setReviewOutput(text);
        },
        (sid) => {
          sessionIdRef.current = sid;
        },
        setReviewCommand,
        setReviewContextPercent
      );
      console.log(
        "[review-stream] Stream ended, accumulated:",
        accumulated.length,
        "chars, completed:",
        completed
      );

      if (!completed) {
        console.log(
          "[review-stream] Stream ended without done event — falling back to poll"
        );
        setReviewOutput(accumulated);
        await pollRunningReview(signal);
        return;
      }

      const split = finalizeReviewOutput(accumulated);
      toast.success("Code review completed");
      handlePostStreamActions(split);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setReviewDone(true);
        onReviewCompleteRef.current?.(accumulatedOutput, 0);
        return;
      }
      console.error("Review error:", err);
      toast.error("Failed to run review", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
      setReviewDone(true);
      onReviewCompleteRef.current?.(accumulatedOutput, 0);
    } finally {
      setIsReviewing(false);
      abortRef.current = null;
    }
  }

  const handleTerminalPollStatus = (
    data: { status: string; log?: string },
    accumulatedOutput: string
  ) => {
    const finalOutput = data.log || accumulatedOutput;
    const split = finalizeReviewOutput(finalOutput);
    if (data.status === "completed") {
      toast.success("Code review completed");
    }
    if (!split.verdict && sessionIdRef.current) {
      triggerVerdictExtraction(sessionIdRef.current);
    }
  };

  const pollRunningReview = async (signal: AbortSignal) => {
    const statusUrl = `/api/engineer/codex/status/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=${encodeURIComponent(config.provider)}`;
    let pollCount = 0;
    let lastKnownOutput = "";
    console.log("[poll] Starting poll for running review");
    while (!signal.aborted) {
      try {
        pollCount++;
        const res = await fetch(statusUrl, { signal });
        const data = await res.json();
        console.log(
          `[poll] #${pollCount}: status=${data.status}, log length=${data.log?.length ?? 0}, hasReview=${data.hasReview}`
        );

        if (data.log) {
          setReviewOutput(data.log);
          lastKnownOutput = data.log;
        }

        if (data.sessionId && !sessionIdRef.current) {
          sessionIdRef.current = data.sessionId;
        }

        if (TERMINAL_STATUSES.has(data.status)) {
          console.log(
            `[poll] Terminal status: ${data.status}, log: ${data.log?.length ?? 0} chars`
          );
          handleTerminalPollStatus(data, lastKnownOutput);
          return;
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          console.log("[poll] Aborted");
          return;
        }
        console.log("[poll] Error:", err);
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      });
    }
  };

  const handleStopReview = useCallback(async () => {
    abortRef.current?.abort();
    try {
      const response = await fetch(
        `/api/engineer/codex/stop/${encodeURIComponent(ticketId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: repoPath, provider: config.provider }),
        }
      );
      toast[response.ok ? "success" : "error"](
        response.ok ? "Review stopped" : "Failed to stop review"
      );
    } catch {
      toast.error("Failed to stop review");
    }
  }, [ticketId, repoPath, config.provider]);

  // Start the review on mount (skip if restoring a previous result)
  useEffect(() => {
    if (initialOutput) {
      return;
    }
    if (hasStartedRef.current) {
      return; // StrictMode re-mount — stream is already active
    }
    hasStartedRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    startReview(controller.signal);
    // NOTE: no cleanup abort — the stream continues across StrictMode re-mounts.
    // The Stop button calls handleStopReview which aborts via abortRef.
  }, [initialOutput]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmitComment = useCallback(
    async (index: number, finding: ReviewFinding) => {
      if (duplicateIndices?.has(index) || prCommentDupIndices?.has(index)) {
        return;
      }
      setSubmittingFindings((prev) => new Set(prev).add(index));

      const filePath = resolveFindingPath(finding, commitSha, prFiles);
      const body = buildCommentBody(finding, filePath);

      try {
        const response = await fetch("/api/engineer/git/pr/inline-comment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoPath,
            prNumber,
            body,
            path: filePath,
            line: filePath && finding.line ? finding.line : undefined,
            commitSha: filePath ? commitSha : undefined,
          }),
        });

        if (response.ok) {
          setSubmittedFindings((prev) => new Set(prev).add(index));
          markFindingCommented(ticketId, repoPath, config.provider, index);
          toast.success("Comment posted");
        } else {
          const data = await response.json();
          toast.error("Failed to post comment", { description: data.error });
        }
      } catch {
        toast.error("Failed to post comment");
      } finally {
        setSubmittingFindings((prev) => {
          const next = new Set(prev);
          next.delete(index);
          return next;
        });
      }
    },
    [
      ticketId,
      repoPath,
      prNumber,
      commitSha,
      config.provider,
      duplicateIndices,
      prCommentDupIndices,
      prFiles,
    ]
  );

  const triggerExtraction = useCallback(
    async (sid: string) => {
      try {
        console.log(
          `[review-extract] Triggering extraction with session ${sid}`
        );
        const res = await fetch(
          `/api/engineer/codex/review-extract/${encodeURIComponent(ticketId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repoPath, sessionId: sid }),
          }
        );
        const data = await res.json();
        if (data.findings && data.findings.length > 0) {
          console.log(
            `[review-extract] Got ${data.findings.length} structured findings`
          );
          onStructuredFindingsRef.current?.(data.findings);
          saveReviewFindings(
            ticketId,
            repoPath,
            config.provider,
            config.model,
            data.findings
          );
        } else {
          console.log(
            "[review-extract] No structured findings returned",
            data.error ?? ""
          );
        }
      } catch (err) {
        console.warn("[review-extract] Extraction failed silently:", err);
      }
    },
    [ticketId, repoPath, config.provider, config.model]
  );

  const triggerVerdictExtraction = useCallback(
    async (sid: string) => {
      try {
        console.log(
          `[review-verdict] Triggering verdict extraction with session ${sid}`
        );
        const res = await fetch(
          `/api/engineer/codex/review-verdict/${encodeURIComponent(ticketId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repoPath,
              sessionId: sid,
              provider: config.provider,
            }),
          }
        );
        if (!res.ok) {
          console.warn("[review-verdict] Server error:", res.status);
          return;
        }
        const data = await res.json();
        if (data.verdict) {
          console.log(
            `[review-verdict] Got verdict: ${data.verdict.verdict} — ${data.verdict.reason}`
          );
          setAsyncVerdict(data.verdict);
        } else {
          console.log("[review-verdict] No verdict returned", data.error ?? "");
        }
      } catch (err) {
        console.warn("[review-verdict] Extraction failed silently:", err);
      }
    },
    [ticketId, repoPath, config.provider]
  );

  const effectiveVerdict = asyncVerdict ?? reviewSplit?.verdict ?? null;
  const hasDeclineVerdict = effectiveVerdict?.verdict === "decline";
  const showFindings = !hasDeclineVerdict || (!declined && findingsRevealed);

  const handleDecline = useCallback(async () => {
    const reason = asyncVerdict?.reason ?? reviewSplit?.verdict?.reason;
    if (!reason) {
      return;
    }
    setIsSubmittingDecline(true);
    try {
      await markReviewDeclined(ticketId, repoPath, config.provider, reason);
      await postDeclineComment(repoPath, prNumber, reason);
      setDeclined(true);
      setFindingsRevealed(false);
      toast.success("Decline comment posted to PR");
    } catch {
      toast.error("Failed to post decline comment");
    } finally {
      setIsSubmittingDecline(false);
    }
  }, [
    asyncVerdict?.reason,
    reviewSplit?.verdict?.reason,
    repoPath,
    prNumber,
    ticketId,
    config.provider,
  ]);

  return {
    reviewOutput,
    isReviewing,
    reviewDone,
    reviewCommand,
    reviewContextPercent,
    effectiveVerdict,
    hasDeclineVerdict,
    showFindings,
    declined,
    findingsRevealed,
    isSubmittingDecline,
    submittedFindings,
    submittingFindings,
    reviewSplit,
    reviewStartedAt: reviewStartedAtRef.current,
    handleStopReview,
    handleDecline,
    handleSubmitComment,
    setFindingsRevealed,
  };
}
