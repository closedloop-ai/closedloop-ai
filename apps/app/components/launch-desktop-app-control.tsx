"use client";

import { DesktopUpdateDownloadButton } from "@repo/app/compute/components/desktop-security";
import { Button } from "@repo/design-system/components/ui/button";
import { Loader2Icon, PowerIcon } from "lucide-react";

export type LaunchDesktopAppControlProps = {
  downloadUrl: string | null;
  isAwaitingLaunch: boolean;
  isDownloadUrlLoading: boolean;
  onLaunch: () => void;
  showFallback: boolean;
  /** The host popover's compact button rhythm, so it stays named in one place. */
  compactButtonClass: string;
};

/**
 * The "Launch Desktop App" control plus the honest outcome of pressing it
 * (ISS-6109).
 *
 * Firing `closedloop://` is unobservable from the browser: an unregistered
 * scheme no-ops with no error, so a desktop build older than the one that began
 * registering the scheme leaves this button looking successful and doing
 * nothing. The pending and fallback states report only what is actually known —
 * "waiting", then "still not reachable" — and never claim the launch failed,
 * which the browser cannot see.
 *
 * The fallback carries `role="status"`: it appears seconds after the click with
 * no further user action, and the surrounding Alert was already on screen, so a
 * mutation inside it is not announced on its own.
 */
export function LaunchDesktopAppControl({
  compactButtonClass,
  downloadUrl,
  isAwaitingLaunch,
  isDownloadUrlLoading,
  onLaunch,
  showFallback,
}: LaunchDesktopAppControlProps) {
  return (
    <>
      <Button
        className={compactButtonClass}
        disabled={isAwaitingLaunch}
        onClick={onLaunch}
        size="sm"
        variant="outline"
      >
        {isAwaitingLaunch ? (
          <Loader2Icon className="size-3 shrink-0 animate-spin" />
        ) : (
          <PowerIcon className="size-3 shrink-0" />
        )}
        {isAwaitingLaunch ? "Opening Desktop App" : "Launch Desktop App"}
      </Button>
      {showFallback && (
        <div
          className="space-y-2 border-t pt-2"
          data-testid="desktop-launch-fallback"
          role="status"
        >
          <p className="text-xs">
            Still no response from the desktop app. Open it yourself, or update
            it. Older versions can&apos;t be launched from the browser.
          </p>
          <DesktopUpdateDownloadButton
            className={compactButtonClass}
            downloadUrl={downloadUrl}
            iconClassName="size-3"
            isLoading={isDownloadUrlLoading}
          />
        </div>
      )}
    </>
  );
}
