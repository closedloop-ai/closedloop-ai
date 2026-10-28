/**
 * @file electron-main-module-stub.ts
 * @description The MAIN-PROCESS-ONLY face of the recording Electron double
 * (ISS-6712).
 *
 * WHY THIS EXISTS, and why it is a separate module rather than a flag.
 * `electron-log` branches on the SHAPE of the `electron` it resolves —
 * `src/renderer/electron-log-preload.js` runs
 * `if (electron.ipcRenderer) { initialize(electron); }` at module scope, and
 * `src/main/initialize.js` requires that preload unconditionally, so anything
 * importing `electron-log/main.js` (this app does, in
 * `src/main/logging/persistent-log.ts`) evaluates it. Its initializer ends in a
 * bare `__electronLog = electronLog` assignment when there is no `window`, which
 * outside a renderer is a `ReferenceError` that kills the whole test file.
 * ISS-6712 hit it when `electron-module-mock.ts` was a process-global Node
 * loader hook that also rewrote `electron` inside `node_modules`. Since
 * ISS-6258 the mock is `vi.doMock`, which does not reach `electron-log` (it is
 * CJS, Vitest externalizes it, and Node resolves the real `electron` for it), so
 * keeping the preload arms OFF this module is now defensive: it holds if a mock
 * that does reach `node_modules` comes back.
 *
 * The bindings are re-exported from {@link ./electron-module-stub.ts} rather
 * than redeclared, so the test and the module under test share ONE recording
 * instance and a test can still read back the handler its subject registered.
 * A suite that genuinely needs the preload arms imports the full stub directly,
 * under its own `vi.mock` — which is what `desktop-db-ipc-channel-parity.test.ts` does.
 */

import electronModuleStub from "./electron-module-stub.js";

// Bound off the full stub's default export rather than re-exported from it: a
// re-export (`export … from`) is a barrel (`noBarrelFile`) and exporting the
// imported binding directly trips `noExportedImports`. These are the SAME object
// references either way, which is what keeps the handler maps single-instance.
export const app = electronModuleStub.app;
export const ipcMain = electronModuleStub.ipcMain;
export const Menu = electronModuleStub.Menu;
export const shell = electronModuleStub.shell;

export default { app, ipcMain, Menu, shell };
