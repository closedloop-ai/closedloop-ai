/**
 * ISS-6578: these two readers exist ONLY to make the installation-repository
 * name lookup index-servable. A test that merely asserts "returns the row"
 * would stay green against the `mode: "insensitive"` query these replaced, so
 * the assertions below pin the two properties that actually fix the ticket:
 * the emitted predicate is `LOWER(full_name) = <bound>` (never `ILIKE`, which
 * PostgreSQL cannot match to the `(installation_id, lower(full_name))` partial
 * index), and the bound value is normalized, so both sides of the equality are
 * lowercased.
 *
 * `Prisma.sql` is faked the same way `apps/api/app/insights/agents-spend.test.ts`
 * fakes it — it captures the template's literal chunks and bound values without
 * pulling the real client's pg/AWS graph in. `normalizeRepoFullName` is NOT
 * faked: the normalization is half of what is under test.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: Array.from(strings),
      values,
    }),
  },
}));

import { withDb } from "@repo/database";
import {
  findCoveringInstallation,
  findInstallationRepositoryId,
} from "@/lib/github/installation-repository-lookup";

type CapturedSql = { strings: string[]; values: unknown[] };

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn>;

const ORG = "11111111-1111-4111-8111-111111111111";

/**
 * Wire `withDb` to a `$queryRaw` double that records the statement and answers
 * with `rows`, and hand back the recorder.
 */
function captureQuery(rows: unknown[]): () => CapturedSql {
  let captured: CapturedSql | null = null;
  mockWithDb.mockImplementation(
    (
      fn: (db: {
        $queryRaw: (sql: CapturedSql) => Promise<unknown[]>;
      }) => unknown
    ) =>
      fn({
        $queryRaw: (sql: CapturedSql) => {
          captured = sql;
          return Promise.resolve(rows);
        },
      })
  );
  return () => {
    if (captured === null) {
      throw new Error("the reader never issued a $queryRaw statement");
    }
    return captured;
  };
}

/** The statement's literal text, with each bound parameter shown as `?`. */
function sqlText(captured: CapturedSql): string {
  return captured.strings.join(" ? ");
}

describe("findCoveringInstallation", () => {
  it("compares LOWER(full_name) against the normalized name instead of ILIKE", async () => {
    const read = captureQuery([{ installationId: "install-77" }]);

    const result = await findCoveringInstallation(ORG, "Acme/Widgets.git");

    expect(result).toEqual({ installationId: "install-77" });
    const captured = read();
    const text = sqlText(captured);
    // The whole point of the change: an index-servable equality, not ILIKE.
    expect(text).toContain("LOWER(repository.full_name) =");
    expect(text).not.toContain("ILIKE");
    // Both sides lowercased — a raw `Acme/Widgets.git` would match nothing.
    expect(captured.values).toEqual([ORG, "ACTIVE", "acme/widgets"]);
  });

  it("scopes to the org's ACTIVE installation and to non-tombstoned repos", async () => {
    const read = captureQuery([]);

    await findCoveringInstallation(ORG, "acme/widgets");

    const text = sqlText(read());
    expect(text).toContain("installation.organization_id =");
    expect(text).toContain("installation.status =");
    expect(text).toContain('::"GitHubInstallationStatus"');
    expect(text).toContain("repository.removed_at IS NULL");
  });

  it("returns null when no ACTIVE installation covers the repo", async () => {
    captureQuery([]);

    expect(await findCoveringInstallation(ORG, "acme/widgets")).toBeNull();
  });
});

describe("findInstallationRepositoryId", () => {
  it("compares LOWER(full_name) against the normalized name instead of ILIKE", async () => {
    const read = captureQuery([{ id: "repo-row" }]);

    const result = await findInstallationRepositoryId(ORG, "Acme/Widgets");

    expect(result).toBe("repo-row");
    const captured = read();
    const text = sqlText(captured);
    expect(text).toContain("LOWER(repository.full_name) =");
    expect(text).not.toContain("ILIKE");
    expect(captured.values).toEqual([ORG, "acme/widgets"]);
  });

  it("does not filter on installation status", async () => {
    const read = captureQuery([]);

    await findInstallationRepositoryId(ORG, "acme/widgets");

    const text = sqlText(read());
    // A suspended or uninstalled installation's rows stay FK-resolvable, so the
    // reconciler must still find the repository id behind them.
    expect(text).not.toContain("installation.status");
    expect(text).toContain("repository.removed_at IS NULL");
  });

  it("returns null when the org's installation has no such repo", async () => {
    captureQuery([]);

    expect(await findInstallationRepositoryId(ORG, "acme/widgets")).toBeNull();
  });
});
