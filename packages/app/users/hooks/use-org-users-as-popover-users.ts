import {
  getUserDisplayName,
  getUserInitials,
} from "@repo/app/shared/lib/user-utils";
import type { User as PopoverUser } from "@repo/design-system/components/ui/user-select-popover";
import { useMemo } from "react";
import { useOrganizationUsers } from "./use-users";

/**
 * Org members mapped to the shape the user-select popover consumes, plus the
 * query's `isLoading` so a caller can distinguish "still loading" from
 * "genuinely no teammates". `enabled` (default `true`) forwards to the
 * underlying query so a bundle-sensitive caller can defer the fetch until the
 * picker is actually opened, instead of pulling the org roster on every mount.
 */
export function useOrgUsersPopoverQuery(options?: { enabled?: boolean }): {
  users: PopoverUser[];
  isLoading: boolean;
} {
  const enabled = options?.enabled ?? true;
  const { data: usersResult, isLoading } = useOrganizationUsers({ enabled });
  const users = useMemo(() => {
    if (!usersResult) {
      return [];
    }
    return usersResult.map((user) => ({
      id: user.id,
      name: getUserDisplayName(user),
      email: user.email,
      avatarUrl: user.avatarUrl ?? undefined,
      initials: getUserInitials(user.firstName, user.lastName),
    }));
  }, [usersResult]);
  // A disabled (gated-off) query is idle, not loading — report false so a
  // closed picker never claims to be fetching. React Query keeps `isLoading`
  // true for a disabled query, so gate it on `enabled` here.
  return { users, isLoading: enabled && isLoading };
}

/**
 * Org members mapped to the shape the user-select popover consumes. Thin
 * array-only view over {@link useOrgUsersPopoverQuery} for callers that do not
 * need the loading signal. `enabled` (default `true`) forwards through.
 */
export function useOrgUsersAsPopoverUsers(options?: {
  enabled?: boolean;
}): PopoverUser[] {
  return useOrgUsersPopoverQuery(options).users;
}
