/**
 * ISS-5355 — the Project facet's option counts.
 *
 * The number next to a project in the facet, and the number the project-detail
 * strip renders, are the same question as "how many rows does selecting this
 * project return". The counting itself is SQL (ISS-11895), so what it counts —
 * sessions not links, RELATES_TO links to documents, projects named in this org
 * — is pinned against Postgres in `project-facet-options.integration.test.ts`.
 * These pin the read's shape around it: the population it reads, a fixed two
 * queries however many projects are in play (never the per-project fan-out
 * `apps/api/AGENTS.md` bans), and a total order over what the aggregate
 * returns.
 */

import type { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDb } from "@/__tests__/support/agent-sessions/service.test-harness";
import { buildProjectFacetOptions } from "./project-facet-options";

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

const ORG_ID = "org_1";
const PROJECT_A = "019f8008-1969-74f9-b056-99c13cca9a07";
const PROJECT_B = "019f8008-1969-74f9-b056-99c13cca9a08";
const SESSION_WHERE: Prisma.SessionDetailWhereInput = { harness: "codex" };

type CountRow = {
  projectId: string;
  projectName: string;
  sessionCount: number;
};

function installProjectDb(options: {
  sessionIds: string[];
  counts: CountRow[];
}) {
  const artifactFindMany = vi
    .fn()
    .mockResolvedValue(options.sessionIds.map((id) => ({ id })));
  const queryRaw = vi.fn().mockResolvedValue(options.counts);
  installDb({ artifact: { findMany: artifactFindMany }, $queryRaw: queryRaw });
  return { artifactFindMany, queryRaw };
}

describe("buildProjectFacetOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the population through the session where, scoped to the org", async () => {
    const { artifactFindMany } = installProjectDb({
      sessionIds: ["session-1"],
      counts: [],
    });

    await buildProjectFacetOptions(ORG_ID, SESSION_WHERE);

    expect(artifactFindMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, session: { is: SESSION_WHERE } },
      select: { id: true },
    });
  });

  it("hands the aggregate exactly the population's session ids and the org", async () => {
    const { queryRaw } = installProjectDb({
      sessionIds: ["session-1", "session-2"],
      counts: [],
    });

    await buildProjectFacetOptions(ORG_ID, SESSION_WHERE);

    const [statement] = queryRaw.mock.calls[0] ?? [];
    expect(statement.values).toContainEqual(["session-1", "session-2"]);
    expect(statement.values).toContain(ORG_ID);
  });

  it("issues two reads regardless of how many projects are in play", async () => {
    // The banned shape was a `count` per candidate project inside a
    // `Promise.all`, so the query count scaled with tenant-controlled project
    // cardinality and starved the pg pool. Twelve projects — more than the
    // 10-connection `DATABASE_URL` pool — must still be two queries total.
    const counts = Array.from({ length: 12 }, (_, index) => ({
      projectId: `019f8008-1969-74f9-b056-99c13cca9a${(index + 10).toString(16).padStart(2, "0")}`,
      projectName: `Project ${index}`,
      sessionCount: 1,
    }));
    const { artifactFindMany, queryRaw } = installProjectDb({
      sessionIds: counts.map((_, index) => `session-${index}`),
      counts,
    });

    const options = await buildProjectFacetOptions(ORG_ID, SESSION_WHERE);

    expect(options).toHaveLength(12);
    expect(artifactFindMany).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("orders by session count descending", async () => {
    installProjectDb({
      sessionIds: ["session-1"],
      counts: [
        {
          projectId: PROJECT_A,
          projectName: "ClosedLoop AI",
          sessionCount: 2,
        },
        { projectId: PROJECT_B, projectName: "Relay Host", sessionCount: 3 },
      ],
    });

    const options = await buildProjectFacetOptions(ORG_ID, SESSION_WHERE);

    expect(options.map((option) => option.projectId)).toEqual([
      PROJECT_B,
      PROJECT_A,
    ]);
  });

  it("returns no options and issues no aggregate when the population is empty", async () => {
    const { queryRaw } = installProjectDb({ sessionIds: [], counts: [] });

    const options = await buildProjectFacetOptions(ORG_ID, SESSION_WHERE);

    expect(options).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  // ISS-10851 — the two cases the session-count case above cannot reach. It
  // feeds distinct counts, so both tiebreak clauses could be deleted and it
  // would stay green. These feed EQUAL counts with the aggregate answering in
  // the reverse of the published order, which is the real hazard: it carries
  // no `ORDER BY`, so its row order is the planner's to choose and is not the
  // order the SQL candidate's `UNION ALL` emits.
  it("orders an equal-count tie by project name", async () => {
    installProjectDb({
      sessionIds: ["session-1", "session-2"],
      counts: [
        { projectId: PROJECT_B, projectName: "Relay Host", sessionCount: 1 },
        {
          projectId: PROJECT_A,
          projectName: "Alpha Symphony",
          sessionCount: 1,
        },
      ],
    });

    const options = await buildProjectFacetOptions(ORG_ID, SESSION_WHERE);

    expect(options.map((option) => option.projectName)).toEqual([
      "Alpha Symphony",
      "Relay Host",
    ]);
  });

  it("falls through to projectId when two tied projects share a name", async () => {
    // `Project` carries only `@@unique([organizationId, slug])`, so nothing
    // stops one org holding two projects of the same name — and a name-only
    // tiebreak then leaves the order to whatever the aggregate returned.
    installProjectDb({
      sessionIds: ["session-1", "session-2"],
      counts: [
        {
          projectId: PROJECT_B,
          projectName: "Duplicate Name",
          sessionCount: 1,
        },
        {
          projectId: PROJECT_A,
          projectName: "Duplicate Name",
          sessionCount: 1,
        },
      ],
    });

    const options = await buildProjectFacetOptions(ORG_ID, SESSION_WHERE);

    expect(options.map((option) => option.projectId)).toEqual([
      PROJECT_A,
      PROJECT_B,
    ]);
  });
});
