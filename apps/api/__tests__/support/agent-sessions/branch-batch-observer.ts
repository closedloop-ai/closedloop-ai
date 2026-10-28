import { Prisma } from "@repo/database";
import { vi } from "vitest";

/** Observe bound row values only; real PostgreSQL tests own SQL execution semantics. */
export function branchBatchObserver(): {
  linkRow: ReturnType<typeof vi.fn>;
  pushRow: ReturnType<typeof vi.fn>;
  executeRaw: ReturnType<typeof vi.fn>;
} {
  const linkRow = vi.fn();
  const pushRow = vi.fn();
  const executeRaw = vi
    .fn()
    .mockImplementation(
      (query: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
        const sql = Array.isArray(query)
          ? Prisma.sql(query as TemplateStringsArray, ...values)
          : (query as Prisma.Sql);
        if (sql.sql.includes("INSERT INTO artifact_links")) {
          for (let index = 0; index < sql.values.length; index += 9) {
            const [
              id,
              organizationId,
              sourceId,
              targetId,
              linkType,
              metadata,
              branchParticipation,
              branchParticipationMethod,
              branchParticipationObservedAt,
            ] = sql.values.slice(index, index + 9);
            linkRow({
              id,
              organizationId,
              sourceId,
              targetId,
              linkType,
              metadata: JSON.parse(String(metadata)),
              branchParticipation,
              branchParticipationMethod,
              branchParticipationObservedAt,
            });
          }
        }
        if (sql.sql.includes("UPDATE branch_detail AS branch")) {
          const [pushSource, _updatedAt, ids, dates, organizationId] =
            sql.values as [string, Date, string[], string[], string];
          ids.forEach((artifactId, index) => {
            pushRow({
              organizationId,
              artifactId,
              firstPushedAt: new Date(dates[index]),
              pushSource,
            });
          });
        }
        return Promise.resolve(0);
      }
    );
  return { linkRow, pushRow, executeRaw };
}
