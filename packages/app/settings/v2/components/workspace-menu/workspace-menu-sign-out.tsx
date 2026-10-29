"use client";

import { useCallback, useState } from "react";
import type { WorkspaceMenuHostAdapter } from "../../../../shared/workspace-menu-host/workspace-menu-host-adapter";

/**
 * The menu's sign-out action and whether the last attempt failed.
 *
 * A leaf both menu bodies import, for the reason `workspace-menu-styles.ts`
 * gives: `workspace-menu.tsx` and `workspace-menu-projected.tsx` both need it
 * and one importing the other for it would be a cycle.
 */

export function useSignOut(adapter: WorkspaceMenuHostAdapter) {
  const [signOutFailed, setSignOutFailed] = useState(false);

  const signOut = useCallback(() => {
    setSignOutFailed(false);
    // A rejected sign-out must NOT close the menu looking successful. Desktop's
    // `signOutDesktop` can reject with the session still live, and telling a
    // user on a shared machine that they signed out when they did not is the
    // worst lie this menu could tell.
    adapter.signOut().catch(() => setSignOutFailed(true));
  }, [adapter]);

  return { signOut, signOutFailed };
}
