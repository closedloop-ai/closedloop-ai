import { type Mock, vi } from "vitest";

export type MeshDb = {
  sessionMeshPresence: Record<
    | "findFirst"
    | "findFirstOrThrow"
    | "findMany"
    | "updateMany"
    | "createMany"
    | "deleteMany",
    Mock
  >;
  sessionMeshMessage: Record<
    "createMany" | "findUnique" | "findMany" | "deleteMany",
    Mock
  >;
  sessionMeshDelivery: Record<
    "findFirst" | "findMany" | "createMany" | "updateMany",
    Mock
  >;
  sessionMeshSubscription: Record<"findFirst" | "findMany" | "upsert", Mock>;
  sessionMeshMetricEvent: Record<
    | "create"
    | "createMany"
    | "findUnique"
    | "findUniqueOrThrow"
    | "findMany"
    | "deleteMany",
    Mock
  >;
  pullRequestDetail: Record<"findFirst", Mock>;
  $queryRaw: Mock;
};

/**
 * A Prisma-shaped stand-in for every Session Mesh delegate the service layer
 * touches. Each call builds fresh `vi.fn()`s, so a suite creates one per test
 * (the apps/api lane runs with `mockReset: true`).
 */
export function createMeshDb(): MeshDb {
  return {
    sessionMeshPresence: {
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    sessionMeshMessage: {
      createMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    sessionMeshDelivery: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
    },
    sessionMeshSubscription: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    sessionMeshMetricEvent: {
      create: vi.fn(),
      createMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    pullRequestDetail: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
  };
}

export type MeshDbCall = { kind: "plain" | "tx"; options: unknown };

/**
 * Module state shared between the `@repo/database` mock factory and the suite.
 * `calls` records whether each unit of work ran through `withDb` or
 * `withDb.tx`, plus the transaction options it asked for.
 */
export const meshDbState: { db: MeshDb; calls: MeshDbCall[] } = {
  db: createMeshDb(),
  calls: [],
};

export function resetMeshDb(): MeshDb {
  meshDbState.db = createMeshDb();
  meshDbState.calls = [];
  return meshDbState.db;
}

/**
 * Drop-in `withDb` for a partial `@repo/database` mock:
 *
 * ```ts
 * vi.mock("@repo/database", async (importOriginal) => ({
 *   ...(await importOriginal<object>()),
 *   withDb: (
 *     await import("@/__tests__/support/session-mesh/session-mesh-db.test-helpers")
 *   ).meshWithDb(),
 * }));
 * ```
 */
export function meshWithDb() {
  const plain = <T>(fn: (client: MeshDb) => T): T => {
    meshDbState.calls.push({ kind: "plain", options: undefined });
    return fn(meshDbState.db);
  };
  const tx = <T>(fn: (client: MeshDb) => T, options?: unknown): T => {
    meshDbState.calls.push({ kind: "tx", options });
    return fn(meshDbState.db);
  };
  return Object.assign(plain, { tx });
}
