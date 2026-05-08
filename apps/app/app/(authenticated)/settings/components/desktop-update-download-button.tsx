"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Download, Loader2 } from "lucide-react";

type DesktopUpdateDownloadButtonProps = {
  downloadUrl: string | null;
  isLoading: boolean;
};

/**
 * Renders the manual Desktop update action using only the latest release API
 * result. If the release URL is unavailable, no fallback download URL is used.
 */
export function DesktopUpdateDownloadButton({
  downloadUrl,
  isLoading,
}: DesktopUpdateDownloadButtonProps) {
  if (downloadUrl) {
    return (
      <Button asChild size="sm" variant="outline">
        <a href={downloadUrl} rel="noreferrer" target="_blank">
          <Download className="h-4 w-4" />
          Download update
        </a>
      </Button>
    );
  }

  return (
    <Button disabled size="sm" variant="outline">
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Download className="h-4 w-4" />
      )}
      {isLoading ? "Loading update" : "Download unavailable"}
    </Button>
  );
}
