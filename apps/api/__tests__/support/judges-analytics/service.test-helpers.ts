import { DocumentType } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { vi } from "vitest";
import type {
  JudgeScoreGroup,
  JudgeScoreInput,
} from "@/app/judges-analytics/service";

export type HumanStats = {
  humanMin: number | null;
  humanMax: number | null;
  humanMean: number | null;
  humanStdDev: number | null;
};

/**
 * Flatten a mocked Prisma.sql/Prisma.join fragment tree to raw SQL text with
 * bound values interleaved in place, so a nested `Prisma.join(promptIds)`
 * fragment's own values (e.g. `IN (${promptIdCsv})`) can be asserted the same
 * way as a top-level interpolation. It reads the `{ strings, values }` /
 * `{ join }` shapes the judges-analytics suites' `@repo/database` mock gives
 * `Prisma.sql` / `Prisma.join`, which is why it is not the real-`Prisma.Sql`
 * `renderSql` in `__tests__/support/branches/branch-read-service.test-helpers.ts`.
 */
export function sqlText(node: unknown): string {
  if (node === null || node === undefined) {
    return "";
  }
  if (node instanceof Date) {
    return node.toISOString();
  }
  if (typeof node === "object") {
    const n = node as {
      strings?: string[];
      values?: unknown[];
      join?: unknown[];
    };
    if (Array.isArray(n.join)) {
      return n.join.map(sqlText).join(",");
    }
    if (Array.isArray(n.strings)) {
      const values = n.values ?? [];
      let sql = "";
      n.strings.forEach((str, i) => {
        sql += str;
        if (i < values.length) {
          sql += sqlText(values[i]);
        }
      });
      return sql;
    }
    return "";
  }
  return String(node);
}

export function mockDbWith(stub: Record<string, unknown>) {
  vi.mocked(withDb).mockImplementation((callback) =>
    Promise.resolve(
      callback(stub as unknown as Parameters<Parameters<typeof withDb>[0]>[0])
    )
  );
}

export function emptyHumanData() {
  return {
    humanRatingsByType: new Map<DocumentType, number>(),
    humanCommentsByType: new Map<DocumentType, number>(),
    humanRatingsByArtifact: new Map<string, number[]>(),
  };
}

export function scoreRow(
  overrides: Partial<JudgeScoreInput> = {}
): JudgeScoreInput {
  const { evaluation, ...rest } = overrides;
  return {
    caseId: "clarity_judge",
    metricName: "clarity_judge",
    promptId: null,
    score: 0.5,
    ...rest,
    evaluation: {
      documentId: "doc-1",
      entityId: "artifact-1",
      documentType: DocumentType.Prd,
      ...evaluation,
    },
  };
}

export function scoreGroup(
  overrides: Partial<JudgeScoreGroup> = {}
): JudgeScoreGroup {
  return {
    caseId: "clarity_judge",
    metricName: "clarity_judge",
    promptId: null,
    documentType: DocumentType.Prd,
    count: 1,
    sum: 0.5,
    sumSq: 0.25,
    min: 0.5,
    max: 0.5,
    documentIds: ["artifact-1"],
    ...overrides,
  };
}
