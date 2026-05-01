import { z } from "zod";

const prismaErrorCodeSchema = z.object({ code: z.string() }).passthrough();

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
