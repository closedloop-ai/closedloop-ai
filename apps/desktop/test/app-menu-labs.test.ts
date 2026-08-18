/**
 * @file app-menu-labs.test.ts
 * @description ISS-5037 — the "Enable Labs" application-menu easter egg.
 *
 * `main/app-menu.ts` imports `Menu` and `app` from Electron at module scope, so
 * it is unreachable from `test:node` without the electron-module mock. These
 * cases drive the REAL template builder and the REAL install/refresh path, so
 * the three things the ticket actually promises are pinned:
 *
 *   1. the item is a `type: "checkbox"` labelled "Enable Labs" living in the
 *      macOS APPLICATION menu (the "Electron"/Closedloop menu), not a settings
 *      panel — and every standard role the inherited default menu provided
 *      (about/services/hide/quit, File/Edit/View/Window) survives owning the
 *      template;
 *   2. clicking it PERSISTS the new value through the injected setter — that is
 *      what makes the choice survive a relaunch and what broadcasts
 *      `desktop:flags-changed` so the sidebar reacts with no restart;
 *   3. the checked state is re-derived from the STORE, so a value changed by
 *      any other path (the settings IPC) cannot leave the checkbox claiming a
 *      state the store disagrees with.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  installedMenu,
  resetElectronModuleStub,
  type StubMenuItem,
} from "./helpers/electron-module-stub.js";

type AppMenuModule = typeof import("../src/main/app-menu.js");

let mock: ElectronModuleMock;
let appMenu: AppMenuModule;

before(async () => {
  mock = registerElectronModuleMock();
  appMenu = (await import("../src/main/app-menu.js")) as AppMenuModule;
});

after(() => {
  mock.deregister();
});

afterEach(() => {
  appMenu.resetApplicationMenuForTests();
  resetElectronModuleStub();
});

/** A settings store double: one persisted boolean, recorded writes. */
function makeLabsStore(initial: boolean) {
  const writes: boolean[] = [];
  let value = initial;
  return {
    writes,
    deps: {
      appName: "Closedloop",
      platform: "darwin" as NodeJS.Platform,
      isLabsNavEnabled: () => value,
      setLabsNavEnabled: (enabled: boolean) => {
        writes.push(enabled);
        value = enabled;
      },
    },
    /** Simulate a write from ANOTHER path (e.g. the settings IPC). */
    setExternally: (enabled: boolean) => {
      value = enabled;
    },
  };
}

function findItem(
  items: readonly StubMenuItem[] | undefined,
  label: string
): StubMenuItem | undefined {
  return items?.find((item) => item.label === label);
}

/**
 * The installed menu's "Enable Labs" item. THROWS rather than asserting when it
 * is missing: a helper that returned `undefined` would let a case assert against
 * the absence and report a pass for a menu that was never built.
 */
function labsItemFromInstalledMenu(): StubMenuItem {
  const menu = installedMenu();
  if (!menu) {
    throw new Error("No application menu was installed");
  }
  const item = findItem(
    findItem(menu, "Closedloop")?.submenu,
    appMenu.ENABLE_LABS_MENU_LABEL
  );
  if (!item) {
    throw new Error('"Enable Labs" is not in the application menu');
  }
  return item;
}

describe("ISS-5037 application menu — Enable Labs", () => {
  it("hangs a checkbox off the macOS application menu without dropping the default roles", () => {
    const store = makeLabsStore(false);

    const template = appMenu.buildApplicationMenuTemplate(store.deps);

    // The app menu is FIRST on macOS, which is what makes this the "Electron"
    // (here: Closedloop) menu rather than a new top-level menu of our own.
    assert.equal(template[0]?.label, "Closedloop");
    const item = findItem(template[0]?.submenu, appMenu.ENABLE_LABS_MENU_LABEL);
    assert.ok(item, '"Enable Labs" must be in the application menu');
    assert.equal(item.type, "checkbox");
    assert.equal(item.checked, false, "must reflect the default-OFF setting");

    // Owning the template must not cost the user anything the inherited default
    // menu gave them.
    const appRoles = (template[0]?.submenu ?? []).map((entry) => entry.role);
    for (const role of ["about", "services", "hide", "quit"]) {
      assert.ok(appRoles.includes(role), `app menu must keep the ${role} role`);
    }
    const topRoles = template.map((entry) => entry.role);
    for (const role of ["fileMenu", "editMenu", "viewMenu", "windowMenu"]) {
      assert.ok(topRoles.includes(role), `menu bar must keep the ${role} role`);
    }
  });

  it("keeps the toggle reachable off macOS, where there is no application menu", () => {
    const store = makeLabsStore(false);

    const template = appMenu.buildApplicationMenuTemplate({
      ...store.deps,
      platform: "win32",
    });

    // Without this the gate would be a one-way door on Windows/Linux: Labs
    // hidden by default and no control anywhere to turn it back on.
    const labsMenu = findItem(template, appMenu.LABS_MENU_LABEL);
    const item = findItem(labsMenu?.submenu, appMenu.ENABLE_LABS_MENU_LABEL);
    assert.ok(item, '"Enable Labs" must be reachable off macOS');
    assert.equal(item.type, "checkbox");
  });

  it("reflects an already-enabled setting as checked", () => {
    const store = makeLabsStore(true);

    appMenu.installApplicationMenu(store.deps);

    assert.equal(labsItemFromInstalledMenu().checked, true);
  });

  it("persists the new value when the item is clicked", () => {
    const store = makeLabsStore(false);
    appMenu.installApplicationMenu(store.deps);

    // Electron flips the item's own `checked` before invoking `click`.
    labsItemFromInstalledMenu().click?.({ checked: true });

    assert.deepEqual(store.writes, [true]);
    // And the rebuilt menu shows the persisted value, not the click's guess.
    assert.equal(labsItemFromInstalledMenu().checked, true);
  });

  it("re-derives the checked state from the store when the flag changes elsewhere", () => {
    const store = makeLabsStore(false);
    appMenu.installApplicationMenu(store.deps);
    assert.equal(labsItemFromInstalledMenu().checked, false);

    // A write that did NOT come from the menu (the settings IPC path).
    store.setExternally(true);
    appMenu.refreshApplicationMenu();

    assert.equal(
      labsItemFromInstalledMenu().checked,
      true,
      "the checkbox must not claim a state the store disagrees with"
    );
    assert.deepEqual(store.writes, [], "a refresh must not write anything");
  });

  it("refreshing before install is a no-op rather than a crash", () => {
    appMenu.refreshApplicationMenu();

    assert.equal(installedMenu(), null);
  });
});
