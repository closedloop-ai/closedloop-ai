/**
 * @file electron-module-mock.ts
 * @description Electron-module mock for the desktop `test:node` runner
 * (ISS-4845).
 *
 * WHY THIS EXISTS. A main-process module that does `import { ipcMain } from
 * "electron"` cannot be imported under `tsx --test`: outside a real Electron
 * process the `electron` package's entrypoint is a path string, so the named
 * import fails at module-evaluation time and the module's Zod wire schema and
 * version-skew transform are unreachable to a test. The alternative — extracting
 * the schema into a standalone module — was tried and reverted on ISS-4667,
 * because relocating the compat-alias references into a NEW file needs a new
 * entry in the shrink-only source-gate allowlist, which that ratchet rejects.
 *
 * HOW. `module.registerHooks` installs a synchronous, in-thread resolve hook
 * that redirects the bare `electron` specifier to
 * {@link ./electron-module-stub.ts}. It is registered LAST, so it runs before
 * tsx's own resolver and short-circuits; the stub is a `.ts` file, so tsx's load
 * hook still transpiles it. The redirect is scoped to the exact `electron`
 * specifier — every other import resolves normally.
 *
 * The mock must be registered BEFORE the module under test is imported, so
 * callers use a dynamic `import()` after {@link registerElectronModuleMock}
 * returns. Always `deregister()` in the test's teardown: the hook is
 * process-global, and node:test runs files in the same process by default.
 */
import { registerHooks } from "node:module";

/** The bare specifier main-process modules import Electron through. */
const ELECTRON_SPECIFIER = "electron";

/**
 * The stub's URL, resolved from this file so it matches the URL a direct
 * `import "./electron-module-stub.js"` produces — same URL means Node's module
 * cache hands the test and the module under test the SAME stub instance, which
 * is what lets the test read back the handler the module registered.
 */
const ELECTRON_STUB_URL = new URL("./electron-module-stub.ts", import.meta.url)
  .href;

/** A registered mock; call {@link ElectronModuleMock.deregister} in teardown. */
export type ElectronModuleMock = {
  deregister: () => void;
};

/**
 * Redirect the `electron` specifier to the recording stub for the lifetime of
 * the returned handle.
 */
export function registerElectronModuleMock(): ElectronModuleMock {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === ELECTRON_SPECIFIER) {
        return { url: ELECTRON_STUB_URL, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  return {
    deregister: () => {
      hooks.deregister();
    },
  };
}
