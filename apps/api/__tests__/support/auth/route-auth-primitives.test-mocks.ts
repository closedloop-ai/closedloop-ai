import { type Mock, vi } from "vitest";

type PrimitiveMock = Mock<(...args: never[]) => unknown>;

type ModuleMockFactory = (
  importOriginal: () => Promise<object>
) => Promise<object>;

/**
 * The identity primitives under the real auth wrappers, as module stand-ins
 * for route auth suites (ISS-11409). Kept free of app imports: a suite's
 * `vi.mock` factory imports this module, and a factory that pulled in the app
 * graph could re-enter the module it is mocking.
 *
 * Reset between tests by the lane's `mockReset`; `installCallerIdentities` in
 * `route-auth-callers.test-helpers` reinstalls them.
 */
export const routeAuthPrimitives: Record<
  | "clerkAuth"
  | "findOrCreateUser"
  | "resolveDesktopSessionContext"
  | "getDesktopManagedPopRequestFailure"
  | "waitUntil",
  PrimitiveMock
> = {
  clerkAuth: vi.fn(),
  findOrCreateUser: vi.fn(),
  resolveDesktopSessionContext: vi.fn(),
  getDesktopManagedPopRequestFailure: vi.fn(),
  waitUntil: vi.fn(),
};

/** Module factories for the suite's `vi.mock` calls. */
export const routeAuthModuleMocks: {
  clerkServer: () => object;
  findOrCreateUser: () => object;
  desktopSessionAuth: () => object;
  desktopManagedPop: ModuleMockFactory;
  vercelFunctions: ModuleMockFactory;
} = {
  clerkServer: () => ({ auth: routeAuthPrimitives.clerkAuth }),
  findOrCreateUser: () => ({
    findOrCreateUser: routeAuthPrimitives.findOrCreateUser,
  }),
  desktopSessionAuth: () => ({
    resolveDesktopSessionContext:
      routeAuthPrimitives.resolveDesktopSessionContext,
  }),
  desktopManagedPop: async (importOriginal: () => Promise<object>) => ({
    ...(await importOriginal()),
    getDesktopManagedPopRequestFailure:
      routeAuthPrimitives.getDesktopManagedPopRequestFailure,
  }),
  vercelFunctions: async (importOriginal: () => Promise<object>) => ({
    ...(await importOriginal()),
    waitUntil: routeAuthPrimitives.waitUntil,
  }),
};
