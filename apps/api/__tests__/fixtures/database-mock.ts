import { vi } from "vitest";

/** Returns a minimal @repo/database mock for tests that only need withDb to resolve. */
export function createDatabaseMock() {
  return { withDb: vi.fn() };
}
