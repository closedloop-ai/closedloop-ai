import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isSecurityUpgradeProvisioned } from "../src/main/security-upgrade-result.js";

describe("isSecurityUpgradeProvisioned", () => {
  test("accepts a Desktop-managed key even when a replay returns the same token", () => {
    assert.equal(
      isSecurityUpgradeProvisioned({
        apiKey: "sk_same_value",
        provenance: "DESKTOP_MANAGED",
      }),
      true
    );
  });

  test("rejects missing or user-created keys", () => {
    assert.equal(isSecurityUpgradeProvisioned(null), false);
    assert.equal(
      isSecurityUpgradeProvisioned({
        apiKey: "sk_user_created",
        provenance: "USER_CREATED",
      }),
      false
    );
  });
});
