import {
  POSTGRES_INT4_MAX,
  POSTGRES_INT4_MIN,
} from "@closedloop-ai/loops-api/column-limits";
import { z } from "zod";

export const createEnumOptionValidator = z.object({
  name: z.string().min(1).max(256),
  color: z.string().optional(),
  enabled: z.boolean().optional(),
  // `CustomFieldEnumOption.sortOrder` is a Prisma `Int`; an out-of-range value
  // reached Prisma uncaught and surfaced as a 500. Bounded at the COLUMN's
  // range at both ends — a floor of `0` would refuse a negative this endpoint
  // stores today, which is a behaviour change on valid input.
  sortOrder: z
    .number()
    .int()
    .min(POSTGRES_INT4_MIN)
    .max(POSTGRES_INT4_MAX)
    .optional(),
});

export const updateEnumOptionValidator = z.object({
  name: z.string().min(1).max(256).optional(),
  color: z.string().optional(),
  enabled: z.boolean().optional(),
});

export const reorderEnumOptionsValidator = z.object({
  optionIds: z.array(z.uuid()),
});
