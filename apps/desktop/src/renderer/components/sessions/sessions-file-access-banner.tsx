import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@closedloop-ai/design-system/components/ui/alert";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Lock } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { useFileAccessBlocks } from "../../hooks/use-ingest-progress";

/**
 * FEA-3639: when a harness's local transcript root exists but the OS is blocking
 * reads (a denied macOS file-access prompt), the import silently under-populates
 * and the Sessions list looks empty with no explanation. This pinned prompt says
 * so explicitly — which root is blocked and what to do — instead of leaving the
 * user staring at a stalled list. It renders nothing when nothing is blocked, and
 * clears on the next runtime-status poll once access is granted.
 *
 * Recovery: granting the permission unblocks the reads, but the boot import that
 * already skipped those files must re-run to backfill them. `Reload` triggers the
 * idempotent re-import over IPC, so the user recovers without an app restart.
 */
export function SessionsFileAccessBanner(): ReactNode {
  const blocks = useFileAccessBlocks(true);
  const [reloading, setReloading] = useState(false);
  // Older preload builds (version skew) don't expose the in-place re-import. We
  // must not render an enabled button that silently does nothing — so when it's
  // absent, drop the button and tell the user to restart the app instead (a
  // renderer `location.reload()` wouldn't re-run the main-process boot import).
  const canReload =
    typeof window.desktopApi?.reimportAgentSessions === "function";

  const handleReload = useCallback(() => {
    const reimport = window.desktopApi?.reimportAgentSessions;
    if (!reimport) {
      return;
    }
    setReloading(true);
    reimport()
      .catch(() => undefined)
      .finally(() => setReloading(false));
  }, []);

  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className="shrink-0 border-b px-4 py-3">
      <Alert variant="warning">
        <Lock aria-hidden="true" />
        <AlertTitle>Waiting on file access</AlertTitle>
        <AlertDescription>
          <p>
            Closedloop cannot read your agent history because macOS is blocking
            access. Allow it in System Settings → Privacy &amp; Security, then{" "}
            {canReload ? "reload" : "restart Closedloop"}.
          </p>
          <ul className="font-mono text-xs">
            {blocks.map((block) => (
              <li key={`${block.harness}:${block.path}`}>{block.path}</li>
            ))}
          </ul>
          {canReload ? (
            <Button
              className="mt-1"
              disabled={reloading}
              onClick={handleReload}
              size="sm"
              type="button"
              variant="outline"
            >
              {reloading ? "Reloading…" : "Reload"}
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    </div>
  );
}
