import { onTestFinished, vi } from "vitest";

// Generic module-with-fetch importer: stub fetch, reset the module graph, then
// dynamically import the caller-supplied module. Used by importLogWithFetch
// below and directly by tests that need to re-import sibling modules (e.g.
// `../telemetry/emitter`) under the same fresh-module guarantee.
export function importModuleWithFetch<T>(
  fetchMock: ReturnType<typeof vi.fn>,
  importFn: () => Promise<T>
): Promise<T> {
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  return importFn();
}

export async function importLogWithFetch(fetchMock: ReturnType<typeof vi.fn>) {
  const mod = await importModuleWithFetch(fetchMock, () => import("../log"));
  return mod.log;
}

export function parseFlushedBody<T>(
  fetchMock: ReturnType<typeof vi.fn>,
  callIndex = 0
): T[] {
  // Bounds check produces a clear assertion failure instead of an opaque
  // TypeError ("Cannot read properties of undefined") when the expected
  // flush did not produce a fetch call.
  const callCount = fetchMock.mock.calls.length;
  if (callIndex >= callCount) {
    throw new Error(
      `parseFlushedBody: no call at index ${callIndex} — fetchMock was called ${callCount} time(s)`
    );
  }
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body as string) as T[];
}

// Delete an env var for the current test and register a restore callback so
// the parent environment's value is reinstated when the test finishes —
// even on failure. vi.unstubAllEnvs() does NOT restore keys mutated by
// Reflect.deleteProperty, so a bare delete would leak into sibling tests in
// the same worker whenever the runner starts with the key defined.
export function deleteEnvForTest(...keys: readonly string[]): void {
  const originals: [string, string | undefined][] = keys.map((key) => [
    key,
    process.env[key],
  ]);
  for (const key of keys) {
    Reflect.deleteProperty(process.env, key);
  }
  onTestFinished(() => {
    for (const [key, value] of originals) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });
}
