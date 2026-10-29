/**
 * The single cross-surface flag key gating the workspace menu's "Invite
 * members" entry, and the desktop sidebar footer item it replaces (ISS-10362).
 *
 * ## Why a key at all
 *
 * ISS-10195 retired `workspace-experience-v2`, so the desktop sidebar is
 * ungated: nothing above this change ships closed any more, and the
 * closed-by-default UI policy (ISS-4779) therefore applies in full to a
 * perceivable relocation of a nav entry.
 *
 * ## Why ONE key
 *
 * `apps/desktop` resolves the signed-in account's PostHog assignment from the
 * same key space `apps/app` reads, and resolves nothing else, so one constant is
 * the WHOLE gate — no desktop Labs toggle to pair with it and no desktop
 * flag-registry entry to add beside it (the ISS-8024 local-registry cutover is
 * retired). The key is named for the ENTRY rather than for a host so that a
 * later decision to offer the same row on web needs no second literal.
 *
 * ## How it is read
 *
 * ONCE per surface that swaps on it, and each such surface reads it ITSELF
 * rather than being handed a boolean: the desktop sidebar picks between two
 * whole footers, and the menu's invite module picks between rendering the entry
 * and rendering nothing. Neither reads the other's answer.
 *
 * Off leaves both shells exactly as they are — the desktop entry in the sidebar
 * footer, web untouched. That covers every read until someone creates the flag,
 * every read that has not resolved, an errored read, and everyone outside the
 * rollout.
 */
export const WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY =
  "workspace-menu-invite-entry" as const;
