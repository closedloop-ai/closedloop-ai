import { afterEach, beforeEach, vi } from "vitest";
import {
  DASHBOARD_FLAG_SET,
  dashboardOnboardedStorageKey,
} from "../components/dashboard/dashboard-storage-keys";

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
  // An installed store models an install that HAS RUN BEFORE, not a first
  // launch. ISS-10195 made that distinction load-bearing: the guided onboarding
  // run arms on a first run and reads this latch, so a bare store put a blocking
  // modal — `pointer-events: none` on the body, the shell `aria-hidden` — over
  // every suite that mounts the shell without seeding it.
  //
  // Same seed and same reason as `setupReturningInstallStorage` below, moved
  // here so a suite gets it by installing a store rather than by remembering.
  // A suite whose SUBJECT is first run either stubs `globalThis.localStorage`
  // instead (`stubLocalStorage`), which replaces this store wholesale, or
  // removes the key after installing it (`app-shell-first-run.test.tsx`).
  storage.setItem(dashboardOnboardedStorageKey, DASHBOARD_FLAG_SET);
  return () => {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(window, "localStorage");
      return;
    }
    Object.defineProperty(window, "localStorage", originalDescriptor);
  };
}

/**
 * Model an install that has run before, for a suite whose subject is the app
 * shell rather than first launch.
 *
 * Call once inside `describe`; it owns its own `beforeEach`/`afterEach`.
 *
 * Load-bearing because the ISS-10195 guided onboarding run arms on `firstRun`,
 * and `firstRun` is "no first-run key in `localStorage`", which an empty store
 * answers YES to. So a suite with an empty store opens the blocking welcome
 * modal over the shell it is trying to assert on. That is correct product
 * behavior on a genuinely fresh install; it is simply not what these suites are
 * about.
 */
export function setupReturningInstallStorage(): void {
  let restore: (() => void) | undefined;

  beforeEach(() => {
    restore = installLocalStorage();
    window.localStorage.setItem(dashboardOnboardedStorageKey, "1");
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
  });
}
