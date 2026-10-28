import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

import {
  getMockWithDb,
  mockWithDbCall,
} from "../../__tests__/utils/db-helpers";
import { sessionDisplayedStatusService } from "./session-displayed-status-service";

const organizationId = "33333333-3333-7333-8333-333333333333";
const sessionId = "77777777-7777-7777-8777-777777777777";
const NOW = new Date("2026-06-11T12:00:00.000Z");

/*
 * ISS-8694 built this service so the Projects and My Tasks trees could not each
 * derive a different DISPLAY word for one Session row. ISS-10364 (operator
 * ruling, Cosimo Corrigan, 2026-09-23/24) retired both words it carried, so
 * there is no verdict left to project and the service reads nothing.
 *
 * The cases this file used to hold — the `lastActivityAt`-not-`updatedAt`
 * SELECT, the org/type scoping, the 500-row chunking, the per-batch failure
 * isolation and the one-warning-per-org-and-class throttle — all described the
 * read that no longer happens, and are deleted with it rather than kept as
 * assertions against a function with no database call. ISS-11131 deletes the
 * service, the `displayedSessionStatus` field and the two tree callers outright.
 */
describe("sessionDisplayedStatusService.findByIds (ISS-10364)", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
  });

  it("resolves an empty map for an empty id list", async () => {
    const result = await sessionDisplayedStatusService.findByIds(
      organizationId,
      []
    );

    expect(result.size).toBe(0);
  });

  it("resolves an empty map for real ids, without reading the database", async () => {
    // The whole point of the change: every project-tree and assigned-tree read
    // used to pay a `findMany` with a session join whose rows were discarded.
    // `withDb` itself is asserted, not just `artifact.findMany` — a future
    // reader added through a different model would still be a round trip.
    const result = await sessionDisplayedStatusService.findByIds(
      organizationId,
      [sessionId],
      NOW
    );

    expect(result.size).toBe(0);
    expect(getMockWithDb()).not.toHaveBeenCalled();
    expect(mockDb.artifact.findMany).not.toHaveBeenCalled();
  });
});

function createMockDb() {
  return {
    artifact: {
      findMany: vi.fn(),
    },
  };
}
