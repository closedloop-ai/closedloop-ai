import { vi } from "vitest";

// Mock server-only to prevent "Client Component" errors in tests
vi.mock("server-only", () => ({}));

// Global setup will be handled in individual test files as needed
// since ensureDatabase requires proper environment setup
