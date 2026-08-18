"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * FEA-4347: surface-safe gate for the "Flag as parsing/data bug" affordance in
 * the session-trace comment composer (added by FEA-4171).
 *
 * The parsing-bug flag is an internal data-quality signal — it feeds the
 * golden-dataset CANDIDATE pipeline — so only Closedloop staff should see it;
 * customers get a plain comment composer. The trace UI is shared across the web
 * app and the desktop renderer (`packages/app`), and staff-ness is resolved
 * differently per surface (web: Clerk `useUser` email; desktop: the signed-in
 * desktop identity email). Rather than import an app-only staff hook into the
 * shared component, each surface adapter resolves the staff signal and injects
 * it here; the shared composer only reads {@link useCanFlagParsingBug}.
 *
 * The context defaults to `false` so any surface, story, or test that does NOT
 * mount a provider (i.e. an un-updated / customer caller) hides the affordance —
 * fail-safe by construction. This is UX-only visibility hiding; the server write
 * path still accepts `kind: ParsingBug` from older clients / in-flight drafts.
 */
const CanFlagParsingBugContext = createContext<boolean>(false);

/** Inject the resolved staff signal from a surface adapter (web / desktop). */
export function ParsingBugFlagProvider({
  canFlagParsingBug,
  children,
}: {
  canFlagParsingBug: boolean;
  children?: ReactNode;
}) {
  return (
    <CanFlagParsingBugContext.Provider value={canFlagParsingBug}>
      {children}
    </CanFlagParsingBugContext.Provider>
  );
}

/**
 * Whether the current surface may show the "Flag as parsing/data bug" affordance.
 * Defaults to `false` when no provider is mounted (customers / un-updated callers).
 */
export function useCanFlagParsingBug(): boolean {
  return useContext(CanFlagParsingBugContext);
}
