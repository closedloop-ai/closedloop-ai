import { ParsingBugFlagProvider } from "@repo/app/agents/data-source/parsing-bug-flag-provider";
import type { ReactNode } from "react";
import { useDesktopAuth } from "./desktop-auth-provider";
import {
  DesktopStaffStatus,
  useDesktopStaffStatus,
} from "./use-desktop-staff-status";

/**
 * FEA-4347: desktop surface adapter that resolves whether the signed-in desktop
 * user is Closedloop staff (by `@closedloop.ai` email) and injects that into the
 * shared {@link ParsingBugFlagProvider}, which gates the internal "Flag as
 * parsing/data bug" affordance in the session-trace comment composer. Customers
 * resolve to `false` and never see it.
 *
 * The email lives in the display identity fetched over the main-process bridge
 * (`getDesktopIdentity`) — the same source `useDesktopIdentity` reads. It
 * is fetched only while authenticated; a bridge-absent test stub, a signed-out
 * session, or a fetch failure all leave staff-ness `false`, so the affordance
 * stays hidden by default (fail-safe).
 */
export function DesktopParsingBugFlagProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { state } = useDesktopAuth();
  const canFlagParsingBug =
    useDesktopStaffStatus(state) === DesktopStaffStatus.Staff;
  return (
    <ParsingBugFlagProvider canFlagParsingBug={canFlagParsingBug}>
      {children}
    </ParsingBugFlagProvider>
  );
}
