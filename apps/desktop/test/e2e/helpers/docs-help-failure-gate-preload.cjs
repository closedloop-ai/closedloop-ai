"use strict";

/**
 * E2E-only: reject the desktop `docsHelp` getPage/search IPC reads on demand, so
 * a spec can drive the ISS-10044 failure states in the LAUNCHED app (ISS-10366).
 *
 * WHY THIS EXISTS. ISS-10044 gave the reader a `page.kind === "error"` branch and
 * the docs search a `searchFailed` flag, so a transport failure stops being
 * rendered as a claim about the bundled snapshot's contents: a rejected `getPage`
 * must reach `HelpReaderUnavailable`, not `HelpReaderMissing`'s "isn't in the
 * bundled docs snapshot", and a rejected `search` must reach the palette's
 * failure row and its retry item, not `No results`. The renderer suites prove the
 * components derive that; only a launched app proves the real chain
 * `ipcMain handler -> preload bridge -> hook -> surface` does.
 *
 * The renderer cannot substitute the input itself. `desktopApi` is installed by
 * `contextBridge.exposeInMainWorld` (`preload-common.ts`), which Electron makes
 * read-only and non-configurable, and the exposed object is deep-frozen — the
 * same wall `help-surface-v2.spec.ts` documents after the marisolashgrove review.
 * There is no HTTP on this path either, so `page.route` intercepts nothing. The
 * one input a spec cannot otherwise produce — a bundle read that rejects on
 * demand — is substituted here, at the IPC response boundary. Everything else is
 * the real thing: the real handlers and their real reads before arming, the real
 * `status`/`nav` (never wrapped, so the surface still reaches its reader pane),
 * the real preload bridge, and the real mounted surfaces.
 *
 * ARMED PER CHANNEL, because the two cases are different claims: the Help case
 * fails only `getPage` while search is untouched, and the palette case fails only
 * `search`. A single switch would let either spec pass while the other channel
 * was the one that broke.
 *
 * INERT until the spec arms it, so a successful read lands first — that is what
 * makes the failure assertion a CHANGE of state rather than a surface that never
 * worked. DISARMABLE for the same reason in reverse: a retry that recovers is
 * what proves the gate, and not the app, was producing the failure.
 *
 * HOW. Electron's `-r` loads this in the main process before the app's own
 * entrypoint, so it can wrap `ipcMain.handle` and decorate the listener for these
 * channels as the app registers them. Registering handlers directly here would
 * make the app's own `ipcMain.handle` for the same channel throw ("Attempted to
 * register a second handler") and take the app down — the same reason
 * `sessions-list-failure-gate-preload.cjs` wraps rather than registers.
 *
 * Loaded ONLY when the env var is set, and only ever from `test/e2e/helpers` — it
 * ships in no build.
 */

const { ipcMain } = require("electron");

/** `DocsHelpIpcChannel.GetPage` / `.Search` (`src/shared/docs-help-contract.ts`). */
const CHANNELS = {
  getPage: "desktop:docs-help:get-page",
  search: "desktop:docs-help:search",
};

/** Read from the spec through `ElectronApplication.evaluate`. */
const GATE_KEY = "__clE2eDocsHelpFailureGate";

/**
 * What the armed handlers reject with. A plain `Error`, carrying nothing the
 * renderer could classify: both hooks catch every rejection alike, and a
 * recognizable shape would let a future narrowing pass this gate while a real
 * transport failure still fell through to the contents claim.
 */
const FAILURE_MESSAGE = "e2e docs-help read failure";

if (process.env.CL_E2E_DOCS_HELP_FAILURE_GATE === "1") {
  /** One independent sub-gate per wrapped channel. */
  const makeOperationGate = () => ({
    failing: false,
    /** Reads answered by the real handler (i.e. while disarmed). */
    succeeded: 0,
    /** Reads rejected while armed — what the spec polls to know it landed. */
    failed: 0,
  });

  const operations = {
    getPage: makeOperationGate(),
    search: makeOperationGate(),
  };

  const readOperation = (operation) => {
    const found = Object.hasOwn(operations, operation)
      ? operations[operation]
      : undefined;
    if (!found) {
      throw new Error(
        `unknown docs-help failure gate operation "${operation}"`
      );
    }
    return found;
  };

  globalThis[GATE_KEY] = {
    arm(operation) {
      readOperation(operation).failing = true;
    },
    disarm(operation) {
      readOperation(operation).failing = false;
    },
    stats(operation) {
      const gate = readOperation(operation);
      return { failed: gate.failed, succeeded: gate.succeeded };
    },
  };

  const registerHandler = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    const operation = Object.keys(CHANNELS).find(
      (name) => CHANNELS[name] === channel
    );
    if (operation === undefined) {
      return registerHandler(channel, listener);
    }
    const gate = operations[operation];
    return registerHandler(channel, async (event, ...args) => {
      if (gate.failing) {
        gate.failed += 1;
        throw new Error(FAILURE_MESSAGE);
      }
      // `await` because the docs-help handlers are synchronous and a future one
      // may not be; either way the count must follow the real answer.
      const response = await listener(event, ...args);
      gate.succeeded += 1;
      return response;
    });
  };
}
