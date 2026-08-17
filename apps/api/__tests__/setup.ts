import { config } from "dotenv";
import { vi } from "vitest";

// Load environment variables from .env.local for integration tests
// If .env.local doesn't exist (e.g., in CI), this will silently fail
config({ path: ".env.local" });

// DD_SERVICE identifies this process as the API service for telemetry/origin
// resolution. Must be set before any test module imports
// packages/observability/telemetry/origin.ts, which resolves ORIGIN once at
// module load time.
//
// FORCED, not a fallback (ISS-4930). The CI lanes that run this suite now
// declare their own step-level DD_SERVICE (`symphony-unit`,
// `symphony-api-integration`) so dd-trace stops auto-detecting the Test
// Optimization service from the nearest package.json. Neither value is a known
// origin, so under `??=` this line would no-op in CI and ORIGIN would resolve
// to `Origin.Unknown` for every apps/api test — a value that differs from the
// local run, where DD_SERVICE is unset and this line still fires.
//
// Measured: no test asserts on it today, so `??=` is not currently red. The
// point is that `origin: ORIGIN` IS stamped onto records by production code
// these tests exercise (lib/desktop-command-store.ts, lib/relay-event-bus.ts),
// so leaving it lane-dependent means the suite silently proves a different
// origin in CI than on a laptop. Forcing it removes that skew and matches
// packages/observability/vitest.setup.ts, which already assigns unconditionally.
//
// The tracer is unaffected: it reads DD_SERVICE at process start via the
// NODE_OPTIONS preload, long before vitest runs this setup file, so the lane
// still reports to Test Optimization under its own service.
process.env.DD_SERVICE = "api";

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
