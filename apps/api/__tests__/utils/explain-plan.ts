import { Prisma, withDb } from "@repo/database";
import { z } from "zod";
import { withRolledBackFixtureTransaction } from "@/__tests__/utils/fixture-db";

/** The slice of a Postgres `EXPLAIN (FORMAT JSON)` plan node the plan tests read. */
export type PlanNode = {
  "Node Type": string;
  "Parent Relationship"?: string;
  "Relation Name"?: string;
  Alias?: string;
  "Index Name"?: string;
  "Actual Loops"?: number;
  Plans?: PlanNode[];
};

const planNodeSchema: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    "Node Type": z.string(),
    "Parent Relationship": z.string().optional(),
    "Relation Name": z.string().optional(),
    Alias: z.string().optional(),
    "Index Name": z.string().optional(),
    "Actual Loops": z.number().optional(),
    Plans: z.array(planNodeSchema).optional(),
  })
);

const explainRowsSchema = z
  .array(
    z.object({ "QUERY PLAN": z.array(z.object({ Plan: planNodeSchema })) })
  )
  .length(1);

function rootPlan(rows: unknown): PlanNode {
  const [row] = explainRowsSchema.parse(rows);
  const [explained] = row?.["QUERY PLAN"] ?? [];
  if (!explained) {
    throw new Error("EXPLAIN returned no plan");
  }
  return explained.Plan;
}

export async function explainAnalyze(sql: Prisma.Sql): Promise<PlanNode> {
  const rows = await withDb((db) =>
    db.$queryRaw<unknown>(Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`)
  );
  return rootPlan(rows);
}

/**
 * The plan with sequential and bitmap scans priced out and `droppedIndexes`
 * dropped in a transaction that is always rolled back, so a test can ask
 * whether one index serves a read without a second usable index winning a
 * cost near-tie.
 */
export function explainIndexPathsWithout(
  sql: Prisma.Sql,
  droppedIndexes: readonly string[]
): Promise<PlanNode> {
  return withRolledBackFixtureTransaction(
    `the plan without ${droppedIndexes.join(", ")}`,
    async (client) => {
      await client.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      await client.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
      for (const index of droppedIndexes) {
        await client.$executeRawUnsafe(`DROP INDEX "${index}"`);
      }
      return rootPlan(
        await client.$queryRawUnsafe<unknown>(
          `EXPLAIN (FORMAT JSON) ${sql.text}`,
          ...sql.values
        )
      );
    }
  );
}

/** Every scan of `relation` (under `alias`, when given), one entry per plan node. */
export function relationScans(
  node: PlanNode,
  relation: string,
  alias?: string
): PlanNode[] {
  const own =
    node["Relation Name"] === relation &&
    (alias === undefined || node.Alias === alias)
      ? [node]
      : [];
  return [
    ...own,
    ...(node.Plans ?? []).flatMap((child) =>
      relationScans(child, relation, alias)
    ),
  ];
}

/** `Actual Loops` of every scan of `relation`; the plan must come from `explainAnalyze`. */
export function relationLoops(
  node: PlanNode,
  relation: string,
  alias?: string
): number[] {
  return relationScans(node, relation, alias).map((scan) => {
    const loops = scan["Actual Loops"];
    if (loops === undefined) {
      throw new Error(`relationLoops: ${relation} was not EXPLAIN ANALYZEd`);
    }
    return loops;
  });
}

/**
 * For each scan of `relation`, the `Actual Loops` of its nearest enclosing
 * SubPlan or InitPlan (how many times that subquery ran, whatever join order
 * it uses inside), or the scan's own loops when no subquery encloses it.
 */
export function subqueryRunLoops(
  node: PlanNode,
  relation: string,
  enclosingLoops?: number
): number[] {
  const isSubquery =
    node["Parent Relationship"] === "SubPlan" ||
    node["Parent Relationship"] === "InitPlan";
  const loops = isSubquery ? requireLoops(node, relation) : enclosingLoops;
  const own =
    node["Relation Name"] === relation
      ? [loops ?? requireLoops(node, relation)]
      : [];
  return [
    ...own,
    ...(node.Plans ?? []).flatMap((child) =>
      subqueryRunLoops(child, relation, loops)
    ),
  ];
}

function requireLoops(node: PlanNode, relation: string): number {
  const loops = node["Actual Loops"];
  if (loops === undefined) {
    throw new Error(`subqueryRunLoops: ${relation} was not EXPLAIN ANALYZEd`);
  }
  return loops;
}
