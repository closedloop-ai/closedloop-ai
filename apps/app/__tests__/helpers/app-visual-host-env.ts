import { vi } from "vitest";

// ISS-10078: the `app-visual` compose service's auth env, the one host that
// opens the root-layout failure switch. Written out rather than imported from
// `@repo/auth/auth-mode`: a fixture built from the guard's own constants would
// move with the guard.
const APP_VISUAL_HOST_ENV = {
  AUTH_MODE: "local_trusted",
  E2E_LOCAL_TRUSTED_AUTH: "1",
  NODE_ENV: "test",
  VERCEL_ENV: undefined,
} as const;

export function stubAppVisualHostEnv(
  overrides: Partial<Record<string, string | undefined>> = {}
): void {
  for (const [key, value] of Object.entries({
    ...APP_VISUAL_HOST_ENV,
    ...overrides,
  })) {
    vi.stubEnv(key, value);
  }
}
