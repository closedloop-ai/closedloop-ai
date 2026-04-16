/* eslint-disable react-hooks/set-state-in-effect */
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Rocket,
  RotateCcw,
  Square,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  saveDeployment,
  updateDeployment,
} from "@/lib/engineer/deploy-tracker";
import {
  type DeployStatusResponse,
  deployStatusOptions,
} from "@/lib/engineer/queries/deploy";
import { queryKeys } from "@/lib/engineer/queries/keys";

type DeployDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketId: string;
  repoPath: string;
  worktreePath: string;
  repoName: string;
  existingDeployment?: { ticketId: string; url?: string } | null;
  onSuccess: (info: { url?: string; serviceId?: string }) => void;
};

type DialogPhase =
  | "confirm"
  | "conflict"
  | "deploying"
  | "extracting"
  | "success"
  | "failed";

export function DeployDialog({
  open,
  onOpenChange,
  ticketId,
  repoPath,
  worktreePath,
  repoName,
  existingDeployment,
  onSuccess,
}: Readonly<DeployDialogProps>) {
  const [phase, setPhase] = useState<DialogPhase>(
    existingDeployment ? "conflict" : "confirm"
  );
  const [pid, setPid] = useState<number | null>(null);
  const [deployedUrl, setDeployedUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deployType, setDeployType] = useState<string | null>(null);
  const logEndRef = useRef<HTMLPreElement>(null);
  const queryClient = useQueryClient();

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setPhase(existingDeployment ? "conflict" : "confirm");
      setPid(null);
      setDeployedUrl(null);
      setErrorMessage(null);
      setDeployType(null);
      // Clear cached deploy status so stale logs from a previous run don't show
      queryClient.removeQueries({
        queryKey: queryKeys.deployStatus(ticketId, repoPath),
      });
    }
  }, [open, existingDeployment, queryClient, ticketId, repoPath]);

  // Poll deploy status while deploying
  const { data: statusData } = useQuery({
    ...deployStatusOptions(ticketId, repoPath, pid ?? undefined),
    refetchInterval: phase === "deploying" ? 2000 : false,
    enabled: phase === "deploying" && !!pid,
  });

  // Auto-scroll logs
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollTop = logEndRef.current.scrollHeight;
    }
  }, []);

  const handleDeployComplete = useCallback(
    async (data: DeployStatusResponse) => {
      setPhase("extracting");

      try {
        const response = await fetch("/api/gateway/deploy/extract-info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoPath, logs: data.logs || "" }),
        });

        if (response.ok) {
          const info = await response.json();
          setDeployedUrl(info.url || null);

          updateDeployment(ticketId, {
            status: "deployed",
            deployedUrl: info.url,
            serviceId: info.serviceId,
            deployedAt: new Date().toISOString(),
          });

          setPhase("success");
          onSuccess({ url: info.url, serviceId: info.serviceId });
        } else {
          // Extraction failed but deployment succeeded
          updateDeployment(ticketId, {
            status: "deployed",
            deployedAt: new Date().toISOString(),
          });
          setPhase("success");
          onSuccess({});
        }
      } catch {
        updateDeployment(ticketId, {
          status: "deployed",
          deployedAt: new Date().toISOString(),
        });
        setPhase("success");
        onSuccess({});
      }
    },
    [repoPath, ticketId, onSuccess]
  );

  // React to status changes
  useEffect(() => {
    if (phase !== "deploying" || !statusData) {
      return;
    }

    if (statusData.status === "completed") {
      handleDeployComplete(statusData);
    } else if (statusData.status === "failed") {
      setPhase("failed");
      setErrorMessage(statusData.error || "Deployment failed");
      updateDeployment(ticketId, { status: "failed" });
    }
  }, [statusData, phase, handleDeployComplete, ticketId]);

  const startDeploy = async () => {
    setPhase("deploying");
    setErrorMessage(null);

    try {
      const response = await fetch("/api/gateway/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId, repoPath, worktreePath }),
      });

      const data = await response.json();

      if (!response.ok) {
        setPhase("failed");
        setErrorMessage(data.error || "Failed to start deployment");
        return;
      }

      setPid(data.pid);
      setDeployType(data.deployType);

      // Save initial deploy state
      saveDeployment(ticketId, {
        ticketId,
        worktreePath,
        repoName,
        status: "deploying",
        pid: data.pid,
      });
    } catch (err) {
      setPhase("failed");
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to start deployment"
      );
    }
  };

  const handleTeardownAndDeploy = async () => {
    if (!existingDeployment) {
      return;
    }

    try {
      await fetch("/api/gateway/deploy/teardown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath, worktreePath }),
      });
    } catch {
      // Best effort teardown
    }

    await startDeploy();
  };

  const handleStopDeploy = async () => {
    if (!pid) {
      return;
    }

    try {
      await fetch("/api/gateway/deploy/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid }),
      });

      setPhase("failed");
      setErrorMessage("Deployment stopped by user");
      updateDeployment(ticketId, { status: "failed" });
    } catch {
      toast.error("Failed to stop deployment");
    }
  };

  const handleRetry = async () => {
    // Re-detect deployment config in case it changed
    await fetch("/api/gateway/deploy/redetect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPath }),
    });

    // Invalidate repos query so UI picks up new config
    queryClient.invalidateQueries({ queryKey: queryKeys.repos() });

    await startDeploy();
  };

  const handleClose = (newOpen: boolean) => {
    if (phase === "deploying") {
      return; // Don't close while deploying
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      <DialogContent className="overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="size-5" />
            Deploy {ticketId}
            {deployType && (
              <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium font-mono text-[10px] text-primary uppercase tracking-wider">
                {deployType}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {phase === "confirm" && `Deploy ${repoName} from this worktree`}
            {phase === "conflict" &&
              "Another worktree has an active deployment for this repo"}
            {phase === "deploying" && "Deployment in progress..."}
            {phase === "extracting" && "Extracting deployment information..."}
            {phase === "success" && "Deployment completed successfully"}
            {phase === "failed" && "Deployment failed"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Conflict banner */}
          {phase === "conflict" && existingDeployment && (
            <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" />
              <div className="space-y-1 text-sm">
                <p className="font-medium text-amber-700 dark:text-amber-400">
                  Active deployment from {existingDeployment.ticketId}
                </p>
                {existingDeployment.url && (
                  <p className="truncate text-muted-foreground">
                    {existingDeployment.url}
                  </p>
                )}
                <p className="text-muted-foreground">
                  Deploying will tear down the existing deployment first.
                </p>
              </div>
            </div>
          )}

          {/* Log viewer */}
          {(phase === "deploying" ||
            phase === "failed" ||
            phase === "success") &&
            statusData?.logs && (
              <pre
                className="max-h-[400px] overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-muted/30 p-4 font-mono text-muted-foreground text-xs leading-relaxed"
                ref={logEndRef}
              >
                {statusData.logs}
              </pre>
            )}

          {/* Extracting spinner */}
          {phase === "extracting" && (
            <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span className="text-sm">Extracting deployment URL...</span>
            </div>
          )}

          {/* Success result */}
          {phase === "success" && (
            <div className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
              <CheckCircle2 className="size-5 shrink-0 text-emerald-500" />
              <div className="min-w-0 space-y-1 text-sm">
                <p className="font-medium text-emerald-700 dark:text-emerald-400">
                  Deployment successful
                </p>
                {deployedUrl && (
                  <a
                    className="inline-flex items-center gap-1 truncate text-primary hover:underline"
                    href={deployedUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {deployedUrl}
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                )}
              </div>
            </div>
          )}

          {/* Failure result */}
          {phase === "failed" && (
            <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <XCircle className="size-5 shrink-0 text-destructive" />
              <div className="text-sm">
                <p className="font-medium text-destructive">
                  {errorMessage || "Deploy failed"}
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {phase === "confirm" && (
            <>
              <Button onClick={() => onOpenChange(false)} variant="outline">
                Cancel
              </Button>
              <Button onClick={startDeploy}>
                <Rocket className="mr-2 size-4" />
                Deploy
              </Button>
            </>
          )}

          {phase === "conflict" && (
            <>
              <Button onClick={() => onOpenChange(false)} variant="outline">
                Cancel
              </Button>
              <Button onClick={handleTeardownAndDeploy} variant="destructive">
                <AlertTriangle className="mr-2 size-4" />
                Tear Down & Deploy
              </Button>
            </>
          )}

          {phase === "deploying" && (
            <Button onClick={handleStopDeploy} variant="destructive">
              <Square className="mr-2 size-4" />
              Stop Deploy
            </Button>
          )}

          {phase === "success" && (
            <Button onClick={() => onOpenChange(false)} variant="outline">
              Close
            </Button>
          )}

          {phase === "failed" && (
            <>
              <Button onClick={() => onOpenChange(false)} variant="outline">
                Close
              </Button>
              <Button onClick={handleRetry}>
                <RotateCcw className="mr-2 size-4" />
                Retry
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
