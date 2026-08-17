"use client";

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { useMemo } from "react";
import { getUserNamePart } from "../../shared/lib/user-utils";
import { useOrganizationUsers } from "../../users/hooks/use-users";
import type { SessionOwnerNameResolver } from "../lib/session-active-filter-chips";

/**
 * ISS-4974 — resolve a Sessions Owner display name for a user the ACTIVE DATE
 * WINDOW cannot name.
 *
 * Owner labels come from the usage `byUser` breakdown, which only contains users
 * with at least one session inside the selected window. An owner whose sessions
 * all fall outside it — or a `?userId=` scope arriving from a surface that DID
 * know the person's name — has no usage row, so the chip renders an opaque
 * `user_2ab…` that identifies nobody. The org member list is the one source that
 * is not window-scoped, so it is what closes the gap.
 *
 * Two rules this hook exists to enforce, both of which a naive implementation
 * gets wrong:
 *
 * 1. **Never fabricate.** The resolver returns `undefined` for an id it cannot
 *    genuinely name — an id belonging to no org member, an unloaded/unreachable
 *    roster, or a member record carrying neither a name nor an email. The caller
 *    then falls back to the raw id, which identifies the wrong person to nobody
 *    rather than the wrong person to someone. There is deliberately no
 *    "Unknown user" placeholder here: `getUserDisplayName` supplies one, and a
 *    chip reading `Owner: Unknown user` is strictly less useful than the id it
 *    replaced (it cannot even be pasted into a search).
 * 2. **Never fetch reflexively.** The roster read is gated on there actually
 *    being an owner id ON SCREEN that the usage summary cannot name. The default
 *    Sessions view — no Owner facet selection, no `?userId=` scope — issues no
 *    request at all.
 */
export function useSessionOwnerNameResolver({
  usage,
  selectedUserIds,
  scopeUserId,
}: {
  usage: AgentSessionUsageSummary | undefined;
  /** The Owner facet's currently-selected user ids. */
  selectedUserIds: readonly string[];
  /** The web `?userId=` deep-link scope, when the host has one. */
  scopeUserId?: string | null;
}): SessionOwnerNameResolver | undefined {
  // Which owner ids are on screen but unnameable from the window's own data.
  // Computing this (rather than "is any owner selected") is what keeps the
  // common case — a selection whose usage row IS in range — from pulling the
  // roster for a name it already has.
  const hasUnresolvedOwner = useMemo(() => {
    const namedInWindow = new Set(
      (usage?.byUser ?? []).map((entry) => entry.userId)
    );
    const onScreen = scopeUserId
      ? [...selectedUserIds, scopeUserId]
      : selectedUserIds;
    return onScreen.some((userId) => !namedInWindow.has(userId));
  }, [usage, selectedUserIds, scopeUserId]);

  const { data: orgUsers } = useOrganizationUsers({
    enabled: hasUnresolvedOwner,
  });

  return useMemo(() => {
    if (!orgUsers) {
      return;
    }
    const nameById = new Map<string, string>();
    for (const user of orgUsers) {
      // Name first, email second — the same "First Last / email" precedence
      // every other user-facing surface uses (`mentionMatchDisplayName`). A
      // member with neither is simply not added, so the caller falls back to the
      // raw id instead of this hook inventing a label.
      const name = getUserNamePart(user).trim() || user.email;
      if (name) {
        nameById.set(user.id, name);
      }
    }
    return (userId: string) => nameById.get(userId);
  }, [orgUsers]);
}
