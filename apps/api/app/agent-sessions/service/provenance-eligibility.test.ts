/**
 * ISS-7234 — the provenance eligibility query.
 *
 * The two-org cases drive the REAL query against a fake that applies Prisma's
 * own semantics: an absent `where` key constrains nothing. So deleting
 * `organizationId` from the production where clause makes org-B rows match and
 * turns the isolation tests red, which is the only thing that makes them
 * coverage rather than decoration (apps/api/AGENTS.md).
 */
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import {
  ARTIFACT_SESSIONS_TAB_ELIGIBLE_KINDS,
  ProvenanceRelationshipKind,
  RELATED_SESSION_ELIGIBLE_KINDS,
} from "@repo/api/src/types/provenance-relationship";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  SessionArtifactLinkRole,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: { DbNull: Symbol("DbNull") },
}));

import {
  classifySessionLinkKind,
  linkTypesForKinds,
  listEligibleSessionArtifactIds,
  readSessionProvenanceEvidence,
  selectEligibleSessionIds,
} from "./provenance-eligibility";

const ORG_A = "org-a";
const ORG_B = "org-b";
const ARTIFACT_A = "artifact-a";
const COMPONENT_A = "component-a";

const SESSION_CONTRIBUTOR = "session-a-contributor";
const SESSION_REFERENCER = "session-a-referencer";
const SESSION_COMMENTER = "session-a-commenter";
const SESSION_INVOKER_ONLY = "session-a-invoker-only";
const SESSION_PRODUCER = "session-a-producer";
const SESSION_LEGACY = "session-a-legacy";
const SESSION_BRANCH_REVIEWER = "session-a-branch-reviewer";
const SESSION_COLUMN_REVIEWER = "session-a-column-reviewer";
const SESSION_LIFECYCLE_REVIEWER = "session-a-lifecycle-reviewer";
const SESSION_FOREIGN_LINK = "session-b-foreign-link";
const SESSION_FOREIGN_SOURCE = "session-b-foreign-source";
const SESSION_FOREIGN_INVOKER = "session-b-foreign-invoker";
const DOC_SOURCE = "doc-a-not-a-session";

type LinkRow = {
  organizationId: string;
  targetId: string;
  targetOrganizationId: string;
  linkType: string;
  sourceId: string;
  sourceOrganizationId: string;
  /** Absent means a SESSION-typed source artifact. */
  sourceType?: string;
  /** The `artifact_links.branch_participation` column; null on legacy rows. */
  branchParticipation?: string | null;
  metadata: unknown;
};

/**
 * Every link row targets ARTIFACT_A. Two of them are the cross-org vectors: one
 * whose LINK belongs to org B, one whose link is org A's but whose SOURCE
 * session belongs to org B. Both must be invisible to an org-A caller.
 */
const LINK_ROWS: LinkRow[] = [
  {
    organizationId: ORG_A,
    targetId: ARTIFACT_A,
    targetOrganizationId: ORG_A,
    linkType: LinkType.RelatesTo,
    sourceId: SESSION_CONTRIBUTOR,
    sourceOrganizationId: ORG_A,
    metadata: { relation: ArtifactRefRelation.Created },
  },
  {
    organizationId: ORG_A,
    targetId: ARTIFACT_A,
    targetOrganizationId: ORG_A,
    linkType: LinkType.RelatesTo,
    sourceId: SESSION_COMMENTER,
    sourceOrganizationId: ORG_A,
    metadata: { relation: ArtifactRefRelation.Reviewed },
  },
  {
    organizationId: ORG_A,
    targetId: ARTIFACT_A,
    targetOrganizationId: ORG_A,
    linkType: LinkType.RelatesTo,
    sourceId: SESSION_REFERENCER,
    sourceOrganizationId: ORG_A,
    metadata: { relation: ArtifactRefRelation.Referenced },
  },
  {
    organizationId: ORG_A,
    targetId: ARTIFACT_A,
    targetOrganizationId: ORG_A,
    linkType: LinkType.RelatesTo,
    sourceId: SESSION_LEGACY,
    sourceOrganizationId: ORG_A,
    metadata: null,
  },
  {
    organizationId: ORG_A,
    targetId: ARTIFACT_A,
    targetOrganizationId: ORG_A,
    linkType: LinkType.Produces,
    sourceId: SESSION_PRODUCER,
    sourceOrganizationId: ORG_A,
    metadata: null,
  },
  {
    organizationId: ORG_A,
    targetId: ARTIFACT_A,
    targetOrganizationId: ORG_A,
    linkType: LinkType.RelatesTo,
    sourceId: SESSION_BRANCH_REVIEWER,
    sourceOrganizationId: ORG_A,
    metadata: {
      relation: ArtifactRefRelation.Workspace,
      method: ArtifactRefMethod.PrReviewFeedbackCommand,
    },
  },
  {
    organizationId: ORG_A,
    targetId: ARTIFACT_A,
    targetOrganizationId: ORG_A,
    linkType: LinkType.RelatesTo,
    sourceId: SESSION_COLUMN_REVIEWER,
    sourceOrganizationId: ORG_A,
    branchParticipation: BranchParticipationKind.Reviewed,
    metadata: {
      relation: ArtifactRefRelation.Workspace,
      method: ArtifactRefMethod.GitCommand,
    },
  },
  {
    organizationId: ORG_A,
    targetId: ARTIFACT_A,
    targetOrganizationId: ORG_A,
    linkType: LinkType.RelatesTo,
    sourceId: SESSION_LIFECYCLE_REVIEWER,
    sourceOrganizationId: ORG_A,
    metadata: {
      relation: ArtifactRefRelation.Workspace,
      method: ArtifactRefMethod.GitCommand,
      branchLifecycleEvents: [
        { kind: BranchLifecycleBoundaryKind.ReviewFeedback },
      ],
    },
  },
  {
    organizationId: ORG_B,
    targetId: ARTIFACT_A,
    targetOrganizationId: ORG_B,
    linkType: LinkType.RelatesTo,
    sourceId: SESSION_FOREIGN_LINK,
    sourceOrganizationId: ORG_B,
    metadata: { relation: ArtifactRefRelation.Created },
  },
  {
    organizationId: ORG_A,
    targetId: ARTIFACT_A,
    targetOrganizationId: ORG_A,
    linkType: LinkType.RelatesTo,
    sourceId: SESSION_FOREIGN_SOURCE,
    sourceOrganizationId: ORG_B,
    metadata: { relation: ArtifactRefRelation.Created },
  },
  {
    organizationId: ORG_A,
    targetId: ARTIFACT_A,
    targetOrganizationId: ORG_A,
    linkType: LinkType.RelatesTo,
    sourceId: DOC_SOURCE,
    sourceOrganizationId: ORG_A,
    sourceType: ArtifactType.Document,
    metadata: { relation: ArtifactRefRelation.Created },
  },
];

type UsageRow = {
  agentSessionId: string;
  agentComponentId: string;
  componentOrganizationId: string;
  sessionOrganizationId: string;
};

const USAGE_ROWS: UsageRow[] = [
  {
    agentSessionId: SESSION_INVOKER_ONLY,
    agentComponentId: COMPONENT_A,
    componentOrganizationId: ORG_A,
    sessionOrganizationId: ORG_A,
  },
  {
    agentSessionId: SESSION_CONTRIBUTOR,
    agentComponentId: COMPONENT_A,
    componentOrganizationId: ORG_A,
    sessionOrganizationId: ORG_A,
  },
  {
    agentSessionId: SESSION_FOREIGN_INVOKER,
    agentComponentId: COMPONENT_A,
    componentOrganizationId: ORG_A,
    sessionOrganizationId: ORG_B,
  },
];

function linkMatches(row: LinkRow, where: Record<string, unknown>): boolean {
  const org = where.organizationId as string | undefined;
  if (org !== undefined && row.organizationId !== org) {
    return false;
  }
  const targetId = where.targetId as string | undefined;
  if (targetId !== undefined && row.targetId !== targetId) {
    return false;
  }
  const linkType = where.linkType as { in?: string[] } | undefined;
  if (linkType?.in !== undefined && !linkType.in.includes(row.linkType)) {
    return false;
  }
  const sourceOrg = (
    where.source as { is?: { organizationId?: string } } | undefined
  )?.is?.organizationId;
  if (sourceOrg !== undefined && row.sourceOrganizationId !== sourceOrg) {
    return false;
  }
  const targetOrg = (
    where.target as { is?: { organizationId?: string } } | undefined
  )?.is?.organizationId;
  if (targetOrg !== undefined && row.targetOrganizationId !== targetOrg) {
    return false;
  }
  const sourceType = (where.source as { is?: { type?: string } } | undefined)
    ?.is?.type;
  if (
    sourceType !== undefined &&
    (row.sourceType ?? ArtifactType.Session) !== sourceType
  ) {
    return false;
  }
  return true;
}

function usageMatches(row: UsageRow, where: Record<string, unknown>): boolean {
  const componentIds = (where.agentComponentId as { in?: string[] } | undefined)
    ?.in;
  if (
    componentIds !== undefined &&
    !componentIds.includes(row.agentComponentId)
  ) {
    return false;
  }
  const componentOrg = (
    where.agentComponent as { is?: { organizationId?: string } } | undefined
  )?.is?.organizationId;
  if (
    componentOrg !== undefined &&
    row.componentOrganizationId !== componentOrg
  ) {
    return false;
  }
  const sessionOrg = (
    where.session as
      | { is?: { artifact?: { is?: { organizationId?: string } } } }
      | undefined
  )?.is?.artifact?.is?.organizationId;
  if (sessionOrg !== undefined && row.sessionOrganizationId !== sessionOrg) {
    return false;
  }
  return true;
}

/**
 * Prisma projects EXACTLY the columns `select` names, so a column the production
 * query forgets to select is absent from the row rather than silently present.
 * Honoring that here is what makes the branch-participation cases coverage: drop
 * `branchParticipation` from the real `select` and the column-sourced reviewer
 * disappears from the eligible set again.
 */
const LINK_ROW_COLUMNS: Record<string, (row: LinkRow) => unknown> = {
  sourceId: (row) => row.sourceId,
  linkType: (row) => row.linkType,
  metadata: (row) => row.metadata,
  branchParticipation: (row) => row.branchParticipation ?? null,
};

function projectLinkRow(
  row: LinkRow,
  select: Record<string, boolean> | undefined
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [column, read] of Object.entries(LINK_ROW_COLUMNS)) {
    if (select?.[column] === true) {
      projected[column] = read(row);
    }
  }
  return projected;
}

beforeEach(() => {
  vi.clearAllMocks();
  const db = {
    artifactLink: {
      findMany: ({
        where,
        select,
      }: {
        where: Record<string, unknown>;
        select?: Record<string, boolean>;
      }) =>
        Promise.resolve(
          LINK_ROWS.filter((row) => linkMatches(row, where)).map((row) =>
            projectLinkRow(row, select)
          )
        ),
    },
    agentComponentSessionUsage: {
      findMany: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          USAGE_ROWS.filter((row) => usageMatches(row, where)).map((row) => ({
            agentSessionId: row.agentSessionId,
          }))
        ),
    },
  };
  mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
    cb(db)
  );
});

describe("classifySessionLinkKind (ISS-7234 AC1)", () => {
  it("maps each persisted relation to its distinct kind", () => {
    const kindFor = (relation: string) =>
      classifySessionLinkKind({
        linkType: LinkType.RelatesTo,
        metadata: { relation },
      });

    expect(kindFor(ArtifactRefRelation.Created)).toBe("contribution");
    expect(kindFor(ArtifactRefRelation.Output)).toBe("contribution");
    expect(kindFor(ArtifactRefRelation.Reviewed)).toBe("comment");
    expect(kindFor(ArtifactRefRelation.Input)).toBe("usage");
    expect(kindFor(ArtifactRefRelation.Workspace)).toBe("usage");
    expect(kindFor(ArtifactRefRelation.Referenced)).toBe("reference");
  });

  it("classifies a PRODUCES edge as production regardless of metadata", () => {
    expect(
      classifySessionLinkKind({
        linkType: LinkType.Produces,
        metadata: { relation: ArtifactRefRelation.Referenced },
      })
    ).toBe("production");
  });

  it("fails closed to reference on absent, unknown, or hostile metadata", () => {
    for (const metadata of [
      null,
      undefined,
      {},
      { relation: "some-future-relation" },
      { relation: 42 },
      { relation: "__proto__" },
      { relation: "constructor" },
    ]) {
      expect(
        classifySessionLinkKind({ linkType: LinkType.RelatesTo, metadata })
      ).toBe("reference");
    }
  });
});

/**
 * `slug-links.ts` writes `role`/`method` on every row and `relation` only when
 * the extractor had one, so a relation-less link is COMMON, not merely legacy.
 * Reporting those as `reference` would assert "named in prose" about a link the
 * session actually read as input.
 */
describe("classifySessionLinkKind — relation-less links (ISS-7234 AC1)", () => {
  it("uses the stated role when the link carries no relation", () => {
    const kindForRole = (role: string) =>
      classifySessionLinkKind({
        linkType: LinkType.RelatesTo,
        metadata: { role, method: ArtifactRefMethod.SlugInMessage },
      });

    expect(kindForRole(SessionArtifactLinkRole.Input)).toBe("usage");
    expect(kindForRole(SessionArtifactLinkRole.Workspace)).toBe("usage");
    expect(kindForRole(SessionArtifactLinkRole.Referenced)).toBe("reference");
  });

  it("falls back to the always-present method when no role is stated", () => {
    expect(
      classifySessionLinkKind({
        linkType: LinkType.RelatesTo,
        metadata: { method: ArtifactRefMethod.McpToolCall, isPrimary: false },
      })
    ).toBe("usage");
    expect(
      classifySessionLinkKind({
        linkType: LinkType.RelatesTo,
        metadata: { method: ArtifactRefMethod.SlugInCwd, isPrimary: false },
      })
    ).toBe("usage");
    expect(
      classifySessionLinkKind({
        linkType: LinkType.RelatesTo,
        metadata: { method: ArtifactRefMethod.SlugInMessage, isPrimary: false },
      })
    ).toBe("reference");
  });

  it("prefers a stated relation over the role it disagrees with", () => {
    expect(
      classifySessionLinkKind({
        linkType: LinkType.RelatesTo,
        metadata: {
          relation: ArtifactRefRelation.Created,
          role: SessionArtifactLinkRole.Referenced,
          method: ArtifactRefMethod.SlugInMessage,
        },
      })
    ).toBe("contribution");
  });
});

/**
 * A branch/PR link states participation in FIVE places, not one: the
 * `branch_participation` column, `relationTypes`, `relation`, `method`, and
 * `branchLifecycleEvents`. `deriveBranchParticipationFromMetadata` is the
 * canonical reader of those, and it already calls `relation: workspace` +
 * `method: pr_review_feedback_command` REVIEWED participation. Classifying that
 * link as usage here made it fail `RELATED_SESSION_ELIGIBLE_KINDS` and vanish
 * from Related Sessions — a false negative that renders as an empty list.
 */
describe("classifySessionLinkKind — branch participation (ISS-7234)", () => {
  it("classifies a review-feedback link whose relation is workspace as a comment", () => {
    expect(
      classifySessionLinkKind({
        linkType: LinkType.RelatesTo,
        metadata: {
          relation: ArtifactRefRelation.Workspace,
          method: ArtifactRefMethod.PrReviewFeedbackCommand,
        },
      })
    ).toBe("comment");
  });

  it("reads participation from the column, relationTypes, and lifecycle events", () => {
    expect(
      classifySessionLinkKind({
        linkType: LinkType.RelatesTo,
        branchParticipation: BranchParticipationKind.Reviewed,
        metadata: { relation: ArtifactRefRelation.Workspace },
      })
    ).toBe("comment");
    expect(
      classifySessionLinkKind({
        linkType: LinkType.RelatesTo,
        metadata: {
          relation: ArtifactRefRelation.Workspace,
          relationTypes: [SessionPrRelationType.Reviewed],
        },
      })
    ).toBe("comment");
    expect(
      classifySessionLinkKind({
        linkType: LinkType.RelatesTo,
        metadata: {
          relation: ArtifactRefRelation.Workspace,
          relationTypes: [SessionPrRelationType.Created],
        },
      })
    ).toBe("contribution");
    expect(
      classifySessionLinkKind({
        linkType: LinkType.RelatesTo,
        metadata: {
          relation: ArtifactRefRelation.Workspace,
          branchLifecycleEvents: [
            { kind: BranchLifecycleBoundaryKind.ReviewFeedback },
          ],
        },
      })
    ).toBe("comment");
  });

  it("leaves a passive workspace checkout as usage", () => {
    expect(
      classifySessionLinkKind({
        linkType: LinkType.RelatesTo,
        branchParticipation: null,
        metadata: {
          relation: ArtifactRefRelation.Workspace,
          method: ArtifactRefMethod.GitCommand,
        },
      })
    ).toBe("usage");
  });
});

describe("linkTypesForKinds (ISS-7234 AC1)", () => {
  it("reads only RELATES_TO for the Related Sessions kinds", () => {
    expect(linkTypesForKinds(RELATED_SESSION_ELIGIBLE_KINDS)).toEqual([
      LinkType.RelatesTo,
    ]);
  });

  it("issues no link read when only invocation is requested", () => {
    expect(linkTypesForKinds([ProvenanceRelationshipKind.Invocation])).toEqual(
      []
    );
  });
});

describe("selectEligibleSessionIds (ISS-7234 AC3)", () => {
  it("drops an invocation-only session and keeps a session that also contributed", () => {
    expect(
      selectEligibleSessionIds(
        [
          {
            sessionArtifactId: "s1",
            kind: ProvenanceRelationshipKind.Invocation,
          },
          {
            sessionArtifactId: "s2",
            kind: ProvenanceRelationshipKind.Contribution,
          },
          {
            sessionArtifactId: "s2",
            kind: ProvenanceRelationshipKind.Invocation,
          },
        ],
        RELATED_SESSION_ELIGIBLE_KINDS
      )
    ).toEqual(["s2"]);
  });

  it("dedupes a session with several eligible edges", () => {
    expect(
      selectEligibleSessionIds(
        [
          {
            sessionArtifactId: "s1",
            kind: ProvenanceRelationshipKind.Contribution,
          },
          { sessionArtifactId: "s1", kind: ProvenanceRelationshipKind.Comment },
        ],
        RELATED_SESSION_ELIGIBLE_KINDS
      )
    ).toEqual(["s1"]);
  });
});

describe("listEligibleSessionArtifactIds — contribution eligibility (AC2, AC3)", () => {
  it("returns only the sessions that wrote or commented", async () => {
    const ids = await listEligibleSessionArtifactIds({
      organizationId: ORG_A,
      artifactId: ARTIFACT_A,
      kinds: RELATED_SESSION_ELIGIBLE_KINDS,
      agentComponentIds: [COMPONENT_A],
    });

    expect(ids).toEqual([
      SESSION_CONTRIBUTOR,
      SESSION_COMMENTER,
      SESSION_BRANCH_REVIEWER,
      SESSION_COLUMN_REVIEWER,
      SESSION_LIFECYCLE_REVIEWER,
    ]);
  });

  it("keeps the invocation-only session representable under the wider kind set", async () => {
    const ids = await listEligibleSessionArtifactIds({
      organizationId: ORG_A,
      artifactId: ARTIFACT_A,
      kinds: ARTIFACT_SESSIONS_TAB_ELIGIBLE_KINDS,
      agentComponentIds: [COMPONENT_A],
    });

    expect(ids).toEqual([
      SESSION_CONTRIBUTOR,
      SESSION_COMMENTER,
      SESSION_REFERENCER,
      SESSION_LEGACY,
      SESSION_PRODUCER,
      SESSION_BRANCH_REVIEWER,
      SESSION_COLUMN_REVIEWER,
      SESSION_LIFECYCLE_REVIEWER,
      SESSION_INVOKER_ONLY,
    ]);
  });

  it("records the invocation-only session as invocation evidence, not contribution", async () => {
    const evidence = await readSessionProvenanceEvidence({
      organizationId: ORG_A,
      artifactId: ARTIFACT_A,
      kinds: ARTIFACT_SESSIONS_TAB_ELIGIBLE_KINDS,
      agentComponentIds: [COMPONENT_A],
    });

    expect(evidence).toEqual([
      {
        sessionArtifactId: SESSION_CONTRIBUTOR,
        kind: ProvenanceRelationshipKind.Contribution,
      },
      {
        sessionArtifactId: SESSION_COMMENTER,
        kind: ProvenanceRelationshipKind.Comment,
      },
      {
        sessionArtifactId: SESSION_REFERENCER,
        kind: ProvenanceRelationshipKind.Reference,
      },
      {
        sessionArtifactId: SESSION_LEGACY,
        kind: ProvenanceRelationshipKind.Reference,
      },
      {
        sessionArtifactId: SESSION_PRODUCER,
        kind: ProvenanceRelationshipKind.Production,
      },
      {
        sessionArtifactId: SESSION_BRANCH_REVIEWER,
        kind: ProvenanceRelationshipKind.Comment,
      },
      {
        sessionArtifactId: SESSION_COLUMN_REVIEWER,
        kind: ProvenanceRelationshipKind.Comment,
      },
      {
        sessionArtifactId: SESSION_LIFECYCLE_REVIEWER,
        kind: ProvenanceRelationshipKind.Comment,
      },
      {
        sessionArtifactId: SESSION_INVOKER_ONLY,
        kind: ProvenanceRelationshipKind.Invocation,
      },
      {
        sessionArtifactId: SESSION_CONTRIBUTOR,
        kind: ProvenanceRelationshipKind.Invocation,
      },
    ]);
  });
});

describe("listEligibleSessionArtifactIds — two-org isolation (ISS-7234 AC4)", () => {
  it("never returns another org's sessions for the same artifact id", async () => {
    const ids = await listEligibleSessionArtifactIds({
      organizationId: ORG_A,
      artifactId: ARTIFACT_A,
      kinds: ARTIFACT_SESSIONS_TAB_ELIGIBLE_KINDS,
      agentComponentIds: [COMPONENT_A],
    });

    expect(ids).not.toContain(SESSION_FOREIGN_LINK);
    expect(ids).not.toContain(SESSION_FOREIGN_SOURCE);
    expect(ids).not.toContain(SESSION_FOREIGN_INVOKER);
    // Positive sibling: an empty result would satisfy the three lines above.
    expect(ids).toContain(SESSION_CONTRIBUTOR);
    expect(ids).toContain(SESSION_INVOKER_ONLY);
  });

  it("excludes a same-org link whose source is not a session", async () => {
    const ids = await listEligibleSessionArtifactIds({
      organizationId: ORG_A,
      artifactId: ARTIFACT_A,
      kinds: RELATED_SESSION_ELIGIBLE_KINDS,
    });

    // DOC_SOURCE is org A and carries a `created` relation, so only the
    // source-type predicate keeps it out of a Related Sessions answer.
    expect(ids).not.toContain(DOC_SOURCE);
    expect(ids).toContain(SESSION_CONTRIBUTOR);
  });

  it("returns org B's own session to an org B caller", async () => {
    const ids = await listEligibleSessionArtifactIds({
      organizationId: ORG_B,
      artifactId: ARTIFACT_A,
      kinds: RELATED_SESSION_ELIGIBLE_KINDS,
    });

    expect(ids).toEqual([SESSION_FOREIGN_LINK]);
  });
});
