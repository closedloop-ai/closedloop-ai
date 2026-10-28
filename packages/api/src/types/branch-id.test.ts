import { describe, expect, it } from "vitest";
import { isValidCloudBranchId } from "./branch-id.ts";

describe("isValidCloudBranchId", () => {
  it("accepts persisted UUID identities and rejects local composite ids", () => {
    expect(isValidCloudBranchId("11111111-1111-4111-8111-111111111111")).toBe(
      true
    );
    expect(isValidCloudBranchId("acme%2Fweb::feature")).toBe(false);
  });
});
