import { FolderInput, RefreshCwIcon, TriangleAlert } from "lucide-react";
import { useCallback, useState } from "react";
import { useDesktopEvent } from "../hooks/useDesktopApi";
import {
  INITIAL_UPDATE_BANNER_STATE,
  isUpdateApplyEnabled,
  isUpdateBannerVisible,
  isUpdateInstallBlocked,
  reduceUpdateAvailableEvent,
  reduceUpdateStatusEvent,
  type UpdateBannerState,
  updateBannerMessage,
} from "./update-banner-state";

/**
 * Self-contained auto-update banner shown directly below the page header.
 * Subscribes to the IPC-bridged `desktop:update-status` /
 * `desktop:update-available` window events (re-emitted by the preload bridge).
 * Once an
 * update is downloaded and ready, the whole banner becomes a clickable
 * "Relaunch to update" action that calls applyUpdate() (quit + install +
 * restart). Read-only install blocks render a warning with a Move & Update
 * action, while other pre-ready states render as informational/error strips.
 * All gating is delegated to the pure helpers in update-banner-state.ts.
 */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateBannerState>(
    INITIAL_UPDATE_BANNER_STATE
  );
  const [applying, setApplying] = useState(false);
  const [movingToApplications, setMovingToApplications] = useState(false);
  const [moveFailed, setMoveFailed] = useState(false);

  useDesktopEvent(
    "desktop:update-status",
    useCallback((detail) => {
      setState((prev) => reduceUpdateStatusEvent(prev, detail));
    }, [])
  );

  useDesktopEvent(
    "desktop:update-available",
    useCallback((detail) => {
      setState((prev) => reduceUpdateAvailableEvent(prev, detail));
    }, [])
  );

  const handleApply = useCallback(async () => {
    setApplying(true);
    try {
      await window.desktopApi.applyUpdate();
    } catch {
      // The main process rejects an apply before the update is downloaded;
      // re-enable the action so the user can retry once ready.
      setApplying(false);
    }
  }, []);

  const handleMoveToApplications = useCallback(async () => {
    setMovingToApplications(true);
    setMoveFailed(false);
    try {
      const moved = await window.desktopApi.moveToApplications();
      setMoveFailed(!moved);
    } catch {
      setMoveFailed(true);
    } finally {
      setMovingToApplications(false);
    }
  }, []);

  if (!isUpdateBannerVisible(state)) {
    return null;
  }

  if (isUpdateInstallBlocked(state)) {
    return (
      <div
        className="flex shrink-0 items-center justify-center gap-3 border-[var(--warning)]/30 border-b bg-[var(--warning)]/12 px-4 py-2 text-[var(--warning-foreground)] text-sm"
        role="status"
      >
        <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">
          {moveFailed
            ? "Couldn't move automatically. Quit Closedloop, move it to Applications, then relaunch."
            : updateBannerMessage(state)}
        </span>
        <button
          className="flex shrink-0 items-center gap-1.5 rounded border border-[var(--warning)]/40 bg-[var(--background)]/70 px-2 py-1 font-semibold text-[11px] text-[var(--warning-foreground)] transition-colors hover:bg-[var(--warning)]/18 disabled:pointer-events-none disabled:opacity-70"
          disabled={movingToApplications}
          onClick={handleMoveToApplications}
          type="button"
        >
          <FolderInput aria-hidden="true" className="size-3.5 shrink-0" />
          <span>{movingToApplications ? "Moving..." : "Move & Update"}</span>
        </button>
      </div>
    );
  }

  if (isUpdateApplyEnabled(state)) {
    return (
      <button
        className="flex w-full shrink-0 items-center justify-start gap-2 bg-[var(--primary)] px-4 py-2 text-left font-medium text-[var(--primary-foreground)] text-sm transition-colors hover:bg-[var(--primary)]/90 disabled:pointer-events-none disabled:opacity-70"
        disabled={applying}
        onClick={handleApply}
        type="button"
      >
        <span>
          {applying
            ? "Restarting..."
            : "New version available. Relaunch to update"}
        </span>
        <RefreshCwIcon className="size-3.5 shrink-0" />
      </button>
    );
  }

  const isError = state.status === "error";

  return (
    <div
      className={`flex shrink-0 items-center justify-center gap-3 border-b px-4 py-2 text-sm ${
        isError
          ? "bg-[var(--destructive)]/10 text-[var(--destructive)]"
          : "bg-[var(--primary)]/10 text-[var(--foreground)]"
      }`}
      role="status"
    >
      <span className="truncate">{updateBannerMessage(state)}</span>
    </div>
  );
}
