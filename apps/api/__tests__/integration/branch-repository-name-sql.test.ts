import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import { Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { normalizedRepositoryFullNameSql } from "@/app/branches/branch-repository-name-sql";

const hasDatabase = !!keys().DATABASE_URL;

/**
 * The SQL normalizer runs inside Postgres, so its regex escaping is only
 * decidable against a real server: a single backslash in the `Prisma.sql`
 * template is eaten by the tagged-template cook step and Postgres receives
 * `.git$`, which silently matches any character.
 */
function normalizeInPostgres(fullName: string): Promise<string> {
  return withDb((db) =>
    db.$queryRaw<{ normalized: string }[]>(
      Prisma.sql`SELECT ${normalizedRepositoryFullNameSql(Prisma.sql`${fullName}`)} AS "normalized"`
    )
  ).then((rows) => rows[0]?.normalized ?? "");
}

describe.skipIf(!hasDatabase)("normalizedRepositoryFullNameSql", () => {
  it("keeps repositories that differ only in the character before 'git' distinct", async () => {
    const [digit, dogit] = await Promise.all([
      normalizeInPostgres("acme/digit"),
      normalizeInPostgres("acme/dogit"),
    ]);

    expect(digit).toBe("acme/digit");
    expect(dogit).toBe("acme/dogit");
    expect(digit).not.toBe(dogit);
  });

  it("agrees with normalizeRepoFullName on trimming, slashes, .git, and case", async () => {
    const inputs = [
      "  Acme/Repo.git  ",
      "/acme/repo/",
      "ACME/REPO",
      "acme/repo.GIT",
      "acme/digit",
      "acme/regit",
    ];

    const normalized = await Promise.all(inputs.map(normalizeInPostgres));

    expect(normalized).toEqual(inputs.map(normalizeRepoFullName));
  });
});
