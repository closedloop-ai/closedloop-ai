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
 * renderer's `ipcRenderer.invoke` performs. It deliberately does NOT THROW on a
 * duplicate registration the way real Electron does — re-registering per test
 * case is how a harness keeps cases independent, and an installer that is safe
 * to re-run over live channels would otherwise be untestable. It does RECORD
 * them ({@link duplicateRegisteredChannels}), because the handler store is a Map
 * and a silent second registration replaces the first without a trace.
 */

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
const duplicateRegistrations: string[] = [];
let electronAppIsPackaged = false;
let appQuitCalls = 0;
const appLifecycleCalls: string[] = [];

/**
 * The subset of Electron's `ipcMain` that main-process modules touch at import
 * and registration time.
 */
export const ipcMain = {
  handle(channel: string, handler: IpcMainInvokeHandler): void {
    recordRegistration(channel);
    invokeHandlers.set(channel, handler);
  },
  handleOnce(channel: string, handler: IpcMainInvokeHandler): void {
    recordRegistration(channel);
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
  duplicateRegistrations.length = 0;
  rendererInvokedChannels.length = 0;
  rendererInvokedArgs.length = 0;
  exposedMainWorldApis.clear();
  installedApplicationMenu = null;
  electronAppIsPackaged = false;
  appQuitCalls = 0;
  appLifecycleCalls.length = 0;
  shellOpenPathCalls.length = 0;
  shellOpenExternalCalls.length = 0;
}

/**
 * ISS-5037 — the application-menu double. `main/app-menu.ts` imports `Menu` at
 * module scope, so it has to exist here for that module to import at all. (The
 * `app` double above stays regardless: ISS-5703 dropped app-menu's own `app`
 * import, but other main-process modules this stub serves still reach for it.)
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
  /**
   * ISS-6882 — `agent-dashboard-catalog-pack-ipc.ts` builds the `open-plan`
   * allowlist root from `app.getPath("home")` at HANDLER time. Answering with
   * the real home keeps that allowlist the same one production computes.
   *
   * ISS-8143 added handler-level `open-plan` cases in `safe-plan-file.test.ts`,
   * so the path IS driven now — but they scope their fixtures with `CLAUDE_HOME`,
   * which `resolveOpenablePlanFilePath` reads directly, so no assertion depends
   * on this value.
   */
  getPath(name: string): string {
    if (name === "home") {
      return homedir();
    }
    return join(tmpdir(), `closedloop-electron-stub-${name}`);
  },
  /**
   * ISS-4514 — `ipc/update-ipc.ts` compares the feed's version against the
   * running build's to decide whether an update is on offer. A fixed value is
   * enough because every case that cares supplies the REMOTE version, so the
   * comparison is driven from the test's side; {@link STUB_APP_VERSION} is
   * exported so a same-version case can name it rather than re-spell it.
   */
  getVersion(): string {
    return STUB_APP_VERSION;
  },
  /**
   * ISS-4514 — the packaged apply path requests a GRACEFUL quit instead of
   * calling `quitAndInstall` inline (FEA-2026), so `app.quit` is the observable
   * act that path performs. Recording rather than simulating, matching `ipcMain`
   * above: really quitting would take the test runner with it.
   */
  quit(): void {
    appQuitCalls += 1;
  },
  /**
   * ISS-11596 — the dev-mode apply path (`dev-update-commands.ts`) calls
   * `relaunch()` then `exit(0)` after its rebuild. Recorded, in order, rather
   * than performed, for the same reason as `quit` above.
   */
  relaunch(): void {
    appLifecycleCalls.push("relaunch");
  },
  exit(code?: number): void {
    appLifecycleCalls.push(`exit:${code ?? 0}`);
  },
};

export function setElectronAppIsPackaged(isPackaged: boolean): void {
  electronAppIsPackaged = isPackaged;
}

/** The `app.relaunch()` and `app.exit(code)` calls a module under test made, in order. */
export function electronAppLifecycleCalls(): readonly string[] {
  return [...appLifecycleCalls];
}

/** How many times a module under test called `app.quit()`. */
export function electronAppQuitCallCount(): number {
  return appQuitCalls;
}

/**
 * ISS-6882 — the recording `shell` double. `agent-dashboard-catalog-pack-ipc.ts`
 * takes `shell` as a NAMED import at module scope, so without it here the whole
 * pack-IPC registrar is unimportable under the mock ("does not provide an export
 * named 'shell'"). Recording rather than simulating, matching `ipcMain` above:
 * opening a path or a URL is an OS side effect a test must never actually take.
 */
const shellOpenPathCalls: string[] = [];
const shellOpenExternalCalls: string[] = [];

export const shell = {
  openPath(target: string): Promise<string> {
    shellOpenPathCalls.push(target);
    return Promise.resolve("");
  },
  openExternal(url: string): Promise<void> {
    shellOpenExternalCalls.push(url);
    return Promise.resolve();
  },
};

/** Every path handed to `shell.openPath`, oldest first. */
export function openedPaths(): readonly string[] {
  return [...shellOpenPathCalls];
}

/** Every URL handed to `shell.openExternal`, oldest first. */
export function openedExternalUrls(): readonly string[] {
  return [...shellOpenExternalCalls];
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
/**
 * ISS-6712 — the PRELOAD half of the stub.
 *
 * A preload entrypoint is the mirror image of a main-process module: it imports
 * `ipcRenderer`/`contextBridge` from `electron` at module scope and, on import,
 * builds and exposes its bridge object. Recording both arms lets a suite import
 * the real preload and read back the api the renderer would actually receive,
 * then call through it to learn which channels each bridge method invokes —
 * rather than re-listing those channels in the test.
 *
 * `invoke` resolves `undefined` on purpose: the channel NAME is what a caller
 * observes here, and a stub that returned a plausible payload would let a bridge
 * whose result handling is wrong look correct.
 */
const rendererInvokedChannels: string[] = [];
/**
 * The ARGUMENTS each `invoke` carried, parallel to the channel list.
 *
 * Kept beside the channel names rather than replacing them: a bridge's channel
 * is a set-equality contract (`desktop-db-ipc-channel-parity.test.ts`) and its
 * payload is a per-bridge one, and collapsing the two would make the parity
 * suite's derivation depend on argument shapes it deliberately says nothing
 * about.
 */
const rendererInvokedArgs: unknown[][] = [];
const exposedMainWorldApis = new Map<string, Record<string, unknown>>();

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    rendererInvokedChannels.push(channel);
    rendererInvokedArgs.push(args);
    return Promise.resolve(undefined);
  },
  send(_channel: string, ..._args: unknown[]): void {
    // Fire-and-forget renderer→main sends. Recorded by nothing yet; present so
    // a preload that sends at import time can be imported at all.
  },
  on(_channel: string, _listener: (...args: never[]) => void): void {
    // Main→renderer pushes. Same rationale as `send`.
  },
  removeListener(
    _channel: string,
    _listener: (...args: never[]) => void
  ): void {
    // Paired with `on` so a bridge's unsubscribe closure can be called.
  },
};

export const contextBridge = {
  exposeInMainWorld(key: string, api: Record<string, unknown>): void {
    exposedMainWorldApis.set(key, api);
  },
};

/**
 * The api object a preload handed `contextBridge.exposeInMainWorld` under `key`.
 *
 * Throws when the preload exposed nothing, for the same reason
 * {@link registeredInvokeHandler} does: a suite that read `undefined` here would
 * go on to assert against the absence of the thing it meant to test.
 */
export function exposedMainWorldApi(key: string): Record<string, unknown> {
  const api = exposedMainWorldApis.get(key);
  if (api === undefined) {
    throw new Error(
      `No contextBridge.exposeInMainWorld("${key}") call recorded (exposed: ${[...exposedMainWorldApis.keys()].join(", ") || "none"})`
    );
  }
  return api;
}

/** Channels passed to `ipcRenderer.invoke` so far, in call order. */
export function rendererInvokeChannels(): string[] {
  return [...rendererInvokedChannels];
}

/**
 * The arguments of every `ipcRenderer.invoke` on `channel` so far, in call
 * order — what a preload bridge actually FORWARDED, as opposed to which channel
 * it reached.
 */
export function rendererInvokeArgsFor(channel: string): unknown[][] {
  return rendererInvokedArgs.filter(
    (_args, index) => rendererInvokedChannels[index] === channel
  );
}

/**
 * Channels registered MORE THAN ONCE without an intervening `removeHandler`.
 *
 * Real Electron throws on a duplicate `ipcMain.handle`; this stub deliberately
 * does not, because an installer that is safe to re-run over live channels would
 * then be untestable. But swallowing it silently is its own hazard: the handler
 * store is a Map, so a second registration of the same channel REPLACES the
 * first and leaves no trace — a channel shadowed by a later, weaker handler
 * would be invisible to every assertion over {@link registeredInvokeChannels}.
 * Recording the collision lets a suite assert on it instead.
 */
export function duplicateRegisteredChannels(): string[] {
  return [...duplicateRegistrations];
}

function recordRegistration(channel: string): void {
  if (invokeHandlers.has(channel)) {
    duplicateRegistrations.push(channel);
  }
}

/** Channels a module registered an `ipcMain.handle` handler for, in call order. */
export function registeredInvokeChannels(): string[] {
  return [...invokeHandlers.keys()];
}

/** The version {@link app.getVersion} reports; see its doc comment. */
export const STUB_APP_VERSION = "0.0.0-electron-stub";

export default { app, contextBridge, ipcMain, ipcRenderer, Menu, shell };
