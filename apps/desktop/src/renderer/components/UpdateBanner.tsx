import { Button } from "@closedloop-ai/design-system/components/ui/button";
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
 * Once an update is downloaded and ready, the strip states that and offers a
 * Relaunch button that calls applyUpdate() (quit + install + restart).
 * Read-only install blocks render a warning with a Move & Update action, while
 * other pre-ready states render as informational/error strips. All gating is
 * delegated to the pure helpers in update-banner-state.ts.
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
          className="flex shrink-0 items-center gap-1.5 rounded border border-[var(--warning)]/40 bg-[var(--background)]/70 px-2 py-1 font-semibold text-[11px] text-[var(--warning-foreground)] transition-colors hover:bg-[var(--warning)]/20 disabled:pointer-events-none disabled:opacity-70"
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
      // ISS-5367: the same 10-12% tint + hairline `border-b` every other state
      // in this file uses (the read-only block above, the error/info strip
      // below) and every sibling banner in the desktop stack. This was the one
      // variant painted at full `bg-[var(--primary)]`, so on a build with an
      // update pending it landed a full-bleed saturated slab across the top of
      // the window — a rule loud enough to out-shout the content, and, stacked
      // above the collapsed import splash, one of two heavy bands with a pale
      // row trapped between them. The foreground moves with the background:
      // `--primary-foreground` is chosen to sit on solid primary and would be
      // near-invisible on a 10% wash, so this takes `--foreground`, exactly as
      // the informational state below already does.
      //
      // ISS-5367 review: dropping the saturation also dropped the only thing
      // saying the bar was clickable, and a whole-strip button washed at 10%
      // over a hairline is pixel-for-pixel the passive `role="status"` strip
      // twenty lines down. So the action is a real Button on a centered line
      // rather than the strip itself — the shape the read-only block above and
      // `opt-in-distributions-banner` already use for a tinted strip that DOES
      // something, and the shape that lets the sentence and the verb separate.
      <div
        className="flex shrink-0 items-center justify-center gap-3 border-b bg-[var(--primary)]/10 px-4 py-2 text-[var(--foreground)] text-sm"
        data-testid={UPDATE_BANNER_READY_TEST_ID}
        role="status"
      >
        <span className="min-w-0 truncate font-medium">
          A new version is available.
        </span>
        <Button
          disabled={applying}
          onClick={handleApply}
          size="sm"
          type="button"
        >
          <RefreshCwIcon aria-hidden="true" />
          {applying ? "Restarting..." : "Relaunch"}
        </Button>
      </div>
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

/**
 * Handle for the ready-to-install strip. The strip is a `role="status"` line and
 * so are its siblings, so a role query alone cannot pick it out — the renderer
 * suite and the Electron regression both need to address this exact state.
 */
export const UPDATE_BANNER_READY_TEST_ID = "update-banner-ready";
