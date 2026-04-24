import type { Mock } from "vitest";
import { vi } from "vitest";
import type { IngestionContext } from "@/lib/loops/ingest-repo-execution-results";

/**
 * Test alias for the production ingestion context.
 */
export type IngestionTestContext = IngestionContext;

/** Default IDs for unit tests (ingest-repo-execution-results, etc.) */
export const unitIngestionCtxDefaults: IngestionTestContext = {
  organizationId: "org-1",
  workstreamId: "ws-1",
  documentId: "doc-1",
  loopId: "loop-1",
  correlationId: "corr-1",
  actionRunId: "action-run-1",
};

/** Default IDs for multi-repo E2E-style tests */
export const e2eIngestionCtxDefaults: IngestionTestContext = {
  organizationId: "org-e2e",
  workstreamId: "ws-e2e",
  documentId: "doc-e2e",
  loopId: "loop-e2e",
  correlationId: "corr-e2e",
  actionRunId: "action-run-e2e",
};

/**
 * Build an {@link IngestionContext} for tests. Defaults to unit IDs; pass
 * {@link e2eIngestionCtxDefaults} as the second arg for E2E-style fixtures.
 */
export function makeIngestionCtx(
  overrides: Partial<IngestionTestContext> = {},
  base: IngestionTestContext = unitIngestionCtxDefaults
): IngestionTestContext {
  return { ...base, ...overrides };
}

type IngestionMockTxValues = {
  documentId: string;
  organizationId: string;
  projectId: string;
  prId: string;
  eventId: string;
};

export type IngestionSuccessMockTxOptions = Partial<IngestionMockTxValues> & {
  /** Which ID bundle to use before applying overrides */
  preset?: "unit" | "e2e";
};

const TX_UNIT: IngestionMockTxValues = {
  documentId: "doc-1",
  organizationId: "org-1",
  projectId: "project-1",
  prId: "pr-1",
  eventId: "event-1",
};

const TX_E2E: IngestionMockTxValues = {
  documentId: "doc-e2e",
  organizationId: "org-e2e",
  projectId: "project-e2e",
  prId: "pr-e2e-1",
  eventId: "event-e2e-1",
};

function txPreset(p: "unit" | "e2e"): IngestionMockTxValues {
  return p === "e2e" ? TX_E2E : TX_UNIT;
}

export type IngestionSuccessMockTx = {
  document: { findUnique: Mock };
  gitHubPullRequest: { findUnique: Mock; upsert: Mock; update: Mock };
  workstreamEvent: { create: Mock };
};

/**
 * Mock Prisma client fragment used inside `withDb.tx` for successful repo
 * ingestion. The first parameter may be a `documentId` string (unit preset)
 * or an options object; use `{ preset: "e2e" }` for E2E default IDs.
 */
export function makeIngestionSuccessMockTx(
  arg?: string | IngestionSuccessMockTxOptions
): IngestionSuccessMockTx {
  let v: IngestionMockTxValues;
  if (typeof arg === "string") {
    v = { ...TX_UNIT, documentId: arg };
  } else {
    const preset = arg?.preset ?? "unit";
    const { preset: _p, ...overrides } = arg ?? {};
    v = { ...txPreset(preset), ...overrides };
  }
  const { documentId, organizationId, projectId, prId, eventId } = v;

  return {
    document: {
      findUnique: vi.fn().mockResolvedValue({
        organizationId,
        projectId,
        slug: "my-artifact",
      }),
    },
    gitHubPullRequest: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: prId, documentId }),
      update: vi.fn().mockResolvedValue({ id: prId, documentId }),
    },
    workstreamEvent: {
      create: vi.fn().mockResolvedValue({ id: eventId }),
    },
  };
}
