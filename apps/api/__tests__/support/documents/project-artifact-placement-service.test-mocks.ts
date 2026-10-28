// Mock singletons for the project artifact placement service suites. This file
// must import nothing but vitest: it is dynamically imported inside a vi.mock
// factory, so any app import here would deadlock the mock registry.
import { type Mock, vi } from "vitest";

type PlacementMockName =
  | "activityCreate"
  | "activityCreateMany"
  | "activityFindFirst"
  | "activityFindMany"
  | "artifactFindFirst"
  | "artifactFindMany"
  | "artifactLinkCreate"
  | "artifactLinkCreateMany"
  | "artifactLinkDeleteMany"
  | "artifactLinkFindMany"
  | "artifactUpdate"
  | "artifactUpdateMany"
  | "executeRaw"
  | "projectFindFirst"
  | "projectFindMany"
  | "queryRaw"
  | "userFindFirst";

export const mocks: Record<PlacementMockName, Mock> & {
  withDb: Mock & { tx: Mock };
} = {
  activityCreate: vi.fn(),
  activityCreateMany: vi.fn(),
  activityFindFirst: vi.fn(),
  activityFindMany: vi.fn(),
  artifactFindFirst: vi.fn(),
  artifactFindMany: vi.fn(),
  artifactLinkCreate: vi.fn(),
  artifactLinkCreateMany: vi.fn(),
  artifactLinkDeleteMany: vi.fn(),
  artifactLinkFindMany: vi.fn(),
  artifactUpdate: vi.fn(),
  artifactUpdateMany: vi.fn(),
  executeRaw: vi.fn(),
  projectFindFirst: vi.fn(),
  projectFindMany: vi.fn(),
  queryRaw: vi.fn(),
  userFindFirst: vi.fn(),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
};
