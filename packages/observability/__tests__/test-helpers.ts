import { onTestFinished, vi } from "vitest";

export async function importLogWithFetch(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const mod = await import("../log");
  return mod.log;
}

export function parseFlushedBody<T>(
  fetchMock: ReturnType<typeof vi.fn>,
  callIndex = 0
): T[] {
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
