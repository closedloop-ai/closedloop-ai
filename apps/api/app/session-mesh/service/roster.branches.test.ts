import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MeshDb,
  resetMeshDb,
} from "@/__tests__/support/session-mesh/session-mesh-db.test-helpers";
import { readRosterPage } from "./roster";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (
    await import(
      "@/__tests__/support/session-mesh/session-mesh-db.test-helpers"
    )
  ).meshWithDb(),
}));

const NOW = new Date("2026-09-25T12:00:00.000Z");
const ORG = "0199a1b2-0000-7000-8000-000000000001";

let db: MeshDb;

function row(agentId: string, context: unknown = {}) {
  return { agentId, repository: "r", context };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = resetMeshDb();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("readRosterPage query", () => {
  it("scopes to live org presences only when no filters are given", async () => {
    db.sessionMeshPresence.findMany.mockResolvedValue([]);

    await expect(readRosterPage(ORG)).resolves.toEqual({ agents: [] });
    expect(db.sessionMeshPresence.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, expiresAt: { gt: NOW } },
      select: {
        agentId: true,
        repository: true,
        revision: true,
        dirtyStateHash: true,
        configurationHash: true,
        harness: true,
        capabilities: true,
        lineage: true,
        context: true,
        paths: true,
        symbols: true,
        expiresAt: true,
        user: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { agentId: "asc" },
      take: 501,
    });
  });

  it("adds repository, revision, and cursor filters when supplied", async () => {
    db.sessionMeshPresence.findMany.mockResolvedValue([]);

    await readRosterPage(ORG, { repository: "r", revision: "v" }, "agent-5");

    expect(db.sessionMeshPresence.findMany.mock.calls[0]?.[0].where).toEqual({
      organizationId: ORG,
      expiresAt: { gt: NOW },
      repository: "r",
      revision: "v",
      agentId: { gt: "agent-5" },
    });
  });

  it("ignores empty repository, revision, and cursor values", async () => {
    db.sessionMeshPresence.findMany.mockResolvedValue([]);

    await readRosterPage(ORG, { repository: "", revision: "" }, "");

    expect(db.sessionMeshPresence.findMany.mock.calls[0]?.[0].where).toEqual({
      organizationId: ORG,
      expiresAt: { gt: NOW },
    });
  });
});

describe("readRosterPage context redaction", () => {
  it("collapses restricted context and passes every other shape through", async () => {
    db.sessionMeshPresence.findMany.mockResolvedValue([
      row("a", { sensitivity: "restricted", summary: "secret plan" }),
      row("b", { sensitivity: "normal", summary: "public" }),
      row("c", null),
      row("d", "raw"),
      // Unreachable through the writer: the service.ts presence upsert stores
      // sanitizeMeshContext's output, which is always a plain object, so an
      // array never lands in this column. Pinned only for a hand-edited row.
      row("e", [{ sensitivity: "restricted" }]),
    ]);

    const page = await readRosterPage(ORG);

    expect(page.agents.map((agent) => agent.context)).toEqual([
      { sensitivity: "restricted" },
      { sensitivity: "normal", summary: "public" },
      null,
      "raw",
      [{ sensitivity: "restricted" }],
    ]);
    expect(page).not.toHaveProperty("nextCursor");
  });
});

describe("readRosterPage pagination", () => {
  it("returns 500 agents and the last agent id as the cursor when more exist", async () => {
    const rows = Array.from({ length: 501 }, (_, index) =>
      row(`agent-${String(index).padStart(3, "0")}`)
    );
    db.sessionMeshPresence.findMany.mockResolvedValue(rows);

    const page = await readRosterPage(ORG);

    expect(page.agents).toHaveLength(500);
    expect(page.nextCursor).toBe("agent-499");
  });
});
