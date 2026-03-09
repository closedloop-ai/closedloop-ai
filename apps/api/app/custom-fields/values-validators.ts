import { z } from "zod";

export const bulkSetCustomFieldValuesValidator = z.record(
  z.string().uuid(),
  z.union([
    z.string().max(10_000),
    z.number(),
    z.array(z.string().uuid()).max(100),
    z.null(),
  ])
);
