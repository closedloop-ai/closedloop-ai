import { ReadSource } from "@repo/api/src/types/read-source";
import { ReadSourceBadge } from "@repo/app/shared/components/read-source-badge";
import { DesktopAppCoreMode } from "../shared-agent-sessions/desktop-app-core-mode";
import { useDesktopAppCoreMode } from "../shared-agent-sessions/desktop-app-core-provider";
import { useCloudReadCutoverBadge } from "../shared-agent-sessions/use-cloud-read-cutover-badge";

/**
 * The desktop read-source affordance for any surface whose rows come from the
 * canonical app-core reader (PLN-1138), rather than from a query that reports
 * its own `readSource`.
 *
 * ISS-5607 extracted this from `DashboardReadSourceBadge`, which was the only
 * mount when it was written. The session DETAIL pane now needs the identical
 * composition — mode → `ReadSource` → the ISS-5477 cutover extras → the shared
 * `ReadSourceBadge` — and the only thing that differs between the two is the
 * tooltip's surface noun. Copying those four lines is how the Dashboard and the
 * detail pane would end up explaining one state two ways, which is the drift
 * `useCloudReadCutoverBadge` already exists to prevent one layer down.
 *
 * `Cloud` reads the org cloud API; `Local` reads this machine's SQLite own-data
 * — which, for an authenticated session, is either the offline degradation
 * (PRD-461 D3 / AC-3.3) or the ISS-5477 hold that keeps the reader on local data
 * until the upload backlog has drained. The tooltip carries WHY, so "Local"
 * during a first-run drain reads as a state with a reason and a finish line, not
 * as an error and never as an empty workspace.
 *
 * There is deliberately no `Fallback` arm: the app-core mode is a two-valued
 * choice this renderer makes for itself, so it can always attribute the read.
 * `Fallback` means a query could not attribute its own source, which is a claim
 * only a surface carrying a per-query `readSource` (Branches) can make.
 */
export function AppCoreReadSourceBadge({
  surfaceLabel,
}: Readonly<{
  /** Tooltip noun for the surface being described ("dashboard", "session"). */
  surfaceLabel: string;
}>) {
  const mode = useDesktopAppCoreMode();
  const readSource =
    mode === DesktopAppCoreMode.Cloud ? ReadSource.Cloud : ReadSource.Local;
  const { detail, incomplete } = useCloudReadCutoverBadge(readSource);
  return (
    <ReadSourceBadge
      detail={detail}
      incomplete={incomplete}
      readSource={readSource}
      surfaceLabel={surfaceLabel}
    />
  );
}
