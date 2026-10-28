/**
 * @file desktop-component-overlong-identity.integration.test.ts
 * @description ISS-8201 — an over-long ASCII component identity reaches the
 * write path and is counted, instead of 400ing at the parser.
 *
 * The caps this replaces counted CHARACTERS while the projection they were
 * meant to protect budgets BYTES. So the same 512-length identity had two
 * outcomes depending on its encoding: an ASCII one was refused by the parser and
 * `toComponentIndexKeys` never ran, while a multibyte one (up to 2048 bytes)
 * passed the cap and WAS projected. This drives the ASCII case — the one that
 * could not previously get here — through the real schema and the real service
 * against a real Postgres, and asserts the two things the ticket names: the row
 * lands under a projected key, and `desktop.sync.index_key_projected` reports it.
 *
 * The schema half is in the same case on purpose. Asserting the write alone
 * would stay green if the parser started refusing the payload again, because
 * this suite would simply never build one.
 *
 * Self-skips when DATABASE_URL is unset, like its neighbours. Run explicitly:
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app \
 *     pnpm --filter api exec vitest run \
 *     __tests__/integration/desktop-component-overlong-identity.integration.test.ts \
 *     --config vitest.config.integration.mts
 */
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import type { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSyncFixture,
  overLimitValue,
} from "@/__tests__/support/index-key-poison.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { desktopComponentsSyncService } from "@/app/desktop/components/sync/service";
import { desktopAgentComponentsPayloadSchema } from "@/lib/desktop-agent-sessions-schema";
import {
  hasProjectedIndexKeyShape,
  INDEX_KEY_MAX_BYTES,
  INDEX_KEY_PROJECTED_METRIC,
} from "@/lib/index-key-projection";

const emitTelemetryMetric = vi.hoisted(() => vi.fn());

vi.mock("@repo/observability/telemetry/metrics", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@repo/observability/telemetry/metrics")
  >()),
  emitTelemetryMetric,
}));

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

// ASCII by construction (hex digits), and far past both the 512 the deleted cap
// counted and the 512 BYTES the projection budgets. Written from the shared
// fixture rather than from either constant, so it cannot move with the bound.
const OVER_LIMIT_KIND = `skill-${overLimitValue("iss-8201-kind")}`;

const organizations = createCommittedTestOrganizationTracker();

function parsePayload(componentKind: string) {
  return desktopAgentComponentsPayloadSchema.safeParse({
    schemaVersion: 1,
    batchId: "9f4b6d21-8c0e-4a13-9b77-2e5c81af0d34",
    syncMode: AgentSessionSyncMode.Incremental,
    componentCount: 1,
    components: [
      {
        externalId: "skill::overlong-identity",
        componentKind,
        harness: "claude-code",
        name: "Overlong identity",
        componentKey: "overlong-identity",
        content: "# overlong identity",
        contentHash: "f".repeat(64),
      },
    ],
  });
}

function readDefinitionVersions(organizationId: string) {
  return withDb((db) =>
    db.definitionVersion.findMany({
      where: { organizationId },
      select: { componentKind: true, definitionHash: true },
    })
  );
}

function readComponents(computeTargetId: string) {
  return withDb((db) =>
    db.agentComponent.findMany({
      where: { computeTargetId },
      select: { componentKind: true, externalComponentId: true, name: true },
    })
  );
}

afterEach(async () => {
  emitTelemetryMetric.mockClear();
  await organizations.cleanup();
});

describeIfDb(
  "ISS-8201 — an over-long ASCII component identity reaches the write path",
  () => {
    it("stores it under a projected key and reports the projection", async () => {
      const organizationId = await organizations.create();
      const fixture = await createSyncFixture(
        organizationId,
        "iss-8201-machine"
      );

      // The parser half, asserted here rather than inside the helper: before
      // ISS-8201 this ASCII identity was refused at the schema and the
      // projection below could never run at all.
      const parsed = parsePayload(OVER_LIMIT_KIND);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        return;
      }

      const result = await desktopComponentsSyncService.sync({
        clerkUserId: null,
        computeTargetId: fixture.computeTargetId,
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        payload: parsed.data,
      });

      expect(result.ok).toBe(true);

      const rows = await readComponents(fixture.computeTargetId);
      expect(rows).toHaveLength(1);
      const stored = rows[0];

      // Bound at the WRITE, which is the only place a byte budget can be
      // applied — and bound INJECTIVELY, so the key still identifies this row.
      expect(stored?.componentKind).not.toBe(OVER_LIMIT_KIND);
      expect(hasProjectedIndexKeyShape(stored?.componentKind ?? "")).toBe(true);
      expect(
        Buffer.byteLength(stored?.componentKind ?? "", "utf8")
      ).toBeLessThanOrEqual(INDEX_KEY_MAX_BYTES);
      // Non-indexed payload is untouched: bounding an index key must not cost
      // the component it describes.
      expect(stored?.name).toBe("Overlong identity");

      // The SECOND btree the same kind lands in. `DefinitionVersion` has its own
      // `@@index([organizationId, componentKind])` and is written by a different
      // function, so removing the wire cap without projecting here threw
      // `index row size ... exceeds btree version 4 maximum` mid-fan-out — a
      // worse failure than the 400 the cap produced. Asserting the row exists
      // AND agrees with the component's stored kind is what keeps that closed:
      // two spellings of one kind would pass a mere existence check.
      const definitionVersions = await readDefinitionVersions(
        fixture.organizationId
      );
      expect(definitionVersions).toHaveLength(1);
      expect(definitionVersions[0]?.componentKind).toBe(stored?.componentKind);
      // But the VERSION IDENTITY is fingerprinted from the RAW kind (codex P2 +
      // whitlockk review, PR #7220). `definitionHash` folds the kind and keys
      // `@@unique([organizationId, definitionHash])`, so hashing the projection
      // instead would rekey every version already registered under a raw kind
      // and split provenance against a producer that never projects. Derived
      // from the SSOT fingerprint rather than a recorded literal, so a change to
      // the hash contract moves both sides together.
      expect(definitionVersions[0]?.definitionHash).toBe(
        computeDefinitionHash({
          frontmatter: "",
          body: "# overlong identity",
          kind: OVER_LIMIT_KIND as AgentComponentKind,
        }).definitionHash
      );

      expect(
        emitTelemetryMetric.mock.calls
          .map(([argument]) => argument)
          .filter((argument) => argument?.metric === INDEX_KEY_PROJECTED_METRIC)
      ).toEqual([
        {
          metric: INDEX_KEY_PROJECTED_METRIC,
          organizationId: fixture.organizationId,
          computeTargetId: fixture.computeTargetId,
          count: expect.any(Number),
        },
      ]);
    });

    it("stays silent and stores the identity verbatim when it fits", async () => {
      // The opposite state on the same subject: admitting any length did not
      // turn every write into a projection.
      const organizationId = await organizations.create();
      const fixture = await createSyncFixture(
        organizationId,
        "iss-8201-machine-fitting"
      );

      const parsed = parsePayload("skill");
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        return;
      }

      const result = await desktopComponentsSyncService.sync({
        clerkUserId: null,
        computeTargetId: fixture.computeTargetId,
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        payload: parsed.data,
      });

      expect(result.ok).toBe(true);
      expect(
        (await readComponents(fixture.computeTargetId))[0]?.componentKind
      ).toBe("skill");
      expect(
        emitTelemetryMetric.mock.calls
          .map(([argument]) => argument)
          .filter((argument) => argument?.metric === INDEX_KEY_PROJECTED_METRIC)
      ).toEqual([]);
    });
  }
);
