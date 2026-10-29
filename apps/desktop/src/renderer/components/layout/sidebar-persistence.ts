/** Renderer-local preference key for the desktop Labs nav section expansion state. */
export const DESKTOP_LABS_NAV_SECTION_STORAGE_KEY =
  "closedloop.desktop.sidebar.section.labs.open";

/**
 * Prefix for the v2 sidebar sections' persisted open state (PLN-2016 D9).
 *
 * A key nobody has written, deliberately: {@link
 * DESKTOP_LABS_NAV_SECTION_STORAGE_KEY} above is about a DIFFERENT section, and
 * reading it here would let a user who once collapsed the legacy Labs list
 * hydrate the v2 tree collapsed. Rollback therefore restores each user's real
 * legacy preference, because the off arm never reads or writes anything under
 * this prefix.
 *
 * The same literal as the web mount's, which owns its own copy in
 * `apps/app/app/(authenticated)/components/shell-navigation/web-shell-sidebar.tsx`:
 * `localStorage` is per origin, so the two shells never collide and the shared
 * spelling is for readers, not for the store.
 */
export const DESKTOP_SHELL_V2_SECTION_PERSISTENCE_KEY_PREFIX =
  "closedloop.shell.v2.sidebar";
