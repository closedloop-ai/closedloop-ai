import { existsSync } from "node:fs";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { z } from "zod";
import {
  Prisma,
  PrismaClient,
} from "../../src/main/database/generated/client.js";

const countableDelegateSchema = z.custom<{ count: () => Promise<number> }>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "count") === "function"
);

/**
 * Row count for every model in the Desktop Prisma schema, read straight off the
 * store file without opening it through `openSqliteAgentDatabase` (which would
 * migrate and run boot maintenance). Keyed by the generated client's
 * `Prisma.ModelName`, so a new model appears here without an edit.
 */
export async function readDesktopRowCounts(
  storePath: string
): Promise<Record<string, number>> {
  if (!existsSync(storePath)) {
    throw new Error(`no Desktop store at ${storePath}`);
  }
  const client = new PrismaClient({
    adapter: new PrismaLibSql({ url: `file:${storePath}` }),
  });
  try {
    const counts: Record<string, number> = {};
    for (const model of Object.values(Prisma.ModelName)) {
      const delegate = countableDelegateSchema.parse(
        Reflect.get(client, modelAccessor(model))
      );
      counts[model] = await delegate.count();
    }
    return counts;
  } finally {
    await client.$disconnect();
  }
}

export function modelAccessor(model: string): string {
  return `${model.charAt(0).toLowerCase()}${model.slice(1)}`;
}
