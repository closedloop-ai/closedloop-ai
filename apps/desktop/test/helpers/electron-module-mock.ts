/**
 * @file electron-module-mock.ts
 * @description Electron-module mock for the desktop main-process suites
 * (ISS-4845, ISS-6258).
 *
 * WHY THIS EXISTS. A main-process module that does `import { ipcMain } from
 * "electron"` cannot be imported outside a real Electron process: there the
 * `electron` package's entrypoint is a path string, so the module's Zod wire
 * schema and version-skew transform are unreachable to a test. The alternative —
 * extracting the schema into a standalone module — was tried and reverted on
 * ISS-4667, because relocating the compat-alias references into a NEW file needs
 * a new entry in the shrink-only source-gate allowlist, which that ratchet
 * rejects.
 *
 * HOW. `vi.doMock` redirects the bare `electron` specifier to
 * {@link ./electron-main-module-stub.ts} for every import after
 * {@link registerElectronModuleMock} returns, so callers load the module under
 * test with a dynamic `import()`. The stub re-exports the bindings of
 * `./electron-module-stub.js`, which the test imports directly, so the test and
 * the module under test share one recording instance and a test can read back
 * the handler its subject registered.
 */
import { vi } from "vitest";

/** A registered mock; call {@link ElectronModuleMock.deregister} in teardown. */
export type ElectronModuleMock = {
  deregister: () => void;
};

/**
 * Redirect the `electron` specifier to the recording stub for the lifetime of
 * the returned handle.
 */
export function registerElectronModuleMock(): ElectronModuleMock {
  vi.doMock("electron", async () => {
    const stub = await import("./electron-main-module-stub.js");
    return { ...stub, default: stub.default };
  });
  return {
    deregister: () => {
      vi.doUnmock("electron");
    },
  };
}

/**
 * The preload twin: a preload bridge reaches `electron` both by static import
 * and through `createRequire` (`preload-common.ts`), so both specifiers are
 * redirected to the recording stub the test reads back. Call it before the
 * dynamic `import()` of the preload under test.
 */
export function registerElectronPreloadMock(): ElectronModuleMock {
  vi.doMock("electron", async () => {
    const stub = await import("./electron-module-stub.js");
    return { ...stub, default: stub.default };
  });
  vi.doMock("node:module", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:module")>();
    const stub = await import("./electron-module-stub.js");
    return {
      ...actual,
      createRequire: (from: string | URL) => {
        const required = actual.createRequire(from);
        return new Proxy(required, {
          apply: (_target, _thisArg, args: unknown[]) =>
            args[0] === "electron"
              ? stub
              : Reflect.apply(required, undefined, args as [string]),
        });
      },
    };
  });
  return {
    deregister: () => {
      vi.doUnmock("electron");
      vi.doUnmock("node:module");
    },
  };
}
