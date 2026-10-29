/**
 * ISS-5037 — the native application menu.
 *
 * The app previously owned only a tray menu (`tray.ts`) and inherited Electron's
 * DEFAULT application menu, which is why macOS showed a literal "Electron" app
 * menu. Owning the template here is what replaces that with the real app name
 * while keeping every standard role (about/services/hide/quit, File, Edit, View,
 * Window) the default menu provided, so nothing a user relies on disappears.
 *
 * ISS-8753 — THE MENU IS NOW STATIC. It used to hang one deliberately subtle
 * `type: "checkbox"` item, "Enable Labs", off this template, which wrote
 * `labsNav` into `SettingsStore` and rebuilt the menu to re-read it. The PostHog
 * cutover left the renderer resolving `labsNav` from the signed-in user's
 * assignment and reading nothing from that store, so the checkbox persisted a
 * value no gate consulted: it would tick, report itself on, and open nothing.
 * The item is removed rather than rewired (operator direction, 2026-09-01) —
 * there is no local value for it to write that anything would read.
 *
 * With no item reflecting persisted state, nothing can drift from the store, so
 * the rebuild-on-change machinery (`refreshApplicationMenu`, the module-scoped
 * installed deps) went with it.
 */
import { Menu, type MenuItemConstructorOptions } from "electron";

export type ApplicationMenuDeps = {
  /** Menu-bar title of the application menu on macOS. */
  appName: string;
  /** `process.platform` — injected so the template is testable off-macOS. */
  platform: NodeJS.Platform;
};

/**
 * The application-menu template. Pure: it reads `deps` and returns a template,
 * so a test can assert placement without building a real `Menu`.
 */
export function buildApplicationMenuTemplate(
  deps: ApplicationMenuDeps
): MenuItemConstructorOptions[] {
  if (deps.platform === "darwin") {
    return [
      {
        label: deps.appName,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ];
  }
  return [
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}

/** Install the application menu. */
export function installApplicationMenu(deps: ApplicationMenuDeps): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(buildApplicationMenuTemplate(deps))
  );
}
