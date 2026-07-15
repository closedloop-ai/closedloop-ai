import { afterEach } from "vitest";

// jsdom 27+ on Node 22+ no longer provides localStorage. Node's own
// experimental localStorage requires --localstorage-file and is otherwise
// a no-op stub. This polyfill installs an isolated in-memory Storage on
// both globalThis and window (jsdom sets window; plain node tests skip the
// block entirely), then clears it after every test so suites can't bleed
// state into each other.
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

if (globalThis.window !== undefined) {
  const storage = createMemoryStorage();
  for (const target of [globalThis, globalThis.window] as const) {
    Object.defineProperty(target, "localStorage", {
      configurable: true,
      value: storage,
    });
  }
  afterEach(() => {
    storage.clear();
  });
}
