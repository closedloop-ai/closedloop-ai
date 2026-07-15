// Mock singletons + module-mock factories for the agent-sessions test
// suites. This file must import nothing but vitest: it is dynamically
// imported inside vi.mock factories, so any app import here would
// deadlock the mock registry (factory -> app module -> mocked module).
import { type Mock, vi } from "vitest";

export const mocks: {
  dbNull: symbol;
  withDb: Mock & { tx: Mock };
  emitTelemetryMetric: Mock;
} = {
  dbNull: Symbol("db-null"),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  emitTelemetryMetric: vi.fn(),
};

export function databaseModuleMock(): {
  GitHubInstallationStatus: { ACTIVE: string };
  Prisma: { DbNull: symbol };
  withDb: Mock & { tx: Mock };
} {
  return {
    GitHubInstallationStatus: {
      ACTIVE: "ACTIVE",
    },
    Prisma: {
      DbNull: mocks.dbNull,
    },
    withDb: mocks.withDb,
  };
}

export function telemetryModuleMock(): { emitTelemetryMetric: Mock } {
  return { emitTelemetryMetric: mocks.emitTelemetryMetric };
}
