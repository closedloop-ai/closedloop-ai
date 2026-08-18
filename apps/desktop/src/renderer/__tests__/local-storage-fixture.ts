import { vi } from "vitest";

/**
 * Install an in-memory `window.localStorage` for a renderer test.
 *
 * The renderer vitest jsdom environment does not provide a usable `Storage` on
 * `window`, so any test covering a persisted renderer preference has to supply
 * one. Extracted (ISS-5258) once a second suite — the import splash's
 * collapsed/expanded preference — needed the same fixture as the app-shell
 * suites, whose copy now lives here rather than inside `app-shell-harness.tsx`.
 *
 * Returns the restore function; call it from `afterEach`.
 */
export function installLocalStorage(): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "localStorage"
  );
  const entries = new Map<string, string>();
  const storage = {
    clear: vi.fn(() => entries.clear()),
    getItem: vi.fn((key: string) =>
      entries.has(key) ? (entries.get(key) ?? null) : null
    ),
    key: vi.fn((index: number) => Array.from(entries.keys())[index] ?? null),
    get length() {
      return entries.size;
    },
    removeItem: vi.fn((key: string) => {
      entries.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
    }),
  } satisfies Storage;

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });

  return () => {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(window, "localStorage");
      return;
    }
    Object.defineProperty(window, "localStorage", originalDescriptor);
  };
}
