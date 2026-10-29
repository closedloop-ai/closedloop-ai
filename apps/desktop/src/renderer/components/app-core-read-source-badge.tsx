import { ReadSource } from "@repo/api/src/types/read-source";
import { ReadSourceBadge } from "@repo/app/shared/components/read-source-badge";
import {
  DESKTOP_LOCAL_READ_REASON_COPY,
  DesktopAppCoreMode,
} from "../shared-agent-sessions/desktop-app-core-mode";
import {
  useDesktopAppCoreMode,
  useDesktopLocalReadReason,
} from "../shared-agent-sessions/desktop-app-core-provider";

/**
 * The desktop read-source affordance for any surface whose rows come from the
 * canonical app-core reader (PLN-1138), rather than from a query that reports
 * its own `readSource`.
 *
 * `Cloud` reads the org cloud API; `Local` reads this machine's SQLite own-data.
 * The tooltip leads with WHY (ISS-6972: signed out, offline, or sync off), so
 * "Local" reads as a state with a reason rather than as an error — and every
 * surface that mounts this badge gives the same reason, because it comes from
 * the same expression that picked the stack.
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
  const localReadReason = useDesktopLocalReadReason();
  const readSource =
    mode === DesktopAppCoreMode.Cloud ? ReadSource.Cloud : ReadSource.Local;
  return (
    <ReadSourceBadge
      detail={
        localReadReason
          ? DESKTOP_LOCAL_READ_REASON_COPY[localReadReason]
          : undefined
      }
      readSource={readSource}
      surfaceLabel={surfaceLabel}
    />
  );
}
