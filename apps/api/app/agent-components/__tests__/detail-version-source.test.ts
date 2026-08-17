/**
 * ISS-6232: the CLOUD detail read must report a real `source` for every
 * revision, derived from the identity's own captured provenance.
 *
 * Every stored `AgentComponentVersion` carries the collector's `""` source
 * sentinel — that column participates in the version identity
 * `(org, kind, key, source, hash)`, so it is resolved at READ time rather than
 * re-keyed. This suite drives `getDetailForOrg` end to end and asserts the
 * emitted `versions[].source`, so it fails if the union-fold argument at
 * `detail-read.ts` is dropped, stubbed to `{}`, or stops reaching the mapper —
 * the cloud counterpart to the desktop's `projectPluginInventory` wiring test.
 *
 * The provenance is deliberately placed on the NON-canonical inventory row in
 * the pack case: a component observed from more than one source must resolve to
 * the most specific origin any observer saw, and reading only `rows[0]` would
 * answer `organic` for a demonstrably pack-sourced component.
 */
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import { ComponentSourceToken } from "@repo/api/src/types/component-source";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
  listByArtifactIds: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: {
    listByArtifactIds: mocks.listByArtifactIds,
  },
}));

import { agentComponentsService } from "../service";

const ORGANIZATION_ID = "org-1";
const COMPONENT_KEY = "my-skill";
const SLUG = encodeComponentSlug(AgentComponentKind.Skill, COMPONENT_KEY, null);
const REPO_URL = "https://github.com/closedloop-ai/symphony-alpha";

function inventoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ac-1",
    organizationId: ORGANIZATION_ID,
    computeTargetId: "target-1",
    componentKind: AgentComponentKind.Skill,
    componentKey: COMPONENT_KEY,
    externalComponentId: `skill::${COMPONENT_KEY}`,
    harness: "claude",
    name: "My Skill",
    sourceUrl: null,
    installPath: null,
    packId: null,
    scope: null,
    projectPath: null,
    description: null,
    metadata: null,
    content: "BODY",
    contentHash: "hash-0",
    resolvedState: "resolved",
    variantsTruncated: false,
    variantsTruncatedReason: null,
    firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-01-10T00:00:00.000Z"),
    computeTarget: { id: "target-1", userId: "user-1" },
    sessionUsages: [],
    ...overrides,
  };
}

/** One stored revision, carrying the pre-ISS-6232 `""` source sentinel. */
function sentinelVersionRow(overrides: Record<string, unknown> = {}) {
  return {
    contentHash: "hash-0",
    source: "",
    format: "md",
    firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    content: "BODY",
    definitionVersion: null,
    ...overrides,
  };
}

function installDetailDb(
  inventory: Record<string, unknown>[],
  versions: Record<string, unknown>[]
) {
  const versionFindMany = vi.fn((args: { skip?: number; take?: number }) => {
    const from = args.skip ?? 0;
    return Promise.resolve(
      versions.slice(from, from + (args.take ?? versions.length))
    );
  });
  const db = {
    agentComponent: {
      findMany: vi.fn().mockResolvedValue(inventory),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    agentComponentVersion: { findMany: versionFindMany },
    agentComponentSessionUsage: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    agentComponentInvocation: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
    sessionDetail: { findMany: vi.fn().mockResolvedValue([]) },
    definitionVersion: { findMany: vi.fn().mockResolvedValue([]) },
    definitionVersionEditor: { findMany: vi.fn().mockResolvedValue([]) },
    sourceOccurrence: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
  };
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
}

/**
 * Drive the production detail read over `inventory` with ONE stored revision
 * carrying the `""` sentinel, and hand back the emitted sources. Returns the
 * whole list rather than asserting here: an assertion in a helper is invisible
 * to the reader of the test that calls it (and trips `noMisplacedAssertion`),
 * so every expectation lives in the `it` that owns it. A missing revision
 * surfaces as an empty array, which fails the caller's length check.
 */
async function readVersionSources(
  inventory: Record<string, unknown>[]
): Promise<string[]> {
  installDetailDb(inventory, [sentinelVersionRow()]);
  const detail = await agentComponentsService.getDetailForOrg(
    ORGANIZATION_ID,
    SLUG
  );
  return (detail?.versions ?? []).map((version) => version.source);
}

describe("getDetailForOrg — version source derivation (ISS-6232)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("reports a pack recorded on a NON-canonical inventory row", async () => {
    // rows[0] is the canonical representative and knows only an install path.
    // The fold across every row is what surfaces the pack; reading the
    // representative alone would answer `organic`.
    const sources = await readVersionSources([
      inventoryRow({ installPath: "/w/.claude/skills/my-skill.md" }),
      inventoryRow({
        id: "ac-2",
        computeTargetId: "target-2",
        computeTarget: { id: "target-2", userId: "user-2" },
        packId: "gstack",
        installPath: "/w/.claude/plugins/gstack/skills/my-skill.md",
      }),
    ]);
    expect(sources).toEqual(["gstack"]);
  });

  it("reports the repository for a repo-linked component with no pack", async () => {
    const sources = await readVersionSources([
      inventoryRow({ sourceUrl: REPO_URL, scope: "project" }),
    ]);
    expect(sources).toEqual([REPO_URL]);
  });

  it("reports `organic` for a component authored on the machine", async () => {
    const sources = await readVersionSources([
      inventoryRow({ installPath: "/w/.claude/skills/my-skill.md" }),
    ]);
    expect(sources).toEqual([ComponentSourceToken.Organic]);
  });

  it("reports `unknown` when no provenance was captured, never the sentinel", async () => {
    const sources = await readVersionSources([inventoryRow()]);
    expect(sources).toEqual([ComponentSourceToken.Unknown]);
    expect(sources).not.toContain("");
  });

  it("keeps `organic` and `unknown` distinguishable on the wire", async () => {
    const [authoredHere] = await readVersionSources([
      inventoryRow({ installPath: "/w/.claude/skills/my-skill.md" }),
    ]);
    const [undetermined] = await readVersionSources([inventoryRow()]);
    expect(authoredHere).toBe(ComponentSourceToken.Organic);
    expect(undetermined).toBe(ComponentSourceToken.Unknown);
    expect(authoredHere).not.toBe(undetermined);
  });

  it("keeps a persisted non-sentinel source instead of re-deriving it", async () => {
    installDetailDb(
      [inventoryRow({ packId: "gstack" })],
      [sentinelVersionRow({ source: "superpowers" })]
    );
    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );
    expect(detail?.versions[0].source).toBe("superpowers");
  });
});
