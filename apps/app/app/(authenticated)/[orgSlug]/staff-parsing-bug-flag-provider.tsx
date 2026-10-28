"use client";

import { isStaffEmail } from "@repo/api/src/types/staff-email";
import { ParsingBugFlagProvider } from "@repo/app/agents/data-source/parsing-bug-flag-provider";
import type { ReactNode } from "react";
import { useActorEmail } from "@/hooks/use-actor-email";

/**
 * FEA-4347: web surface adapter that resolves whether the signed-in user is
 * Closedloop staff (by `@closedloop.ai` email) and injects that into the shared
 * {@link ParsingBugFlagProvider}, which gates the internal "Flag as parsing/data
 * bug" affordance in the session-trace comment composer. Customers resolve to
 * `false` and never see it. Until identity loads, staff-ness is treated as
 * `false` so the affordance stays hidden by default.
 *
 * The email comes from {@link useActorEmail} rather than Clerk directly, so this
 * gate and the dev-mode one answer from one identity on every lane (ISS-10335).
 */
export default function StaffParsingBugFlagProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const { email, isLoaded } = useActorEmail();
  const canFlagParsingBug = isLoaded && isStaffEmail(email);

  return (
    <ParsingBugFlagProvider canFlagParsingBug={canFlagParsingBug}>
      {children}
    </ParsingBugFlagProvider>
  );
}
