import { config } from "dotenv";
import { vi } from "vitest";

// Load environment variables from .env.local for integration tests
// If .env.local doesn't exist (e.g., in CI), this will silently fail
config({ path: ".env.local" });

// Set fallback env vars for packages that validate at import time.
// These are only used when .env.local is absent (e.g., CI).
process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";

// INTERNAL_API_SECRET is FORCED (not a fallback) because the compatibility
// test fixtures send this exact value in the x-internal-secret header and
// the route's constant-time HMAC compare will reject anything else. Devs
// whose .env.local carries a different value would otherwise see ~18 compat
// tests fail with 401 on /internal/relay/socket-event.
process.env.INTERNAL_API_SECRET = "test-internal-secret";

// Mock server-only to prevent "Client Component" errors in tests
vi.mock("server-only", () => ({}));

// Mock @repo/analytics to prevent environment variable validation at module load time
// The analytics package validates NEXT_PUBLIC_POSTHOG_KEY and related vars in keys.ts,
// which fails in test environment where these are not set
vi.mock("@repo/analytics/server", () => ({
  analytics: {
    capture: vi.fn(),
    identify: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
}));
