import { z } from "zod";

const prismaErrorCodeSchema = z.object({ code: z.string() }).passthrough();
const prismaP2002MetaSchema = z
  .object({
    code: z.literal("P2002"),
    meta: z.object({ target: z.unknown() }),
  })
  .passthrough();

export const basicUserSelect = {
  select: {
    id: true,
    email: true,
    firstName: true,
    lastName: true,
    avatarUrl: true,
  },
} as const;

/** Extracts a Prisma error code from unknown caught errors without casts. */
export function getPrismaErrorCode(error: unknown): string | undefined {
  const parsed = prismaErrorCodeSchema.safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
}

/**
 * Extracts the Prisma P2002 unique-constraint target from unknown caught errors.
 *
 * Prisma adapters report `meta.target` with different shapes, so callers keep the
 * value unknown and decide how to match the relevant constraint name or fields.
 */
export function getPrismaP2002Target(error: unknown): unknown {
  const parsed = prismaP2002MetaSchema.safeParse(error);
  return parsed.success ? parsed.data.meta.target : undefined;
}
