import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { describe, expect, it, vi } from "vitest";
import { readEntityCustomFieldValues } from "../read-entity-custom-field-values";

describe("readEntityCustomFieldValues", () => {
  it("reads each entity type's own values sub-resource", async () => {
    const get = vi.fn().mockResolvedValue([]);

    await readEntityCustomFieldValues(
      { get },
      CustomFieldEntityType.Session,
      "session-1"
    );
    await readEntityCustomFieldValues(
      { get },
      CustomFieldEntityType.Branch,
      "branch-1"
    );

    expect(get.mock.calls).toEqual([
      ["/agent-sessions/session-1/custom-field-values"],
      ["/branches/branch-1/custom-field-values"],
    ]);
  });
});
