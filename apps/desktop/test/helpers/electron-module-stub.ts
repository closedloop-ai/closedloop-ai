/**
 * @file electron-module-stub.ts
 * @description The module that stands in for `electron` under the desktop
 * `test:node` runner (ISS-4845).
 *
 * Main-process modules import Electron's `ipcMain` at MODULE SCOPE
 * (`import { ipcMain } from "electron"`). Outside a real Electron process the
 * `electron` npm package's entrypoint resolves to a path string, not a module
 * with named exports, so that import throws before any test can reach the
 * module's parse/transform logic. {@link registerElectronModuleMock} redirects
 * the `electron` specifier to THIS module so those modules import cleanly.
 *
 * It is a recording double, not a simulation: `ipcMain.handle` stores the
 * handler so a test can invoke it directly, which is exactly the round trip a
 * renderer's `ipcRenderer.invoke` performs. It deliberately does NOT reproduce
 * Electron's throw-on-duplicate-registration behaviour — that contract is
 * already covered by the fake registrar in
 * `agent-dashboard-disabled-ipc.test.ts`, and re-registering per test case is
 * how a harness keeps cases independent.
 */

/** The shape Electron passes to an `ipcMain.handle` callback. */
export type IpcMainInvokeEvent = {
  sender: unknown;
};

export type IpcMainInvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown;

/** The shape of an `ipcMain.on` listener (send/`postMessage`-style, no reply). */
export type IpcMainEventListener = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => void;

const invokeHandlers = new Map<string, IpcMainInvokeHandler>();
const eventListeners = new Map<string, IpcMainEventListener>();
let electronAppIsPackaged = false;

/**
 * The subset of Electron's `ipcMain` that main-process modules touch at import
 * and registration time.
 */
export const ipcMain = {
  handle(channel: string, handler: IpcMainInvokeHandler): void {
    invokeHandlers.set(channel, handler);
  },
  handleOnce(channel: string, handler: IpcMainInvokeHandler): void {
    invokeHandlers.set(channel, handler);
  },
  removeHandler(channel: string): void {
    invokeHandlers.delete(channel);
  },
  /**
   * ISS-5715 — `electron-log/main.js` calls `ipcMain.on(...)` at REQUIRE time,
   * so any module whose graph reaches `logging/persistent-log.ts` fails to
   * import under the mock unless the event-emitter arm exists. Recording rather
   * than simulating, matching `handle` above; nothing asserts on it yet.
   */
  on(channel: string, listener: IpcMainEventListener): void {
    eventListeners.set(channel, listener);
  },
  removeListener(channel: string): void {
    eventListeners.delete(channel);
  },
};

/**
 * The handler a module registered for `channel`.
 *
 * Throws when nothing is registered rather than returning `undefined`: a test
 * that silently invoked a missing handler would assert against whatever the
 * absence produced, which is how a harness reports a pass for a registration
 * that never happened.
 */
export function registeredInvokeHandler(channel: string): IpcMainInvokeHandler {
  const handler = invokeHandlers.get(channel);
  if (handler === undefined) {
    throw new Error(
      `No ipcMain handler registered for "${channel}" (registered: ${[...invokeHandlers.keys()].join(", ") || "none"})`
    );
  }
  return handler;
}

/** Drop every recorded handler so cases cannot leak registrations into each other. */
export function resetElectronModuleStub(): void {
  invokeHandlers.clear();
  eventListeners.clear();
  installedApplicationMenu = null;
  electronAppIsPackaged = false;
}

/**
 * ISS-5037 — the application-menu double. `main/app-menu.ts` imports `Menu` and
 * `app` at module scope, so both have to exist here for it to import at all.
 * `setApplicationMenu` records what was installed rather than simulating a
 * native menu, and `buildFromTemplate` hands the template straight back, so a
 * test can read the item tree the module actually built.
 */
export type StubMenuItem = {
  label?: string;
  type?: string;
  role?: string;
  checked?: boolean;
  click?: (item: { checked: boolean }) => void;
  submenu?: StubMenuItem[];
};

let installedApplicationMenu: StubMenuItem[] | null = null;

export const Menu = {
  buildFromTemplate(template: StubMenuItem[]): StubMenuItem[] {
    return template;
  },
  setApplicationMenu(menu: StubMenuItem[] | null): void {
    installedApplicationMenu = menu;
  },
};

/** The menu most recently passed to `Menu.setApplicationMenu`, if any. */
export function installedMenu(): StubMenuItem[] | null {
  return installedApplicationMenu;
}

/** The subset of Electron's `app` that main-process modules read at import time. */
export const app = {
  get isPackaged(): boolean {
    return electronAppIsPackaged;
  },
  getName(): string {
    return "Closedloop";
  },
};

export function setElectronAppIsPackaged(isPackaged: boolean): void {
  electronAppIsPackaged = isPackaged;
}

/**
 * ISS-5715 — some main-process modules take the DEFAULT export instead of named
 * ones (`import electron from "electron"; const { utilityProcess } = electron;`
 * in `db-host-client.ts`). Without a default here that import throws "does not
 * provide an export named 'default'" the moment the mock is installed, so any
 * suite reaching such a module could not use the stub at all.
 *
 * Deliberately does NOT provide `utilityProcess`: destructuring it yields
 * `undefined`, exactly as it does against the unmocked `electron` entrypoint
 * (a path string). A test that needs a child process injects one through the
 * owning module's `fork` seam rather than having the stub fake Electron's
 * process model.
 */
export default { app, ipcMain, Menu };
