// Tell t3-env we're in a test environment to allow server-side env vars
process.env.SKIP_ENV_VALIDATION = "true";

// Set required environment variables for tests
// This must run before any imports that depend on env vars
process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_key";
process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://test.posthog.com";
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
process.env.NEXT_PUBLIC_WEB_URL = "http://localhost:3001";
process.env.NEXT_PUBLIC_DOCS_URL = "http://localhost:3004";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_key";
process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL = "/sign-in";
process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL = "/sign-up";
process.env.NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL = "/";
process.env.NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL = "/";
process.env.API_URL = "http://localhost:3002";

// Import jest-dom matchers for toBeInTheDocument, toHaveAttribute, etc.
import "@testing-library/jest-dom/vitest";

// Ensure DOM is cleaned up between tests so renders don't bleed into each other.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

const localStorageStore = new Map<string, string>();
const stableLocalStorage = createStableLocalStorage(localStorageStore);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: stableLocalStorage,
});
if (globalThis.window !== undefined) {
  Object.defineProperty(globalThis.window, "localStorage", {
    configurable: true,
    value: stableLocalStorage,
  });
}

afterEach(cleanup);
afterEach(() => {
  localStorageStore.clear();
});

// Mock scrollIntoView which is not implemented in jsdom
Element.prototype.scrollIntoView = () => {};

function createStableLocalStorage(
  store: Map<string, string>
): Pick<
  Storage,
  "clear" | "getItem" | "key" | "length" | "removeItem" | "setItem"
> {
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(String(key)) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(String(key));
    },
    setItem(key: string, value: string) {
      store.set(String(key), String(value));
    },
  };
}
