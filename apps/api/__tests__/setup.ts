import { config } from "dotenv";
import { vi } from "vitest";

// Load environment variables from .env.local for integration tests
// If .env.local doesn't exist (e.g., in CI), this will silently fail
config({ path: ".env.local" });

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
