import {
  getUserDisplayName,
  getUserInitials,
} from "@repo/app/shared/lib/user-utils";
import type { User as PopoverUser } from "@repo/design-system/components/ui/user-select-popover";
import { useMemo } from "react";
import { useOrganizationUsers } from "./use-users";

export function useOrgUsersAsPopoverUsers(): PopoverUser[] {
  const { data: usersResult } = useOrganizationUsers();
  return useMemo(() => {
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
}
