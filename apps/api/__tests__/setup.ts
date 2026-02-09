import { config } from "dotenv";
import { vi } from "vitest";

// Load environment variables from .env.local for integration tests
// If .env.local doesn't exist (e.g., in CI), this will silently fail
config({ path: ".env.local" });

// Mock server-only to prevent "Client Component" errors in tests
vi.mock("server-only", () => ({}));
