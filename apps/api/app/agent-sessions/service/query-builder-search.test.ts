import type { Prisma } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { buildWhere } from "./query-builder";

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

describe("buildWhere free-text search (ISS-13007)", () => {
  const searchClauses = (where: Prisma.SessionDetailWhereInput) =>
    JSON.stringify(where.AND);

  it("escapes % and _ so the term matches literally", async () => {
    const where = await buildWhere(
      { organizationId: "org-1" },
      { search: "100%_done" },
      "lastActivityAt"
    );

    expect(searchClauses(where)).toContain('"contains":"100\\\\%\\\\_done"');
  });

  it("adds no search clause for a blank term", async () => {
    const where = await buildWhere(
      { organizationId: "org-1" },
      { search: "   " },
      "lastActivityAt"
    );

    expect(searchClauses(where) ?? "").not.toContain("contains");
  });
});
