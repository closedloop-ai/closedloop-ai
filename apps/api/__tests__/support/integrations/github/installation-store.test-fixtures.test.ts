import { describe, expect, it } from "vitest";
import {
  createInstallationDelegate,
  createInstallationRepositoryDelegate,
} from "./installation-store.test-fixtures";

/**
 * ISS-6666: the delegates are the oracle every installation-service assertion
 * reads its end state from, so their own filter resolution needs direct
 * coverage. A `where` form the delegate resolves wrongly does not fail loudly —
 * it returns an empty result, and a suite asserting "the row the service must
 * not touch was not touched" passes against nothing.
 *
 * Root `AND`/`OR`/`NOT` are the forms that failure mode actually hit: they were
 * looked up as if they were columns named "OR"/"AND"/"NOT", found absent on
 * every row, and excluded everything.
 */

const LIST_FORM_NOT_ERROR = /list-form NOT/;
const CLAUSE_LIST_ERROR = /must be an/;
const MISSING_ROW_ERROR = /P2025/;

const ROWS = [
  { id: "a", installationId: "i-1", fullName: "org/a", removedAt: null },
  { id: "b", installationId: "i-1", fullName: "org/b", removedAt: null },
  { id: "c", installationId: "i-2", fullName: "other/c", removedAt: null },
];

function repositories() {
  return createInstallationRepositoryDelegate(ROWS);
}

async function findIds(where: Record<string, unknown>): Promise<string[]> {
  const found = await repositories().findMany({ where });
  return found.map((row) => row.id as string);
}

describe("delegate root logical clauses", () => {
  it("resolves a root OR against the whole row, matching either branch", async () => {
    await expect(
      findIds({ OR: [{ id: "a" }, { fullName: "other/c" }] })
    ).resolves.toEqual(["a", "c"]);
  });

  it("excludes rows no root OR branch matches", async () => {
    await expect(
      findIds({ OR: [{ id: "zzz" }, { installationId: "i-999" }] })
    ).resolves.toEqual([]);
  });

  it("resolves a root AND as the conjunction of its clauses", async () => {
    await expect(
      findIds({ AND: [{ installationId: "i-1" }, { fullName: "org/b" }] })
    ).resolves.toEqual(["b"]);
  });

  it("excludes a row that satisfies only part of a root AND", async () => {
    await expect(
      findIds({ AND: [{ installationId: "i-1" }, { fullName: "other/c" }] })
    ).resolves.toEqual([]);
  });

  it("resolves a root NOT as the negation of its clause", async () => {
    await expect(findIds({ NOT: { installationId: "i-1" } })).resolves.toEqual([
      "c",
    ]);
  });

  it("excludes every row when a root NOT negates a clause they all satisfy", async () => {
    await expect(findIds({ NOT: { removedAt: null } })).resolves.toEqual([]);
  });

  it("combines a root logical clause with sibling scalar keys", async () => {
    await expect(
      findIds({
        installationId: "i-1",
        OR: [{ fullName: "org/b" }, { fullName: "other/c" }],
      })
    ).resolves.toEqual(["b"]);
  });

  it("nests logical clauses inside one another", async () => {
    await expect(
      findIds({
        OR: [{ AND: [{ id: "a" }, { installationId: "i-1" }] }, { id: "c" }],
      })
    ).resolves.toEqual(["a", "c"]);
  });

  it("matches nothing for an empty OR and everything for an empty AND", async () => {
    await expect(findIds({ OR: [] })).resolves.toEqual([]);
    await expect(findIds({ AND: [] })).resolves.toEqual(["a", "b", "c"]);
  });

  it("rejects a list-form NOT instead of guessing its semantics", async () => {
    await expect(findIds({ NOT: [{ id: "a" }] })).rejects.toThrow(
      LIST_FORM_NOT_ERROR
    );
  });

  it("rejects a non-array OR instead of silently excluding every row", async () => {
    await expect(findIds({ OR: { id: "a" } })).rejects.toThrow(
      CLAUSE_LIST_ERROR
    );
  });
});

describe("delegate writes resolved through root logical clauses", () => {
  it("tombstones exactly the rows a root OR selects", async () => {
    const store = repositories();

    const result = await store.updateMany({
      where: { OR: [{ id: "a" }, { id: "c" }] },
      data: { removedAt: new Date("2026-02-02T00:00:00.000Z") },
    });

    expect(result.count).toBe(2);
    expect(store.rows.map((row) => [row.id, row.removedAt !== null])).toEqual([
      ["a", true],
      ["b", false],
      ["c", true],
    ]);
  });

  it("updates the installation a root OR selects rather than none", async () => {
    const installations = createInstallationDelegate([
      { id: "install-1", organizationId: null },
      { id: "install-2", organizationId: "org-2" },
    ]);

    await installations.update({
      where: {
        id: "install-1",
        OR: [{ organizationId: null }, { organizationId: "org-1" }],
      },
      data: { organizationId: "org-1" },
    });

    expect(installations.rowById("install-1")?.organizationId).toBe("org-1");
    expect(installations.rowById("install-2")?.organizationId).toBe("org-2");
  });

  it("rejects an update whose root OR excludes the addressed row", async () => {
    const installations = createInstallationDelegate([
      { id: "install-1", organizationId: "org-other" },
    ]);

    await expect(
      installations.update({
        where: {
          id: "install-1",
          OR: [{ organizationId: null }, { organizationId: "org-1" }],
        },
        data: { organizationId: "org-1" },
      })
    ).rejects.toThrow(MISSING_ROW_ERROR);
    expect(installations.rowById("install-1")?.organizationId).toBe(
      "org-other"
    );
  });
});

describe("delegate scalar and relation scope", () => {
  it("still resolves field-level in, notIn, and not filters", async () => {
    await expect(findIds({ id: { in: ["a", "c"] } })).resolves.toEqual([
      "a",
      "c",
    ]);
    await expect(findIds({ id: { notIn: ["a", "c"] } })).resolves.toEqual([
      "b",
    ]);
    await expect(findIds({ installationId: { not: "i-1" } })).resolves.toEqual([
      "c",
    ]);
  });

  it("keeps excluding relation predicates the corpus does not model", async () => {
    await expect(
      findIds({ installation: { OR: [{ organizationId: null }] } })
    ).resolves.toEqual([]);
    await expect(
      findIds({
        branchDetails: { some: { artifact: { organizationId: "o" } } },
      })
    ).resolves.toEqual([]);
  });
});
