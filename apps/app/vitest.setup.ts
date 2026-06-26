// Tell t3-env we're in a test environment to allow server-side env vars
process.env.SKIP_ENV_VALIDATION = "true";

// Set required environment variables for tests
// This must run before any imports that depend on env vars
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
import { afterEach, vi } from "vitest";

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

// Mock scrollIntoView which is not implemented in jsdom.
// Guarded for `@vitest-environment node` test files where Element is undefined.
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView = () => {};
}

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

// --- Navigation port shims (PLN-806 / FEA-1509) ---
// Components consume @repo/navigation instead of next/navigation directly.
// Delegate the port hooks back to next/navigation so existing per-test
// vi.mock("next/navigation") factories keep driving navigation assertions
// without modification. Tests that exercise the REAL port/adapter opt out
// via vi.unmock (see lib/navigation/__tests__/next-adapter.test.tsx).
vi.mock("@repo/navigation/use-navigation", async () => {
  const nav = await import("next/navigation");
  const { useMemo } = await import("react");
  return {
    // Memoized on [router] to match the production adapter's stability
    // contract (next-adapter.tsx) — components list `navigation` in effect/
    // callback dependency arrays and must not re-fire on every render.
    //
    // Backward-compat divergence from the production adapter: when `options`
    // is undefined we call router.push(href) with ONE argument, whereas the
    // real adapter always passes two (router.push(href, options)). This
    // preserves the pre-migration assertion style
    // `expect(push).toHaveBeenCalledWith(href)` used across existing suites;
    // the production two-argument contract is pinned by
    // lib/navigation/__tests__/next-adapter.test.tsx instead.
    useNavigation: () => {
      const router = nav.useRouter();
      return useMemo(
        () => ({
          navigate: (href: string, options?: { scroll?: boolean }) => {
            if (options === undefined) {
              router.push(href);
              return;
            }
            router.push(href, options);
          },
          replace: (href: string, options?: { scroll?: boolean }) => {
            if (options === undefined) {
              router.replace(href);
              return;
            }
            router.replace(href, options);
          },
          back: () => router.back(),
          refresh: () => router.refresh(),
        }),
        [router]
      );
    },
  };
});

vi.mock("@repo/navigation/use-path", async () => {
  const nav = await import("next/navigation");
  return {
    // No fallback guard: a test that renders path-dependent components
    // without mocking usePathname should fail loudly, matching the real
    // adapter's behavior.
    usePath: () => nav.usePathname(),
  };
});

vi.mock("@repo/navigation/use-route-params", async () => {
  const nav = await import("next/navigation");
  return {
    useRouteParams: () => nav.useParams(),
  };
});

vi.mock("@repo/navigation/use-search-params-value", async () => {
  const nav = await import("next/navigation");
  return {
    useSearchParamsValue: () => nav.useSearchParams(),
  };
});

vi.mock("@repo/navigation/use-org-path", async () => {
  const nav = await import("next/navigation");
  return {
    // Mirror the web adapter: derive the slug from the route param (driven by
    // per-test vi.mock("next/navigation") factories) and never emit a
    // protocol-relative "//…" when the slug is absent.
    useOrgPath: () => {
      const params = nav.useParams();
      const slug = typeof params.orgSlug === "string" ? params.orgSlug : "";
      return (path: string) => (slug ? `/${slug}${path}` : path);
    },
  };
});

vi.mock("@repo/navigation/link", async () => {
  const { createElement } = await import("react");
  type ShimLinkProps = Record<string, unknown> & {
    href: string;
    prefetch?: boolean;
    replace?: boolean;
    scroll?: boolean;
  };
  return {
    Link: ({
      href,
      prefetch: _prefetch,
      replace: _replace,
      scroll: _scroll,
      children,
      ...rest
    }: ShimLinkProps & { children?: unknown }) =>
      createElement("a", { href, ...rest }, children as never),
  };
});
