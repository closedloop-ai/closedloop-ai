"use client";

import type { User } from "@repo/api/src/types/user";
import type { TableFilterCurrentUser } from "@repo/design-system/components/ui/table-filters";
import { useMemo } from "react";

export type FilterCurrentUser = TableFilterCurrentUser;

/**
 * Memoize the lightweight filter shape used by FilterPopover and
 * ActiveFiltersBar. Falls back to the email when the user has no first
 * or last name set.
 */
export function useFilterCurrentUser(
  currentUser: User | undefined | null
): FilterCurrentUser | null {
  return useMemo(() => {
    if (!currentUser) {
      return null;
    }
    const name =
      [currentUser.firstName, currentUser.lastName].filter(Boolean).join(" ") ||
      currentUser.email;
    return {
      id: currentUser.id,
      name,
      avatarUrl: currentUser.avatarUrl ?? undefined,
    };
  }, [currentUser]);
}
