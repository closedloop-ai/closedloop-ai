/**
 * The single cross-surface flag key gating the undo/redo keybinding layer
 * (ISS-9092, under the ISS-9088 umbrella).
 *
 * ## Why ONE key, and why it is enough
 *
 * The layer ships in `@repo/app`, which both the Next.js web shell
 * (`apps/app`) and the Electron renderer (`apps/desktop`) mount. Since
 * ISS-8753 the desktop renderer resolves the signed-in account's PostHog
 * assignment from the same key space web reads and resolves nothing else — no
 * Labs setting, no build type — so this key is the WHOLE gate on both shells.
 * There is no desktop flag-registry shadow entry to add beside it and no Labs
 * toggle to keep in step; the retired ISS-8024 cutover key
 * (`desktopPosthogFlags`) no longer selects a local registry path.
 *
 * Closed by default. With the flag off the layer attaches no `keydown`
 * listener at all, so a user who is not in the rollout keeps the browser's and
 * the OS's own Cmd+Z behaviour byte for byte.
 *
 * Lives in this dependency-free `@repo/api` module (no Zod, no heavy
 * transitive graph) so a bundle-sensitive client imports one literal rather
 * than redeclaring it per shell.
 */
export const UNDO_KEYBINDINGS_FLAG_KEY = "undo-keybindings" as const;
