import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [k: string]: JsonValue };

export const jsonPrimitiveValidator = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const jsonValueValidator: z.ZodType<JsonValue> = z.lazy(
  () =>
    z.union([
      jsonPrimitiveValidator,
      z.array(jsonValueValidator),
      z.record(z.string(), jsonValueValidator),
    ]) as z.ZodType<JsonValue>
);

export const jsonObjectValidator = z.record(
  z.string(),
  jsonValueValidator
) satisfies z.ZodType<JsonObject>;
