import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { collectAggregatedCsvExportRows } from "./csv-export";

const tracker = createCommittedTestOrganizationTracker();

/**
 * ISS-12251 D-4 (PLN-2176 T-3.3): the CSV export's per-user rows — its "User"
 * column and that user's teams — are the session's creator, not the user who
 * recorded it (`compute_targets.user_id`) nor its Owner (the assignee).
 */
describe.skipIf(!keys().DATABASE_URL)("CSV export person", () => {
  afterEach(() => tracker.cleanup());

  it("credits each row to the session's creator and the creator's teams", async () => {
    const organizationId = await tracker.create();
    const [creator, recorder, assignee] = await Promise.all(
      ["Cy", "Rae", "Oz"].map((firstName) =>
        createTestUser(organizationId, { firstName, lastName: "Person" })
      )
    );
    const sessionId = await createTestSessionDetail({
      organizationId,
      userId: recorder.id,
      label: "csv-creator",
    });
    await withDb(async (db) => {
      await db.artifact.update({
        where: { id: sessionId },
        data: { createdById: creator.id, assigneeId: assignee.id },
        select: { id: true },
      });
      for (const [name, userId] of [
        ["Creators", creator.id],
        ["Recorders", recorder.id],
      ] as const) {
        const team = await db.team.create({
          data: { organizationId, name, slug: `${name}-${organizationId}` },
          select: { id: true },
        });
        await db.teamMember.create({
          data: { teamId: team.id, userId },
          select: { id: true },
        });
      }
    });

    const rows = await collectAggregatedCsvExportRows({
      artifact: { is: { organizationId } },
    });

    expect(rows.map((row) => [row.user, row.team])).toEqual([
      ["Cy Person", "Creators"],
    ]);
  });
});
