import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: vi.fn(),
  ensureDefinitionVersion: vi.fn(),
  recordDefinitionSourceOccurrence: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  emitTelemetryMetric: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  });
  const withDb = Object.assign(vi.fn(), { tx: mocks.tx });
  return {
    Prisma: { sql },
    SourceAccessState: { accessible: "accessible" },
    SourceOccurrenceType: {
      local: "local",
      repository: "repository",
      pack: "pack",
    },
    withDb,
  };
});

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, warn: mocks.logWarn },
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

vi.mock("@/app/definition-registry/service", () => ({
  ensureDefinitionVersion: mocks.ensureDefinitionVersion,
  recordDefinitionSourceOccurrence: mocks.recordDefinitionSourceOccurrence,
}));

import {
  buildItem,
  buildPart,
  COMPUTE_TARGET_ID,
  installStatefulDb as installStatefulDbStore,
  ORGANIZATION_ID,
  resolutionUpdatesFrom,
} from "@/__tests__/support/agent-sessions/service/component-invocations.test-db";
import {
  projectedIndexKeyHead,
  projectIndexKey,
} from "@/lib/index-key-projection";
import { agentComponentInvocationsService } from "./component-invocations";
import { invocationIndexKeyProjectionGate } from "./invocation-index-key-telemetry";

const installStatefulDb: (
  input?: Parameters<typeof installStatefulDbStore>[1]
) => ReturnType<typeof installStatefulDbStore> = (input) =>
  installStatefulDbStore(mocks.tx, input);

function ingest(
  part: Parameters<
    typeof agentComponentInvocationsService.ingestPart
  >[0]["part"]
) {
  return agentComponentInvocationsService.ingestPart({
    organizationId: ORGANIZATION_ID,
    computeTargetId: COMPUTE_TARGET_ID,
    part,
  });
}

const OVER_BUDGET_COMPONENT_KEY = "k".repeat(3000);

describe("agentComponentInvocationsService.ingestPart component and definition resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // ISS-8736: the projection report is throttled per (org, compute target);
    // without clearing it, whichever case below hits it first spends the
    // window and every later projected-key case asserts against a suppressed
    // emission.
    invocationIndexKeyProjectionGate.clear();
    mocks.ensureDefinitionVersion.mockResolvedValue("definition-version-1");
    mocks.recordDefinitionSourceOccurrence.mockResolvedValue(
      "source-occurrence-1"
    );
  });

  it("leaves a non-versionable invocation unresolved when no component row matches its key", async () => {
    const tool = buildItem({
      kind: AgentComponentInvocationKind.Tool,
      componentKey: "no-such-tool",
      status: AgentComponentInvocationAttributionStatus.Unresolved,
    });
    const { db } = installStatefulDb();

    const result = await ingest(buildPart({ allItems: [tool] }));

    expect(result.ok).toBe(true);
    expect(
      resolutionUpdatesFrom(db.agentComponentInvocation.createMany)
    ).toEqual([
      expect.objectContaining({
        agentComponentId: null,
        attributionStatus: AgentComponentInvocationAttributionStatus.Unresolved,
        definitionVersionId: null,
        sourceOccurrenceId: null,
      }),
    ]);
  });

  it("keeps an item that already arrived ambiguous ambiguous, skipping definition resolution entirely", async () => {
    const item = buildItem({
      kind: AgentComponentInvocationKind.Skill,
      componentKey: "code-review",
      status: AgentComponentInvocationAttributionStatus.Ambiguous,
    });
    const { db } = installStatefulDb({
      components: [
        {
          id: "component-skill-1",
          componentKind: AgentComponentInvocationKind.Skill,
          componentKey: "code-review",
        },
      ],
    });

    const result = await ingest(buildPart({ allItems: [item] }));

    expect(result.ok).toBe(true);
    expect(
      resolutionUpdatesFrom(db.agentComponentInvocation.createMany)
    ).toEqual([
      expect.objectContaining({
        agentComponentId: null,
        attributionStatus: AgentComponentInvocationAttributionStatus.Ambiguous,
        definitionVersionId: null,
        sourceOccurrenceId: null,
      }),
    ]);
    expect(mocks.ensureDefinitionVersion).not.toHaveBeenCalled();
  });

  it("resolves an item citing a definition by hash alone against an already-registered version of matching kind and normalizer", async () => {
    const content = "# Code review\n\nReview only real bugs.\n";
    const fingerprint = computeDefinitionHash({
      frontmatter: "",
      body: content,
      kind: AgentComponentInvocationKind.Skill,
    });
    const item = buildItem({
      kind: AgentComponentInvocationKind.Skill,
      componentKey: "code-review",
      status: AgentComponentInvocationAttributionStatus.Matched,
      definitionHash: fingerprint.definitionHash,
      normalizerContractVersion: fingerprint.normalizerContractVersion,
    });
    const { db } = installStatefulDb({
      components: [
        {
          id: "component-skill-1",
          componentKind: AgentComponentInvocationKind.Skill,
          componentKey: "code-review",
        },
      ],
      definitionVersions: [
        {
          id: "existing-definition-1",
          componentKind: AgentComponentInvocationKind.Skill,
          definitionHash: fingerprint.definitionHash,
          normalizerContractVersion: fingerprint.normalizerContractVersion,
        },
      ],
    });

    const result = await ingest(buildPart({ allItems: [item] }));

    expect(result.ok).toBe(true);
    expect(mocks.ensureDefinitionVersion).not.toHaveBeenCalled();
    expect(
      resolutionUpdatesFrom(db.agentComponentInvocation.createMany)
    ).toEqual([
      expect.objectContaining({
        agentComponentId: "component-skill-1",
        attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
        definitionVersionId: "existing-definition-1",
      }),
    ]);
  });

  it("does not treat a duplicate component row for the same key as ambiguous", async () => {
    const item = buildItem({
      kind: AgentComponentInvocationKind.Skill,
      componentKey: "code-review",
      status: AgentComponentInvocationAttributionStatus.Unresolved,
    });
    // The same physical row surfacing twice (a join duplicate the DB can
    // legitimately produce) must dedupe to ONE id, not read as two
    // candidates for the same key.
    const { db } = installStatefulDb({
      components: [
        {
          id: "component-dup-1",
          componentKind: AgentComponentInvocationKind.Skill,
          componentKey: "code-review",
        },
        {
          id: "component-dup-1",
          componentKind: AgentComponentInvocationKind.Skill,
          componentKey: "code-review",
        },
      ],
    });

    const result = await ingest(buildPart({ allItems: [item] }));

    expect(result.ok).toBe(true);
    expect(
      resolutionUpdatesFrom(db.agentComponentInvocation.createMany)
    ).toEqual([
      expect.objectContaining({
        agentComponentId: "component-dup-1",
        attributionStatus: AgentComponentInvocationAttributionStatus.Unresolved,
      }),
    ]);
  });

  it("skips a component row with a null key in both the exact and legacy-recovery scans", async () => {
    const projectedItem = buildItem({
      externalInvocationId: "projected-item",
      kind: AgentComponentInvocationKind.Tool,
      componentKey: OVER_BUDGET_COMPONENT_KEY,
      sequence: 0,
    });
    // A second, ordinary key alongside the projected one so the
    // legacy-recovery head-collection loop also walks a row it must SKIP
    // (not every row it walks is unresolved/projected).
    const normalItem = buildItem({
      externalInvocationId: "normal-item",
      kind: AgentComponentInvocationKind.Tool,
      componentKey: "normal-tool",
      sequence: 1,
    });
    const { db } = installStatefulDb({
      components: [
        {
          id: "null-key-component",
          componentKind: AgentComponentInvocationKind.Tool,
          componentKey: null,
        },
      ],
    });

    const result = await ingest(
      buildPart({ allItems: [projectedItem, normalItem] })
    );

    expect(result.ok).toBe(true);
    expect(
      resolutionUpdatesFrom(db.agentComponentInvocation.createMany)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentComponentId: null }),
      ])
    );
  });

  it("falls back to no definition when a hash-only reference matches no registered version", async () => {
    const item = buildItem({
      kind: AgentComponentInvocationKind.Skill,
      componentKey: "code-review",
      status: AgentComponentInvocationAttributionStatus.Unresolved,
      definitionHash: "b".repeat(64),
      normalizerContractVersion: 1,
    });
    const { db } = installStatefulDb({
      components: [
        {
          id: "component-skill-1",
          componentKind: AgentComponentInvocationKind.Skill,
          componentKey: "code-review",
        },
      ],
      // No definitionVersions seeded: the claimed hash matches nothing.
    });

    const result = await ingest(buildPart({ allItems: [item] }));

    expect(result.ok).toBe(true);
    expect(mocks.ensureDefinitionVersion).not.toHaveBeenCalled();
    expect(
      resolutionUpdatesFrom(db.agentComponentInvocation.createMany)
    ).toEqual([
      expect.objectContaining({
        agentComponentId: "component-skill-1",
        definitionVersionId: null,
      }),
    ]);
  });

  it("treats two distinct component rows for the same key as genuinely ambiguous", async () => {
    const item = buildItem({
      kind: AgentComponentInvocationKind.Skill,
      componentKey: "code-review",
      status: AgentComponentInvocationAttributionStatus.Unresolved,
    });
    const { db } = installStatefulDb({
      components: [
        {
          id: "component-a",
          componentKind: AgentComponentInvocationKind.Skill,
          componentKey: "code-review",
        },
        {
          id: "component-b",
          componentKind: AgentComponentInvocationKind.Skill,
          componentKey: "code-review",
        },
      ],
    });

    const result = await ingest(buildPart({ allItems: [item] }));

    expect(result.ok).toBe(true);
    expect(
      resolutionUpdatesFrom(db.agentComponentInvocation.createMany)
    ).toEqual([
      expect.objectContaining({
        agentComponentId: null,
        attributionStatus: AgentComponentInvocationAttributionStatus.Ambiguous,
      }),
    ]);
  });

  it("does not run the legacy-recovery probe when the exact scan already resolved a projected key", async () => {
    const projectedItem = buildItem({
      kind: AgentComponentInvocationKind.Tool,
      componentKey: OVER_BUDGET_COMPONENT_KEY,
    });
    const projectedKey = projectIndexKey(OVER_BUDGET_COMPONENT_KEY).value;
    const { db } = installStatefulDb({
      // A component row already written under its projected key (created
      // after ISS-8069), so the exact IN-list scan resolves it directly.
      components: [
        {
          id: "exact-match-component",
          componentKind: AgentComponentInvocationKind.Tool,
          componentKey: projectedKey,
        },
      ],
    });

    const result = await ingest(buildPart({ allItems: [projectedItem] }));

    expect(result.ok).toBe(true);
    expect(
      resolutionUpdatesFrom(db.agentComponentInvocation.createMany)
    ).toEqual([
      expect.objectContaining({ agentComponentId: "exact-match-component" }),
    ]);
    const probeCalls = db.agentComponent.findMany.mock.calls.filter(
      (call) => (call[0] as { where?: { OR?: unknown[] } })?.where?.OR
    );
    expect(probeCalls).toHaveLength(0);
  });

  it("rejects a legacy-recovery candidate whose retained-head prefix match does not re-project", async () => {
    const projectedItem = buildItem({
      kind: AgentComponentInvocationKind.Tool,
      componentKey: OVER_BUDGET_COMPONENT_KEY,
    });
    const head = projectedIndexKeyHead(
      projectIndexKey(OVER_BUDGET_COMPONENT_KEY).value
    );
    // Shares the retained head by construction, but is short enough that
    // re-projecting it is a no-op — a false positive the prefix probe alone
    // cannot rule out.
    const falsePositiveKey = `${head}-not-actually-legacy`;
    const { db } = installStatefulDb();
    db.agentComponent.findMany.mockImplementation(
      (args: { where?: { OR?: unknown[] } }) =>
        Promise.resolve(
          args?.where?.OR
            ? [
                {
                  id: "false-positive-component",
                  componentKind: AgentComponentInvocationKind.Tool,
                  componentKey: falsePositiveKey,
                },
              ]
            : []
        )
    );

    const result = await ingest(buildPart({ allItems: [projectedItem] }));

    expect(result.ok).toBe(true);
    expect(
      resolutionUpdatesFrom(db.agentComponentInvocation.createMany)
    ).toEqual([expect.objectContaining({ agentComponentId: null })]);
  });
});
