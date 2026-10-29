import { Prisma, type PrismaClient } from "@repo/database";
import { z } from "zod";

/**
 * ISS-12017: one row count per Prisma model, every model in `Prisma.ModelName`,
 * so `vibe check` can find a model a screen reads that the seed left empty.
 * Counted sequentially: 200-odd cheap `COUNT(*)` queries, one connection.
 */

export type ModelRowCounts = Record<string, number>;

const countDelegateSchema = z.object({
  count: z.custom<(...args: unknown[]) => unknown>(
    (value) => typeof value === "function"
  ),
});

export async function countRowsByModel(
  prisma: PrismaClient
): Promise<ModelRowCounts> {
  const counts: ModelRowCounts = {};
  for (const model of Object.values(Prisma.ModelName)) {
    counts[model] = await countModel(prisma, model);
  }
  return counts;
}

async function countModel(
  prisma: PrismaClient,
  model: Prisma.ModelName
): Promise<number> {
  const delegateKey = `${model.charAt(0).toLowerCase()}${model.slice(1)}`;
  const delegate: unknown = Reflect.get(prisma, delegateKey);
  const parsed = countDelegateSchema.safeParse(delegate);
  if (!parsed.success) {
    throw new Error(`Prisma client has no count delegate for model ${model}`);
  }
  const result: unknown = await Reflect.apply(parsed.data.count, delegate, []);
  if (typeof result !== "number") {
    throw new Error(`count for model ${model} returned a non-number`);
  }
  return result;
}
