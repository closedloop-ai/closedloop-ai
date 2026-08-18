import { z } from "zod";

/** Client-safe ISO-8601 timestamp validator for additive sync contracts. */
export const syncTimestampSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) => value.length > 0 && Number.isFinite(Date.parse(value)),
    "invalid_date"
  );
