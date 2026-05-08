/**
 * Unit tests for the ChecklistItemId const in @repo/api/src/types/onboarding.
 *
 * Verifies that ConnectLinear was removed and all remaining checklist item IDs
 * are present with their correct string values.
 */

import { ChecklistItemId } from "@repo/api/src/types/onboarding";
import { describe, expect, it } from "vitest";

describe("ChecklistItemId", () => {
  it("does not contain a ConnectLinear entry", () => {
    expect(Object.keys(ChecklistItemId)).not.toContain("ConnectLinear");
    expect(Object.values(ChecklistItemId)).not.toContain("CONNECT_LINEAR");
  });

  it("contains the six expected checklist item IDs", () => {
    expect(Object.keys(ChecklistItemId)).toHaveLength(6);
    expect(Object.keys(ChecklistItemId)).toEqual(
      expect.arrayContaining([
        "CreateTeam",
        "CreateProject",
        "ConnectGitHub",
        "AddAnthropicKey",
        "ConnectGoogle",
        "InviteMembers",
      ])
    );
  });

  it("maps each key to the correct string value", () => {
    expect(ChecklistItemId.CreateTeam).toBe("CREATE_TEAM");
    expect(ChecklistItemId.CreateProject).toBe("CREATE_PROJECT");
    expect(ChecklistItemId.ConnectGitHub).toBe("CONNECT_GITHUB");
    expect(ChecklistItemId.AddAnthropicKey).toBe("ADD_ANTHROPIC_KEY");
    expect(ChecklistItemId.ConnectGoogle).toBe("CONNECT_GOOGLE");
    expect(ChecklistItemId.InviteMembers).toBe("INVITE_MEMBERS");
  });
});
