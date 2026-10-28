/**
 * The two class strings every surface of the workspace menu wears.
 *
 * They live here rather than in each file because the menu is assembled from
 * four modules that all render into the SAME open dropdown — the menu body, the
 * workspace switcher flyout, the download row, and the theme flyout. A viewer
 * sees them together, so a treatment that drifts in one is visible next to the
 * three that did not. Each file previously restated both literals, which is the
 * arrangement that makes that drift silent.
 *
 * `workspace-switcher-submenu.tsx` is imported BY `workspace-menu.tsx`, so
 * neither could own these for the other without a cycle; a leaf module both
 * import is the seam that has no direction.
 */

/** Row rhythm: menu items, sub-triggers, and the options inside a flyout. */
export const ITEM_CLASSNAME = "py-2.5";

/**
 * Flyout/panel treatment. Width is deliberately excluded — each panel sizes to
 * its own content, so a three-word theme flyout does not inherit the width the
 * workspace switcher needs for avatars and names.
 */
export const PANEL_CLASSNAME = "rounded-xl p-1.5 shadow-xl";
