"use client";

import { ParsingBugFlagProvider } from "@repo/app/agents/data-source/parsing-bug-flag-provider";
import { isStaffEmail } from "@repo/app/shared/auth/staff-email";
import { useUser } from "@repo/auth/client";
import type { ReactNode } from "react";

/**
 * FEA-4347: web surface adapter that resolves whether the signed-in user is
 * Closedloop staff (by `@closedloop.ai` email) and injects that into the shared
 * {@link ParsingBugFlagProvider}, which gates the internal "Flag as parsing/data
 * bug" affordance in the session-trace comment composer. Customers resolve to
 * `false` and never see it. Until identity loads, staff-ness is treated as
 * `false` so the affordance stays hidden by default.
 */
export default function StaffParsingBugFlagProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const { user, isLoaded } = useUser();
  const canFlagParsingBug =
    isLoaded && isStaffEmail(user?.primaryEmailAddress?.emailAddress);

  return (
    <ParsingBugFlagProvider canFlagParsingBug={canFlagParsingBug}>
      {children}
    </ParsingBugFlagProvider>
  );
}
