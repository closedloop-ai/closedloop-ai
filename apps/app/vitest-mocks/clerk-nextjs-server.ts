// Mock for @clerk/nextjs/server in tests
export const auth = () =>
  Promise.resolve({ userId: null as string | null, getToken: () => null });

export const currentUser = () => Promise.resolve(null);

export const clerkMiddleware = () => () => null;

export const createRouteMatcher = (_patterns: string[]) => () => false;
