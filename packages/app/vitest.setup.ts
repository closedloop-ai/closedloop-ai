// jest-dom matchers (toBeInTheDocument, toHaveValue, toBeDisabled, etc.) for
// component-render tests co-located in @repo/app slices.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

function createMemoryStorage(): Storage {
  const items = new Map<string, string>();

  return {
    get length() {
      return items.size;
    },
    clear() {
      items.clear();
    },
    getItem(key: string) {
      return items.get(String(key)) ?? null;
    },
    key(index: number) {
      return Array.from(items.keys())[index] ?? null;
    },
    removeItem(key: string) {
      items.delete(String(key));
    },
    setItem(key: string, value: string) {
      items.set(String(key), String(value));
    },
  };
}

const testStorage = createMemoryStorage();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: testStorage,
});

if (globalThis.window) {
  Object.defineProperty(globalThis.window, "localStorage", {
    configurable: true,
    value: testStorage,
  });
}

// Mock scrollIntoView which is not implemented in jsdom (parity with apps/app's
// setup). Guarded for `@vitest-environment node` files where Element is undefined.
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView = () => {};
}

// Isolate persisted client state between tests (parity with apps/app's setup),
// so a test asserting "nothing was written" isn't tripped by a prior test's keys.
afterEach(() => {
  testStorage.clear();
});
