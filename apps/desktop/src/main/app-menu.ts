/**
 * ISS-5037 — the native application menu, and with it the "Enable Labs"
 * easter egg.
 *
 * The app previously owned only a tray menu (`tray.ts`) and inherited
 * Electron's DEFAULT application menu, which is why macOS showed a literal
 * "Electron" app menu. Owning the template here lets us hang one deliberately
 * subtle `type: "checkbox"` item — "Enable Labs" — off it while keeping every
 * standard role (about/services/hide/quit, File, Edit, View, Window) that the
 * default menu provided, so nothing a user relies on disappears.
 *
 * The checkbox reflects the PERSISTED value rather than its own toggle state:
 * every click writes through `setLabsNavEnabled` and then rebuilds the menu from
 * the store, and {@link refreshApplicationMenu} rebuilds it whenever the flag
 * changes by any other path (a settings-IPC write, an env override). A checkbox
 * that can drift from the setting it claims to show is worse than no checkbox.
 */
import { app, Menu, type MenuItemConstructorOptions } from "electron";

/** Visible label of the Labs easter-egg item. */
export const ENABLE_LABS_MENU_LABEL = "Enable Labs";

/**
 * Submenu that hosts the Labs item on platforms with no macOS-style application
 * menu, so a Windows/Linux user can still reach the toggle. macOS puts the item
 * in the application menu itself (see {@link buildApplicationMenuTemplate}).
 */
export const LABS_MENU_LABEL = "Labs";

export type ApplicationMenuDeps = {
  /** Menu-bar title of the application menu on macOS. */
  appName: string;
  /** `process.platform` — injected so the template is testable off-macOS. */
  platform: NodeJS.Platform;
  /** Current persisted value of the Labs nav gate. */
  isLabsNavEnabled: () => boolean;
  /** Persist the new value and notify the renderer. */
  setLabsNavEnabled: (enabled: boolean) => void;
};

/**
 * The application-menu template. Pure: it reads the current flag value through
 * `deps` and returns a template, so a test can assert the item's placement and
 * checked state without building a real `Menu`.
 */
export function buildApplicationMenuTemplate(
  deps: ApplicationMenuDeps
): MenuItemConstructorOptions[] {
  const labsItem = buildLabsMenuItem(deps);
  if (deps.platform === "darwin") {
    return [
      {
        label: deps.appName,
        submenu: [
          { role: "about" },
          { type: "separator" },
          labsItem,
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
    { label: LABS_MENU_LABEL, submenu: [labsItem] },
    { role: "windowMenu" },
  ];
}

/**
 * Install the application menu and remember its deps so
 * {@link refreshApplicationMenu} can rebuild it later.
 *
 * Module-scoped state is the right shape here: an Electron process has exactly
 * ONE application menu (`Menu.setApplicationMenu` is global), so there is no
 * second instance for a second controller to own.
 */
export function installApplicationMenu(deps: ApplicationMenuDeps): void {
  installedDeps = deps;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(buildApplicationMenuTemplate(deps))
  );
}

/**
 * Rebuild the installed menu so the "Enable Labs" checkbox re-reads the
 * persisted value. Called from the flags-changed broadcast, so a write from any
 * other path (the settings IPC, a Labs panel toggle) cannot leave the checkbox
 * claiming a state the store disagrees with. A no-op before install.
 */
export function refreshApplicationMenu(): void {
  if (installedDeps) {
    installApplicationMenu(installedDeps);
  }
}

/** Test seam: forget the installed menu so suites don't leak state. */
export function resetApplicationMenuForTests(): void {
  installedDeps = null;
}

let installedDeps: ApplicationMenuDeps | null = null;

function buildLabsMenuItem(
  deps: ApplicationMenuDeps
): MenuItemConstructorOptions {
  return {
    label: ENABLE_LABS_MENU_LABEL,
    type: "checkbox",
    checked: deps.isLabsNavEnabled(),
    click: (item) => {
      deps.setLabsNavEnabled(item.checked);
      // Re-derive from the store rather than trusting the item's own toggle:
      // if the write was rejected or coerced, the checkbox must show what was
      // actually persisted.
      refreshApplicationMenu();
    },
  };
}

/**
 * Default app name for the macOS application menu when a caller has no better
 * source. `app.getName()` reflects the `app.setName("Closedloop")` performed at
 * startup.
 */
export function defaultApplicationMenuName(): string {
  return app.getName();
}
