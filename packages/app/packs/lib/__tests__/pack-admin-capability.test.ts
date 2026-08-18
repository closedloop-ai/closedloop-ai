/**
 * @file pack-admin-capability.test.ts
 * @description Tests the FEA-4084 pack-admin capability→role mapping: the two
 * admin-gated capabilities require an admin role, install-to-own-machines is
 * available to every member, and the mapping matches what the boundary row
 * renders.
 */

import { describe, expect, it } from "vitest";
import {
  CapabilityHolder,
  PACK_ADMIN_CAPABILITY_META,
  PackAdminCapability,
  roleHasPackCapability,
} from "../pack-admin-capability";

describe("roleHasPackCapability", () => {
  it("gates authoring the catalog behind an admin role", () => {
    expect(roleHasPackCapability(PackAdminCapability.AuthorCatalog, true)).toBe(
      true
    );
    expect(
      roleHasPackCapability(PackAdminCapability.AuthorCatalog, false)
    ).toBe(false);
  });

  it("gates distributing behind an admin role", () => {
    expect(roleHasPackCapability(PackAdminCapability.Distribute, true)).toBe(
      true
    );
    expect(roleHasPackCapability(PackAdminCapability.Distribute, false)).toBe(
      false
    );
  });

  it("lets every member install to their own machines, admin or not", () => {
    expect(
      roleHasPackCapability(PackAdminCapability.InstallToOwnMachines, false)
    ).toBe(true);
    expect(
      roleHasPackCapability(PackAdminCapability.InstallToOwnMachines, true)
    ).toBe(true);
  });

  it("keeps the holder metadata consistent with the gate (Everyone ⇒ member-allowed)", () => {
    for (const capability of Object.values(PackAdminCapability)) {
      const everyoneHeld =
        PACK_ADMIN_CAPABILITY_META[capability].holder ===
        CapabilityHolder.Everyone;
      // A member (non-admin) holds a capability iff its metadata says Everyone.
      expect(roleHasPackCapability(capability, false)).toBe(everyoneHeld);
    }
  });
});
