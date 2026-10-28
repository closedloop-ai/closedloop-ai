import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { listSessionsByArtifactIds } from "./list-by-artifact-ids";
import { findDbPaginatedPage } from "./list-page-fetch";
import {
  agentSessionListSelect,
  agentSessionListSelectForOrganization,
} from "./records";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

/**
 * ISS-8712 (whitlockk / codex review): the artifact-tag join on a Sessions read is
 * scoped to the reading organization IN SQL, not only in the mapper.
 *
 * `TagArtifact` carries no same-org constraint, so a row joining another
 * tenant's `Tag` to this org's Artifact is representable. `projectArtifactTags`
 * drops such a row before serialization — that check is unchanged and still
 * tested — but it only runs after Prisma has already loaded the foreign row.
 * The Branch read has always put the predicate on the relation itself
 * (`branch-read-selects.ts`); these assertions are what stop the Sessions reads
 * drifting back off it.
 *
 * Asserted on the `select` Prisma is ACTUALLY HANDED by each production path,
 * not on the exported select constant, because the defect being guarded is a
 * call site passing the unscoped builder — which a test of the builder alone
 * cannot see.
 */

const ORG_ID = "019f0fcb-8336-7c4d-9f64-528fb9520c32";
const OTHER_ORG_ID = "019f0fcb-8336-7c4d-9f64-528fb9520c33";
const SESSION_ARTIFACT_ID = "019f0fcb-8336-7c4d-9f64-528fb9520c34";

const BASE_WHERE = { artifact: { is: { organizationId: ORG_ID } } };

type CapturedSelect = {
  artifact?: { select?: { tagArtifacts?: { where?: unknown } } };
};

function tagJoinPredicateOf(select: unknown): unknown {
  return (select as CapturedSelect).artifact?.select?.tagArtifacts?.where;
}

describe("Sessions reads scope the artifact-tag join in SQL (ISS-8712)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("puts the org predicate on the relation the paginated list page selects", async () => {
    const sessionDetail = buildAgentSessionDbMock();
    installDb({ sessionDetail });

    await findDbPaginatedPage({
      organizationId: ORG_ID,
      where: BASE_WHERE,
      idleWhere: null,
      orderBy: [],
      offset: 0,
      limit: 10,
    });

    const [args] = sessionDetail.findMany.mock.calls[0] ?? [];
    expect(tagJoinPredicateOf(args?.select)).toEqual({
      tag: { organizationId: ORG_ID },
    });
  });

  it("puts it on the by-artifact-ids read too", async () => {
    const sessionDetail = buildAgentSessionDbMock();
    installDb({ sessionDetail });

    await listSessionsByArtifactIds(ORG_ID, [SESSION_ARTIFACT_ID]);

    const [args] = sessionDetail.findMany.mock.calls[0] ?? [];
    expect(tagJoinPredicateOf(args?.select)).toEqual({
      tag: { organizationId: ORG_ID },
    });
  });

  it("scopes to the CALLER's org, not a constant", async () => {
    const sessionDetail = buildAgentSessionDbMock();
    installDb({ sessionDetail });

    await findDbPaginatedPage({
      organizationId: OTHER_ORG_ID,
      where: { artifact: { is: { organizationId: OTHER_ORG_ID } } },
      idleWhere: null,
      orderBy: [],
      offset: 0,
      limit: 10,
    });

    const [args] = sessionDetail.findMany.mock.calls[0] ?? [];
    expect(tagJoinPredicateOf(args?.select)).toEqual({
      tag: { organizationId: OTHER_ORG_ID },
    });
  });

  it("leaves the unscoped select genuinely unscoped, so the two are distinguishable", () => {
    // The negative half. Without it, an `artifactTagsSelectForOrganization` that
    // silently dropped its `where` would satisfy nothing above only by accident;
    // this states that the scoped builder ADDS the predicate rather than the
    // base one having carried it all along.
    expect(tagJoinPredicateOf(agentSessionListSelect)).toBeUndefined();
    expect(
      tagJoinPredicateOf(agentSessionListSelectForOrganization(ORG_ID))
    ).toEqual({ tag: { organizationId: ORG_ID } });
  });
});
