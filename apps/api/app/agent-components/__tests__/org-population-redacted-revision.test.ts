/**
 * ISS-4965 (Perrin, 2026-10-05): a definition revision stored secret-redacted
 * stays ONE version in the org population.
 *
 * The inventory bucket keys on the revision's linked `DefinitionVersion` — the
 * fingerprint of the REDACTED body — while its usage rows carry the Desktop's
 * digest of the text as written. Without the stored `usageScopeHash` routing
 * that usage into the revision's bucket, the family reads as two versions.
 * Drives the real `listForOrg` path.
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  listByArtifactIds: vi.fn(),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: mocks.listByArtifactIds },
}));

import {
  buildInventoryRow,
  buildServiceDb,
} from "@/__tests__/support/agent-components/service-db-double";
import {
  isOrphanUsageRead,
  type OrphanUsageShape,
  resolveOrphanUsageGroupBy,
  type WhereClause,
} from "@/__tests__/support/agent-components/usage-lane-doubles";
import { agentComponentsService } from "../service";

const ORG = "org-iss-4965";
const KIND = AgentComponentKind.Skill;
const KEY = "deploy";
const INVENTORY_ID = "ac-deploy";
/** The revision's coarse `sha256` of the raw file. */
const COARSE_HASH = "c".repeat(64);
/** The linked `DefinitionVersion.definitionHash`: the redacted body's fingerprint. */
const REDACTED_FINGERPRINT = "e".repeat(64);
/** The stored `usageScopeHash`: the digest of the body as written. */
const RAW_USAGE_DIGEST = "d".repeat(64);
const INVOCATIONS = 5;

/** Which usage lane carries the revision's usage. */
type UsageLane = "fk" | "orphan";

/** The revision's usage, FK-linked to its inventory row. */
const FK_USAGE_GROUP = {
  agentComponentId: INVENTORY_ID,
  componentKind: KIND,
  componentKey: KEY,
  agentSessionId: "sess-1",
  gitBranch: "",
  harness: null,
  componentVersionHash: RAW_USAGE_DIGEST,
  definitionVersionId: null,
  _sum: { invocationCount: INVOCATIONS, errorCount: 0 },
  _max: { lastInvokedAt: null },
};

/** The same usage, synced before the component-sync lane linked its FK. */
const ORPHAN_USAGE_ROW: OrphanUsageShape = {
  agentSessionId: "sess-1",
  componentKind: KIND,
  componentKey: KEY,
  invocationCount: INVOCATIONS,
  componentVersionHash: RAW_USAGE_DIGEST,
  definitionVersionId: null,
};

function installDb(lane: UsageLane) {
  const db = buildServiceDb({
    agentComponent: {
      findMany: vi.fn().mockResolvedValue([
        buildInventoryRow({
          id: INVENTORY_ID,
          organizationId: ORG,
          componentKind: KIND,
          componentKey: KEY,
          name: KEY,
          contentHash: COARSE_HASH,
        }),
      ]),
    },
    agentComponentVersion: {
      findMany: vi.fn((args: { where?: Record<string, unknown> }) =>
        Promise.resolve(
          args.where?.definitionVersionId
            ? [
                {
                  componentKind: KIND,
                  componentKey: KEY,
                  contentHash: COARSE_HASH,
                  usageScopeHash: RAW_USAGE_DIGEST,
                  definitionVersion: { definitionHash: REDACTED_FINGERPRINT },
                },
              ]
            : []
        )
      ),
    },
    agentComponentSessionUsage: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn(
        (args: { by?: string[]; where?: WhereClause; take?: number }) => {
          if (isOrphanUsageRead(args.where)) {
            return Promise.resolve(
              lane === "orphan"
                ? resolveOrphanUsageGroupBy([ORPHAN_USAGE_ROW], args)
                : []
            );
          }
          return Promise.resolve(lane === "fk" ? [FK_USAGE_GROUP] : []);
        }
      ),
    },
  });
  mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) => cb(db));
  mocks.withDb.tx.mockImplementation((cb: (db: unknown) => unknown) => cb(db));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listByArtifactIds.mockResolvedValue([]);
});

describe("ISS-4965: a redacted revision in the org population", () => {
  it.each(["fk", "orphan"] as const)(
    "routes %s usage stamped with the raw digest into the revision's own bucket",
    async (lane) => {
      installDb(lane);

      const list = await agentComponentsService.listForOrg(ORG, {
        limit: 50,
        offset: 0,
      });

      const rows = list.items.filter((item) => item.kind === KIND);
      expect(rows).toHaveLength(1);
      expect(rows[0].versionId).toBe(REDACTED_FINGERPRINT);
      expect(rows[0].versionCount).toBeUndefined();
      expect(rows[0].invocations).toBe(INVOCATIONS);
    }
  );
});
