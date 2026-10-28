/**
 * Unit tests for previewSchemaCleanupService.dropSchemaForBranch — the drop a
 * branch name reaches from the cleanup route and the `pull_request.closed`
 * webhook. Split out of preview-schemas-service.test.ts (ISS-5978), which is
 * over the file-size ceiling.
 *
 * The existence check goes through the mocked `withDb`; the DROP goes through
 * the mocked migrator connection, and `withDb.tx` is kept as a trip-wire the
 * DROP must never reach (it rode that runtime-pool path before ISS-5978).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockWithDb,
  mockWithDbTx,
  mockWithMigratorClient,
  mockListAllBranchNames,
} = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockWithDbTx: vi.fn(),
  mockWithMigratorClient: vi.fn(),
  mockListAllBranchNames: vi.fn(),
}));

vi.mock("@/app/preview-schemas/service/migrator-connection", () => ({
  withMigratorClient: mockWithMigratorClient,
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/github", () => ({
  listAllBranchNames: mockListAllBranchNames,
}));

import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { deriveBranchSchemaName } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { previewSchemaCleanupService } from "@/app/preview-schemas/service";
import { createPreviewSchemaMocks } from "./preview-schemas-mocks";

const { mockDropFailure, mockSchemaExists, mockTransactionalDropOnce } =
  createPreviewSchemaMocks(
    mockWithDb,
    mockListAllBranchNames,
    mockWithMigratorClient
  );

const TEST_BRANCH = "feat/cleanup-schemas";
const TEST_SCHEMA = deriveBranchSchemaName(
  TEST_BRANCH,
  normalizePreviewSchemaName
);
const PREVIEW_SCHEMA_PREFIX = /^preview_/;

describe("previewSchemaCleanupService.dropSchemaForBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Drain any `mockImplementationOnce` queue the previous test did not
    // consume — `clearAllMocks` clears call history but NOT queued
    // implementations, so a leftover would be handed to the next test's first
    // query and cascade failures across the file.
    mockWithDb.mockReset();
    mockWithMigratorClient.mockReset();
    mockListAllBranchNames.mockResolvedValue(["main"]);
  });

  it("drops schema and returns dropped=true when schema exists", async () => {
    mockSchemaExists(TEST_SCHEMA, true);
    // dropSchemaForBranch drops directly; it does not run the sweep's
    // re-verification read, so only the transactional DROP is queued.
    mockTransactionalDropOnce();

    const result =
      await previewSchemaCleanupService.dropSchemaForBranch(TEST_BRANCH);

    expect(result.schemaName).toBe(TEST_SCHEMA);
    expect(result.dropped).toBe(true);
    expect(result.alreadyGone).toBe(false);
    expect(result.error).toBeNull();

    // ISS-5978: the DROP runs on the MIGRATOR connection, never the runtime
    // pool — only the existence check goes through withDb, and withDb.tx (the
    // path the DROP used to take) is never entered.
    expect(mockWithMigratorClient).toHaveBeenCalledTimes(1);
    expect(mockWithDbTx).not.toHaveBeenCalled();
    // existence check (1) = 1 call
    expect(mockWithDb).toHaveBeenCalledTimes(1);
  });

  it("returns alreadyGone=true and does not call DROP when schema does not exist", async () => {
    mockSchemaExists(TEST_SCHEMA, false);

    const result =
      await previewSchemaCleanupService.dropSchemaForBranch(TEST_BRANCH);

    expect(result.schemaName).toBe(TEST_SCHEMA);
    expect(result.dropped).toBe(false);
    expect(result.alreadyGone).toBe(true);
    expect(result.error).toBeNull();

    // Only the existence check — no drop call
    expect(mockWithDb).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — re-calling after schema is already gone returns alreadyGone=true without error", async () => {
    // First call: schema gone
    mockSchemaExists(TEST_SCHEMA, false);
    const first =
      await previewSchemaCleanupService.dropSchemaForBranch(TEST_BRANCH);

    // Second call: schema still gone
    mockSchemaExists(TEST_SCHEMA, false);
    const second =
      await previewSchemaCleanupService.dropSchemaForBranch(TEST_BRANCH);

    expect(first.alreadyGone).toBe(true);
    expect(first.error).toBeNull();
    expect(second.alreadyGone).toBe(true);
    expect(second.error).toBeNull();
  });

  it("derived schema name always starts with preview_ for any branch input", async () => {
    // The service derives the schema name via normalizePreviewSchemaName which
    // always produces a preview_-prefixed name. This test verifies the guard
    // is never triggered for valid branch inputs and confirms the derived name
    // is always safe for DROP operations.
    const branches = [
      "feat/cleanup-schemas",
      "main",
      "dependabot/npm_and_yarn/lodash-4.17.21",
      "release/2.0.0",
    ];

    for (const branch of branches) {
      vi.clearAllMocks();
      // Drain any `mockImplementationOnce` queue the previous test did not
      // consume — `clearAllMocks` clears call history but NOT queued
      // implementations, so a leftover would be handed to the next test's first
      // query and cascade failures across the file.
      mockWithDb.mockReset();
      mockWithMigratorClient.mockReset();
      const derived = deriveBranchSchemaName(
        branch,
        normalizePreviewSchemaName
      );
      expect(derived).toMatch(PREVIEW_SCHEMA_PREFIX);

      // Service should proceed to existence check (not return with guard error)
      mockSchemaExists(derived, false);
      const result =
        await previewSchemaCleanupService.dropSchemaForBranch(branch);
      expect(result.error).toBeNull();
      expect(result.schemaName).toMatch(PREVIEW_SCHEMA_PREFIX);
    }
  });

  it("returns error in result and does not throw when drop fails", async () => {
    mockSchemaExists(TEST_SCHEMA, true);
    mockDropFailure("connection lost during DROP");

    const result =
      await previewSchemaCleanupService.dropSchemaForBranch(TEST_BRANCH);

    expect(result.dropped).toBe(false);
    expect(result.alreadyGone).toBe(false);
    expect(result.error).toBe("connection lost during DROP");
  });
});
