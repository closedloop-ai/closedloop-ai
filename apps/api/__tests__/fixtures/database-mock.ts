import { vi } from "vitest";

/** Minimal database-like interface for tests; withDb is a mock. */
export interface DatabaseMock {
  withDb: (...args: unknown[]) => unknown;
}

/** Returns a minimal @repo/database mock for tests that only need withDb to resolve. */
export function createDatabaseMock(): DatabaseMock {
  return { withDb: vi.fn() };
}
