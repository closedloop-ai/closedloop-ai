/**
 * @file electron-module-mock-preload-free.test.ts
 * @description ISS-6712 regression guard: the mocked `electron` must not look
 * like a preload context.
 *
 * WHAT BROKE. `electron-log` branches on the shape of the `electron` it
 * resolves: `src/renderer/electron-log-preload` runs
 * `if (electron.ipcRenderer) { initialize(electron); }` at module scope,
 * `src/main/initialize.js` requires that preload unconditionally, and this app
 * imports `electron-log/main.js` from `src/main/logging/persistent-log.ts`. The
 * initializer ends in a bare `__electronLog = electronLog` when there is no
 * `window`, so it throws `ReferenceError: __electronLog is not defined` and
 * takes the whole file down. When `registerElectronModuleMock` was a
 * process-global loader hook (before ISS-6258), adding the preload arms to its
 * target broke two suites that neither import them nor mention Electron's
 * renderer side (`db-host-unexpected-exit-telemetry`,
 * `session-owner-claim-retry`).
 *
 * The `vi.doMock` that replaced that hook does not reach `electron-log` (CJS,
 * externalized by Vitest, so Node resolves the real `electron` for it), so the
 * hazard cannot recur through today's mock. This guard is kept defensively, for
 * a mock mechanism that does reach `node_modules`: whatever the mock redirects
 * to must not carry `ipcRenderer` or `contextBridge`. A suite that needs the preload arms imports
 * `electron-module-stub.js` directly under its own `vi.mock`.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import electronMainStub from "./helpers/electron-main-module-stub.js";

/**
 * Loaded dynamically rather than with a namespace import (`noNamespaceImport`),
 * and because the assertions are about which keys the module namespace DOES and
 * does not carry — a named import of an absent export would not compile, which
 * is the wrong failure for a guard that has to report the key by name.
 */
const mainStubNamespace = await import(
  "./helpers/electron-main-module-stub.js"
);
const fullStubNamespace = await import("./helpers/electron-module-stub.js");

/** The exact property `electron-log`'s preload branches on. */
const ELECTRON_LOG_PRELOAD_TRIGGER = "ipcRenderer";
const PRELOAD_ONLY_ELECTRON_KEYS = [
  ELECTRON_LOG_PRELOAD_TRIGGER,
  "contextBridge",
] as const;

test("the redirected electron module exposes no preload arm", () => {
  for (const key of PRELOAD_ONLY_ELECTRON_KEYS) {
    // The default export is what a CJS `require("electron")` inside
    // `node_modules` reads through interop.
    assert.equal(
      Object.hasOwn(electronMainStub, key),
      false,
      `electron-main-module-stub's default export must not carry '${key}' — a mock that reaches node_modules would hand it to electron-log, which then self-initializes its renderer preload and throws ReferenceError: __electronLog outside a renderer`
    );
    // And the namespace, which is what `require(esm)` hands back.
    assert.equal(
      Object.hasOwn(mainStubNamespace, key),
      false,
      `electron-main-module-stub must not export '${key}'`
    );
  }
});

test("the main-only facade still carries the main-process arms it stands in for", () => {
  // Positive control: the assertion above must fail because the preload arms are
  // absent, not because the facade is empty or resolved to the wrong module.
  for (const key of ["app", "ipcMain", "Menu", "shell"]) {
    assert.ok(
      Object.hasOwn(electronMainStub, key),
      `electron-main-module-stub's default export must carry '${key}'`
    );
  }
  // One recording instance: the facade re-exports the full stub's bindings, so a
  // test reading the full stub sees the handler the module under test
  // registered through the redirect. Re-declaring them would silently split the
  // handler maps in two.
  assert.equal(mainStubNamespace.ipcMain, fullStubNamespace.ipcMain);
  assert.equal(mainStubNamespace.app, fullStubNamespace.app);
});

test("the full stub still offers the preload arms to module-scoped mocks", () => {
  // The capability ISS-6712 added is not withdrawn — it is confined to the stub
  // a suite that mocks `electron` with it directly.
  for (const key of PRELOAD_ONLY_ELECTRON_KEYS) {
    assert.ok(
      Object.hasOwn(fullStubNamespace, key),
      `electron-module-stub must still export '${key}' for the preload derivation`
    );
  }
});
