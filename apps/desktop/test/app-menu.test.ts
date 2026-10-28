/**
 * @file app-menu.test.ts
 * @description ISS-5037 / ISS-8753 — the native application menu.
 *
 * `main/app-menu.ts` imports `Menu` from Electron at module scope, so it is
 * unreachable from `test:node` without the electron-module mock. These cases
 * drive the REAL template builder and the REAL install path.
 *
 * CARRIED FORWARD from `app-menu-labs.test.ts`, which was deleted with the
 * "Enable Labs" checkbox it existed for. Three of that file's contracts are
 * genuinely RETIRED — that the item is a checkbox, that clicking it persists
 * through the injected setter, and that its checked state is re-derived from the
 * store on refresh — because after the PostHog cutover the store it wrote had no
 * reader left, and the item, its deps and the rebuild machinery are gone.
 *
 * ONE CONTRACT IS NOT RETIRED, and it is the reason this module exists at all:
 * owning the template must not cost the user anything Electron's inherited
 * default menu gave them. That default is also what showed a literal "Electron"
 * app menu on macOS, so the app-name and the standard roles are asserted here
 * together — a template that dropped `quit` or `editMenu` to fix the name would
 * be a worse bug than the one it fixed.
 */
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  installedMenu,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

type AppMenuModule = typeof import("../src/main/app-menu.js");

const APP_NAME = "Closedloop";
const APP_MENU_ROLES = ["about", "services", "hide", "quit"];
const MENU_BAR_ROLES = ["fileMenu", "editMenu", "viewMenu", "windowMenu"];

let mock: ElectronModuleMock;
let appMenu: AppMenuModule;

beforeAll(async () => {
  mock = registerElectronModuleMock();
  appMenu = (await import("../src/main/app-menu.js")) as AppMenuModule;
});

afterAll(() => {
  mock.deregister();
});

afterEach(() => {
  resetElectronModuleStub();
});

const darwinDeps = {
  appName: APP_NAME,
  platform: "darwin" as NodeJS.Platform,
};

describe("application menu", () => {
  it("names the macOS application menu after the app, not Electron", () => {
    const template = appMenu.buildApplicationMenuTemplate(darwinDeps);

    // The app menu is FIRST on macOS, which is what makes this THE application
    // menu — the one that read "Electron" before this module owned the template.
    assert.equal(template[0]?.label, APP_NAME);
  });

  it("keeps every standard role the inherited default menu provided", () => {
    const template = appMenu.buildApplicationMenuTemplate(darwinDeps);

    const appRoles = (template[0]?.submenu ?? []).map((entry) => entry.role);
    for (const role of APP_MENU_ROLES) {
      assert.ok(appRoles.includes(role), `app menu must keep the ${role} role`);
    }
    const topRoles = template.map((entry) => entry.role);
    for (const role of MENU_BAR_ROLES) {
      assert.ok(topRoles.includes(role), `menu bar must keep the ${role} role`);
    }
  });

  it("keeps the standard roles off macOS too, where there is no app menu", () => {
    const template = appMenu.buildApplicationMenuTemplate({
      ...darwinDeps,
      platform: "win32",
    });

    // No application-menu entry to hang an app name off, so the menu bar's own
    // roles are the whole contract here.
    const topRoles = template.map((entry) => entry.role);
    for (const role of MENU_BAR_ROLES) {
      assert.ok(topRoles.includes(role), `menu bar must keep the ${role} role`);
    }
    assert.equal(
      template.find((entry) => entry.label === APP_NAME),
      undefined,
      "no macOS-style application menu off darwin"
    );
  });

  it("installs the template it builds", () => {
    appMenu.installApplicationMenu(darwinDeps);

    const menu = installedMenu();
    assert.ok(menu, "an application menu must be installed");
    assert.equal(menu[0]?.label, APP_NAME);
  });
});
