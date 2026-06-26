import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@closedloop-ai/design-system/components/ui/dialog";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InstallRunRecord } from "../../../shared/agent-db-contract";
import { cx } from "../layout/page-shell";

export type InstallModalProps = {
  open: boolean;
  onClose: () => void;
  packId: string;
  harness: string;
  action: "install" | "uninstall";
  runId: number | null;
  /** Command that was or will be executed (for display only). */
  command?: string | null;
};

export function InstallModal({
  open,
  onClose,
  packId,
  harness,
  action,
  runId,
  command,
}: InstallModalProps) {
  const [lines, setLines] = useState<Array<{ type: string; data: string }>>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new output
  useEffect(() => {
    if (lines.length === 0) {
      return;
    }
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines.length]);

  // Subscribe to streamed install output via IPC
  useEffect(() => {
    if (!open || runId == null) {
      return;
    }
    setLines([]);
    setExitCode(null);
    setDone(false);

    const unsubscribe = window.desktopApi.onInstallOutput?.((payload) => {
      if (payload.runId !== runId) {
        return;
      }

      if (payload.type === "complete") {
        const code = extractExitCode(payload.data);
        setDone(true);
        setExitCode(code);
        return;
      }

      const rendered = formatOutputPayload(payload.type, payload.data);
      if (!rendered) {
        return;
      }
      setLines((prev) => [...prev, { type: payload.type, data: rendered }]);
    });

    return () => {
      unsubscribe?.();
    };
  }, [open, runId]);

  // Fallback: poll install runs if the IPC stream is not wired yet
  useEffect(() => {
    if (!open || runId == null || done) {
      return;
    }
    // Only poll if onInstallOutput is not available
    if (window.desktopApi.onInstallOutput) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const runs: InstallRunRecord[] =
          await window.desktopApi.db.getInstallRuns(packId);
        const run = runs.find((r) => r.id === runId);
        if (run?.endedAt) {
          setExitCode(run.exitCode);
          if (run.stdoutTail) {
            setLines([{ type: "stdout", data: run.stdoutTail }]);
          }
          if (run.stderrTail) {
            setLines((prev) => [
              ...prev,
              { type: "stderr", data: run.stderrTail! },
            ]);
          }
          setDone(true);
        }
      } catch {
        // ignore poll errors
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [open, runId, packId, done]);

  const handleClose = useCallback(() => {
    setLines([]);
    setExitCode(null);
    setDone(false);
    onClose();
  }, [onClose]);

  const title =
    action === "install"
      ? `Installing ${packId} (${harness})`
      : `Uninstalling ${packId} (${harness})`;

  const success = done && (exitCode === 0 || exitCode == null);
  const failed = done && exitCode != null && exitCode !== 0;

  return (
    <Dialog onOpenChange={(v) => !v && handleClose()} open={open}>
      <DialogContent className="max-w-xl" showCloseButton>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {!done && <Loader2 className="h-4 w-4 animate-spin" />}
            {success && (
              <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
            )}
            {failed && (
              <XCircle className="h-4 w-4 text-[var(--destructive)]" />
            )}
            {title}
          </DialogTitle>
          <DialogDescription>
            {done
              ? success
                ? `${action === "install" ? "Installation" : "Uninstallation"} completed successfully.`
                : `Process exited with code ${exitCode}.`
              : `Running ${action}...`}
          </DialogDescription>
        </DialogHeader>

        {/* Command preview */}
        {command && (
          <div className="rounded-md border border-[var(--border)] bg-[var(--muted)] px-3 py-2 font-mono text-xs">
            $ {command}
          </div>
        )}

        {/* Scrolling output */}
        <div
          className="max-h-64 overflow-auto rounded-md border border-[var(--border)] bg-[var(--background)] p-3 font-mono text-xs leading-5"
          ref={scrollRef}
        >
          {lines.length === 0 && !done && (
            <span className="text-[var(--muted-foreground)]">
              Waiting for output...
            </span>
          )}
          {lines.map((line, i) => (
            <div
              className={cx(
                "whitespace-pre-wrap break-all",
                line.type === "stderr" && "text-[var(--destructive)]"
              )}
              key={i}
            >
              {line.data}
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button onClick={handleClose} variant={done ? "default" : "outline"}>
            {done ? "Close" : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function extractExitCode(data: unknown): number | null {
  if (typeof data === "number" && Number.isFinite(data)) {
    return data;
  }
  if (typeof data === "string") {
    const parsed = Number.parseInt(data, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (data && typeof data === "object" && "exit_code" in data) {
    const value = (data as { exit_code?: unknown }).exit_code;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  return null;
}

function formatOutputPayload(type: string, data: unknown): string | null {
  if (type === "start") {
    return null;
  }
  if (typeof data === "string") {
    return data;
  }
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  if (type === "post_install" || type === "copy_command" || type === "error") {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }
  return null;
}
