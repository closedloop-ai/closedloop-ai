/**
 * ISS-5355 — the Project facet's option counts.
 *
 * The number next to a project in the facet, and the number the project-detail
 * strip renders, are the same question as "how many rows does selecting this
 * project return". These pin the three ways that can silently go wrong: counting
 * LINKS instead of SESSIONS (a session linked to three documents in one project
 * is one session), offering an option that resolves to nothing, and issuing one
 * pooled query per project (the unbounded fan-out `apps/api/AGENTS.md` bans).
 */
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
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

type LinkRow = { sourceId: string; projectId: string | null };

function installProjectDb(options: {
  links: LinkRow[];
  projects: { id: string; name: string }[];
}) {
  const linkFindMany = vi.fn().mockResolvedValue(
    options.links.map((link) => ({
      sourceId: link.sourceId,
      target: { projectId: link.projectId },
    }))
  );
  const projectFindMany = vi.fn().mockResolvedValue(options.projects);
  installDb({
    artifactLink: { findMany: linkFindMany },
    project: { findMany: projectFindMany },
  });
  return { linkFindMany, projectFindMany };
}

describe("buildProjectFacetOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts SESSIONS per project, not the links that reached them", async () => {
    // One session linked to three documents in the project, plus a second
    // session linked once. A link-level tally would report 4.
    installProjectDb({
      links: [
        { sourceId: "session-1", projectId: PROJECT_A },
        { sourceId: "session-1", projectId: PROJECT_A },
        { sourceId: "session-1", projectId: PROJECT_A },
        { sourceId: "session-2", projectId: PROJECT_A },
      ],
      projects: [{ id: PROJECT_A, name: "Symphony Alpha" }],
    });

    const options = await buildProjectFacetOptions(ORG_ID, SESSION_WHERE);

    expect(options).toEqual([
      { projectId: PROJECT_A, projectName: "Symphony Alpha", sessionCount: 2 },
    ]);
  });

  it("issues ONE aggregate read regardless of how many projects are in play", async () => {
    // The banned shape was a `count` per candidate project inside a
    // `Promise.all`, so the query count scaled with tenant-controlled project
    // cardinality and starved the pg pool. Twelve projects — more than the
    // 10-connection `DATABASE_URL` pool — must still be two queries total.
    const projectIds = Array.from(
      { length: 12 },
      (_, index) =>
        `019f8008-1969-74f9-b056-99c13cca9a${(index + 10).toString(16).padStart(2, "0")}`
    );
    const { linkFindMany, projectFindMany } = installProjectDb({
      links: projectIds.map((projectId, index) => ({
        sourceId: `session-${index}`,
        projectId,
      })),
      projects: projectIds.map((id, index) => ({
        id,
        name: `Project ${index}`,
      })),
    });

    const options = await buildProjectFacetOptions(ORG_ID, SESSION_WHERE);

    expect(options).toHaveLength(12);
    expect(linkFindMany).toHaveBeenCalledTimes(1);
    expect(projectFindMany).toHaveBeenCalledTimes(1);
  });

  it("orders by session count descending", async () => {
    installProjectDb({
      links: [
        { sourceId: "session-1", projectId: PROJECT_A },
        { sourceId: "session-2", projectId: PROJECT_A },
        { sourceId: "session-3", projectId: PROJECT_B },
        { sourceId: "session-4", projectId: PROJECT_B },
        { sourceId: "session-5", projectId: PROJECT_B },
      ],
      projects: [
        { id: PROJECT_A, name: "Symphony Alpha" },
        { id: PROJECT_B, name: "Relay Host" },
      ],
    });

    const options = await buildProjectFacetOptions(ORG_ID, SESSION_WHERE);

    expect(options.map((option) => option.projectId)).toEqual([
      PROJECT_B,
      PROJECT_A,
    ]);
  });

  it("drops a project row that no longer resolves to a name", async () => {
    // Labelling it with a raw id would put a value on screen matching no project
    // the reader can recognize.
    installProjectDb({
      links: [
        { sourceId: "session-1", projectId: PROJECT_A },
        { sourceId: "session-2", projectId: PROJECT_B },
      ],
      projects: [{ id: PROJECT_A, name: "Symphony Alpha" }],
    });

    const options = await buildProjectFacetOptions(ORG_ID, SESSION_WHERE);

    expect(options.map((option) => option.projectId)).toEqual([PROJECT_A]);
  });

  it("returns no options and issues no name lookup when nothing is linked", async () => {
    const { projectFindMany } = installProjectDb({ links: [], projects: [] });

    const options = await buildProjectFacetOptions(ORG_ID, SESSION_WHERE);

    expect(options).toEqual([]);
    expect(projectFindMany).not.toHaveBeenCalled();
  });

  it("ignores unparented linked documents", async () => {
    // A null projectId link is "linked to a document in no project" — not a
    // selectable facet value.
    installProjectDb({
      links: [{ sourceId: "session-1", projectId: null }],
      projects: [],
    });

    const options = await buildProjectFacetOptions(ORG_ID, SESSION_WHERE);

    expect(options).toEqual([]);
  });

  it("scopes the edge read to the org, RELATES_TO, and DOCUMENT targets", async () => {
    // The linked-artifacts projection the facet claims parity with selects only
    // RELATES_TO edges (`records.ts`). A PRODUCES/BLOCKS edge to a document in
    // the project is reachable on `artifact_links` and would count a session the
    // projection never shows, so the link type belongs in the predicate.
    const { linkFindMany } = installProjectDb({
      links: [{ sourceId: "session-1", projectId: PROJECT_A }],
      projects: [{ id: PROJECT_A, name: "Symphony Alpha" }],
    });

    await buildProjectFacetOptions(ORG_ID, SESSION_WHERE);

    expect(linkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG_ID,
          linkType: LinkType.RelatesTo,
          target: {
            is: {
              type: ArtifactType.Document,
              projectId: { not: null },
            },
          },
          source: {
            is: { organizationId: ORG_ID, session: { is: SESSION_WHERE } },
          },
        },
      })
    );
  });
});
