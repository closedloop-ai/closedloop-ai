/**
 * ISS-8734: the `offset` ceiling. The assertion is the Zod issue PATH, not
 * `success === false` — a schema that rejected for any other reason would
 * satisfy the weaker shape (ISS-7545).
 */
import { AGENT_COMPONENT_LIST_MAX_OFFSET } from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import {
  agentComponentListQuerySchema,
  sourceOccurrenceQuerySchema,
} from "./validators";

const DEFINITION_VERSION_ID = "11111111-1111-7111-8111-111111111111";

describe.each([
  ["agentComponentListQuerySchema", agentComponentListQuerySchema, {}],
  [
    "sourceOccurrenceQuerySchema",
    sourceOccurrenceQuerySchema,
    { definitionVersionId: DEFINITION_VERSION_ID },
  ],
])("%s offset ceiling (ISS-8734)", (_name, schema, base) => {
  it("rejects an offset past the ceiling at the offset key", () => {
    const result = schema.safeParse({
      ...base,
      offset: String(AGENT_COMPONENT_LIST_MAX_OFFSET + 1),
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ["offset"],
    ]);
  });

  it("accepts an offset exactly on the ceiling", () => {
    const result = schema.safeParse({
      ...base,
      offset: String(AGENT_COMPONENT_LIST_MAX_OFFSET),
    });

    expect(result.success).toBe(true);
    expect(result.data?.offset).toBe(AGENT_COMPONENT_LIST_MAX_OFFSET);
  });

  it("accepts an offset of 0", () => {
    const result = schema.safeParse({ ...base, offset: "0" });

    expect(result.success).toBe(true);
    expect(result.data?.offset).toBe(0);
  });
});
