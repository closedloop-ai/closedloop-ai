"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import {
  DesktopCommandStatus,
  isTerminalStatus,
  UPDATE_AND_RESTART_OPERATION_ID,
} from "@repo/api/src/types/compute-target";
import type { ElectronReleaseInfo } from "@repo/api/src/types/electron";
import { useLatestElectronRelease } from "@repo/app/desktop/hooks/use-electron-release";
import {
  getPluginVersion,
  isUpdateAvailable,
  validatePluginVersion,
} from "@repo/app/shared/lib/version-utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/design-system/components/ui/alert-dialog";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  useDesktopCommandStatus,
  useDispatchDesktopCommand,
} from "@/hooks/queries/use-compute-targets";

type UpdateButtonStateHidden = {
  kind: "hidden";
};

type UpdateButtonStateDisabled = {
  kind: "disabled";
  reason: string;
  currentVersion: string | undefined;
};

type UpdateButtonStateEnabled = {
  kind: "enabled";
  currentVersion: string | undefined;
};

type UpdateButtonState =
  | UpdateButtonStateHidden
  | UpdateButtonStateDisabled
  | UpdateButtonStateEnabled;

type UpdateAndRestartButtonProps = {
  target: ComputeTarget;
  onSuccess?: () => void;
  onError?: (downloadUrl: string) => void;
  onExpired?: () => void;
  onIsUpdatingChange?: (isUpdating: boolean) => void;
};

function getSessionStorageKey(targetId: string): string {
  return `update-restart-command-${targetId}`;
}

function readStoredCommandId(targetId: string): string | null {
  try {
    return globalThis.window === undefined
      ? null
      : sessionStorage.getItem(getSessionStorageKey(targetId));
  } catch {
    return null;
  }
}

function writeStoredCommandId(targetId: string, commandId: string): void {
  try {
    if (globalThis.window !== undefined) {
      sessionStorage.setItem(getSessionStorageKey(targetId), commandId);
    }
  } catch {
    // sessionStorage write failures are non-fatal
  }
}

function clearStoredCommandId(targetId: string): void {
  try {
    if (globalThis.window !== undefined) {
      sessionStorage.removeItem(getSessionStorageKey(targetId));
    }
  } catch {
    // sessionStorage remove failures are non-fatal
  }
}

export function resolveButtonState(
  target: ComputeTarget,
  releaseInfo: ElectronReleaseInfo | null | undefined
): UpdateButtonState {
  if (releaseInfo === undefined || releaseInfo === null) {
    return { kind: "hidden" };
  }

  if (!target.supportedOperations.includes(UPDATE_AND_RESTART_OPERATION_ID)) {
    return { kind: "hidden" };
  }

  const currentVersion = getPluginVersion(target);

  if (!isUpdateAvailable(currentVersion, releaseInfo.version)) {
    return { kind: "hidden" };
  }

  if (!target.isOnline) {
    return {
      kind: "disabled",
      reason: "Target is offline",
      currentVersion,
    };
  }

  return { kind: "enabled", currentVersion };
}

function renderSafeAnchor({
  href,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"a">) {
  const safeHref = href?.startsWith("https://") ? href : "#";

  return (
    <a href={safeHref} rel="noopener noreferrer" target="_blank" {...props}>
      {children}
    </a>
  );
}

const releaseNotesComponents = {
  a: renderSafeAnchor,
};

function UpdateAndRestartButtonInner({
  target,
  onSuccess,
  onError,
  onExpired,
  onIsUpdatingChange,
}: UpdateAndRestartButtonProps) {
  const { data: releaseInfo } = useLatestElectronRelease();
  const [commandId, setCommandId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const dispatch = useDispatchDesktopCommand(target);
  const { data: commandStatus, isError: statusError } = useDesktopCommandStatus(
    target.id,
    commandId
  );

  const buttonState = resolveButtonState(target, releaseInfo);
  const isDispatching = dispatch.isPending;
  // Treat commandId being set as evidence of polling until the status query
  // either resolves as terminal or errors out (e.g. stale 404 from sessionStorage).
  // statusError → stale commandId, clear it so the button becomes usable again.
  const isPolling =
    commandId !== null &&
    !statusError &&
    (commandStatus === undefined || !isTerminalStatus(commandStatus.status));
  const isUpdating = isDispatching || isPolling;

  const currentVersion =
    buttonState.kind === "hidden"
      ? "Unknown"
      : (validatePluginVersion(buttonState.currentVersion) ?? "Unknown");
  const newVersion = validatePluginVersion(releaseInfo?.version) ?? "Unknown";

  // Stabilize callback refs to avoid spurious effect re-runs when parent
  // re-renders with new closure identities.
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;
  const onIsUpdatingChangeRef = useRef(onIsUpdatingChange);
  onIsUpdatingChangeRef.current = onIsUpdatingChange;

  // Guard to prevent terminal callbacks from firing more than once.
  const terminalFiredRef = useRef<string | null>(null);

  // Clear stale commandId when status query errors (e.g. 404 from sessionStorage)
  useEffect(() => {
    if (statusError && commandId) {
      clearStoredCommandId(target.id);
      setCommandId(null);
    }
  }, [statusError, commandId, target.id]);

  useEffect(() => {
    const stored = readStoredCommandId(target.id);
    if (stored !== null) {
      setCommandId(stored);
    }
  }, [target.id]);

  useEffect(() => {
    onIsUpdatingChangeRef.current?.(isUpdating);
  }, [isUpdating]);

  useEffect(() => {
    if (commandStatus === undefined) {
      return;
    }

    if (!isTerminalStatus(commandStatus.status)) {
      return;
    }

    // Prevent duplicate terminal callbacks for the same commandId.
    if (terminalFiredRef.current === commandId) {
      return;
    }
    terminalFiredRef.current = commandId;

    clearStoredCommandId(target.id);
    setCommandId(null);

    if (commandStatus.status === DesktopCommandStatus.Done) {
      onSuccessRef.current?.();
    } else if (commandStatus.status === DesktopCommandStatus.Expired) {
      onExpiredRef.current?.();
    } else {
      onErrorRef.current?.(releaseInfo?.downloadUrl ?? "");
    }
  }, [commandStatus, commandId, target.id, releaseInfo]);

  if (buttonState.kind === "hidden") {
    return null;
  }

  function handleConfirm(): void {
    let idempotencyKey: string;
    try {
      idempotencyKey = crypto.randomUUID();
    } catch {
      idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    dispatch.mutate(
      { idempotencyKey },
      {
        onSuccess: (response) => {
          writeStoredCommandId(target.id, response.commandId);
          setCommandId(response.commandId);
        },
      }
    );
    setDialogOpen(false);
  }

  const isButtonDisabled = buttonState.kind === "disabled" || isUpdating;
  const disabledReason =
    buttonState.kind === "disabled" ? buttonState.reason : undefined;

  const dialogDescriptionId = `update-dialog-description-${target.id}`;
  const dialogTitleId = `update-dialog-title-${target.id}`;

  return (
    <>
      <span aria-atomic="true" aria-live="polite" className="sr-only">
        {isUpdating ? "Updating compute target" : ""}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={isButtonDisabled ? 0 : undefined}>
            <Button
              aria-label="Update and restart compute target"
              disabled={isButtonDisabled}
              onClick={() => setDialogOpen(true)}
              size="sm"
              variant="outline"
            >
              {isUpdating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Update &amp; Restart
            </Button>
          </span>
        </TooltipTrigger>
        {disabledReason ? (
          <TooltipContent>{disabledReason}</TooltipContent>
        ) : null}
      </Tooltip>

      <AlertDialog onOpenChange={setDialogOpen} open={dialogOpen}>
        <AlertDialogContent
          aria-describedby={dialogDescriptionId}
          aria-labelledby={dialogTitleId}
        >
          <AlertDialogHeader>
            <AlertDialogTitle id={dialogTitleId}>
              Update &amp; Restart
            </AlertDialogTitle>
            <AlertDialogDescription id={dialogDescriptionId}>
              Update from version <strong>{currentVersion}</strong> to{" "}
              <strong>{newVersion}</strong>. The compute target will restart
              after the update completes.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {releaseInfo?.releaseNotes ? (
            <div className="max-h-64 overflow-y-auto rounded-md border bg-muted/50 p-3 text-sm">
              <ReactMarkdown
                components={releaseNotesComponents}
                remarkPlugins={[remarkGfm]}
              >
                {releaseInfo.releaseNotes}
              </ReactMarkdown>
            </div>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={isUpdating} onClick={handleConfirm}>
              {isUpdating ? "Updating..." : "Update & Restart"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function UpdateAndRestartButton(props: UpdateAndRestartButtonProps) {
  return (
    <FeatureFlagged flag="electron-remote-update">
      <UpdateAndRestartButtonInner {...props} />
    </FeatureFlagged>
  );
}
