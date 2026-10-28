// Mock singletons + module-mock factories for the desktop components-sync
// service suites (service.test.ts and service-timestamp-floor.test.ts). This
// file must import nothing but vitest: it is dynamically imported inside
// vi.mock factories, so any app import here would deadlock the mock registry
// (factory -> app module -> mocked module).
import { type Mock, vi } from "vitest";

export const mocks: {
  withDb: Mock & { tx: Mock };
  findOwnedById: Mock;
  upsert: Mock;
  versionUpsert: Mock;
  versionUpdate: Mock;
  versionCreateMany: Mock;
  versionUpdateMany: Mock;
  registerDefinitionVersion: Mock;
  relinkActiveForComputeTarget: Mock;
  componentFindMany: Mock;
  componentFindUnique: Mock;
  logInfo: Mock;
  logWarn: Mock;
  indexManyAfterCommit: Mock;
  removeManyAfterCommit: Mock;
  emitTelemetryMetric: Mock;
} = {
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  findOwnedById: vi.fn(),
  upsert: vi.fn(),
  versionUpsert: vi.fn(),
  versionUpdate: vi.fn(),
  versionCreateMany: vi.fn(),
  versionUpdateMany: vi.fn(),
  registerDefinitionVersion: vi.fn(),
  relinkActiveForComputeTarget: vi.fn(),
  componentFindMany: vi.fn(),
  componentFindUnique: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  indexManyAfterCommit: vi.fn(),
  removeManyAfterCommit: vi.fn(),
  emitTelemetryMetric: vi.fn(),
};

export function databaseModuleMock(): {
  withDb: Mock & { tx: Mock };
  SourceAccessState: { accessible: string; inaccessible: string };
} {
  return {
    withDb: mocks.withDb,
    // Enum runtime values referenced by the sync service (FEA-3290).
    SourceAccessState: {
      accessible: "accessible",
      inaccessible: "inaccessible",
    },
  };
}

export function computeTargetsModuleMock() {
  return { computeTargetsService: { findOwnedById: mocks.findOwnedById } };
}

export function logModuleMock() {
  return { log: { info: mocks.logInfo, warn: mocks.logWarn } };
}

export function telemetryModuleMock() {
  return { emitTelemetryMetric: mocks.emitTelemetryMetric };
}

export function componentInvocationsModuleMock() {
  return {
    agentComponentInvocationsService: {
      relinkActiveForComputeTarget: mocks.relinkActiveForComputeTarget,
    },
  };
}

// FEA-3290: assert exact-version registry wiring without a database.
export function definitionRegistryModuleMock() {
  return { registerDefinitionVersion: mocks.registerDefinitionVersion };
}

// FEA-4011: keep the mapper real while stubbing its post-commit hooks.
export function searchIndexModuleMock<T extends object>(actual: T) {
  return {
    ...actual,
    searchIndexService: {
      indexManyAfterCommit: mocks.indexManyAfterCommit,
      removeManyAfterCommit: mocks.removeManyAfterCommit,
    },
  };
}
