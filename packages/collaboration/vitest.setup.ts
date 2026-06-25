// Register jest-dom matchers (toBeInTheDocument, toHaveTextContent, etc.).
// @testing-library/react auto-registers afterEach cleanup with Vitest
// when test.globals is true (it is — see vitest.config.ts).
import "@testing-library/jest-dom/vitest";

// jsdom 27 on Node 26 ships sessionStorage but not localStorage (Node's
// experimental native localStorage requires --localstorage-file and is
// otherwise undefined). Provide a minimal in-memory polyfill so client
// stores backed by localStorage are testable. Browser semantics —
// values stringified, missing keys return null.
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
  };
}

// Gate on `window` so this only runs in the jsdom-scoped tests; accessing
// globalThis.localStorage in Node without --localstorage-file emits a noisy
// ExperimentalWarning, and node-env tests don't use localStorage anyway.
if (globalThis.window !== undefined && globalThis.localStorage === undefined) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createMemoryStorage(),
  });
}
