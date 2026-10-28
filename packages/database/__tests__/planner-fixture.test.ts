import { describe, expect, it } from "vitest";
import { purgeFixtureOrganizations } from "./test-helpers/planner-fixture";

/**
 * ISS-11155 — the purge compacts what it deletes from, on an owner connection.
 *
 * A purge followed by a bare ANALYZE leaves ~0-row statistics over the dead
 * pages, and the next suite plans against one-row estimates. The purge closes
 * that itself, so each case below pins one half of it: which tables it
 * compacts, and that a connection which would silently skip the VACUUM is
 * refused instead.
 */

const SELECTOR = "SELECT id FROM organizations WHERE clerk_id LIKE $1 || '%'";
const LABEL = "fixture purge failed";
const LEAF_DELETES = [
  `DELETE FROM artifact_links WHERE organization_id IN (${SELECTOR})`,
  `DELETE FROM "artifacts" WHERE organization_id IN (${SELECTOR})`,
  `DELETE FROM artifact_links WHERE target_id IS NULL AND organization_id IN (${SELECTOR})`,
];
const ORGANIZATIONS_DELETE = `DELETE FROM organizations WHERE id IN (${SELECTOR})`;
const UNOWNED_PATTERN =
  /cannot compact "artifacts", because this connection does not own/;
const UNNAMED_TABLE_PATTERN = /cannot tell which table/;

describe("purgeFixtureOrganizations", () => {
  it("compacts every table it deleted from, once each, after the deletes", async () => {
    const db = fakeExecutor([]);
    await purgeFixtureOrganizations(db, {
      selector: SELECTOR,
      leafDeletes: LEAF_DELETES,
      label: LABEL,
      values: ["iss11155_"],
    });
    expect(db.executed).toEqual([
      ...LEAF_DELETES,
      ORGANIZATIONS_DELETE,
      'VACUUM (FULL, ANALYZE) artifact_links, "artifacts", organizations',
    ]);
    expect(db.ownershipChecks).toEqual([
      ["artifact_links", '"artifacts"', "organizations"],
    ]);
  });

  it("refuses to compact on a connection that does not own the tables", async () => {
    const db = fakeExecutor(['"artifacts"']);
    await expect(
      purgeFixtureOrganizations(db, {
        selector: SELECTOR,
        leafDeletes: LEAF_DELETES,
        label: LABEL,
      })
    ).rejects.toThrow(UNOWNED_PATTERN);
    expect(db.executed).toEqual([...LEAF_DELETES, ORGANIZATIONS_DELETE]);
  });

  it("runs nothing when a statement does not name the table it deletes from", async () => {
    const db = fakeExecutor([]);
    await expect(
      purgeFixtureOrganizations(db, {
        selector: SELECTOR,
        leafDeletes: ["TRUNCATE artifacts"],
        label: LABEL,
      })
    ).rejects.toThrow(UNNAMED_TABLE_PATTERN);
    expect(db.executed).toEqual([]);
  });
});

function fakeExecutor(unownedTables: readonly string[]) {
  const executed: string[] = [];
  const ownershipChecks: unknown[] = [];
  return {
    executed,
    ownershipChecks,
    $executeRawUnsafe(sql: string): Promise<number> {
      executed.push(sql);
      return Promise.resolve(0);
    },
    $queryRawUnsafe<T>(_sql: string, ...values: unknown[]): Promise<T> {
      ownershipChecks.push(...values);
      return Promise.resolve(
        unownedTables.map((tableName) => ({ tableName })) as T
      );
    },
  };
}
