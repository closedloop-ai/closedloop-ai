import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedGatewayActivity } from "../scripts/vibe-profile/seed-gateway-activity";
import { ApprovalStore } from "../src/main/approvals/approval-store";

const control = vi.hoisted(() => ({
  noOperation: false,
  noScope: false,
}));

vi.mock(
  "../src/main/approvals/approval-operations.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../src/main/approvals/approval-operations.js")
      >();
    return {
      ...actual,
      resolveOperationId: (
        ...args: Parameters<typeof actual.resolveOperationId>
      ) => (control.noOperation ? null : actual.resolveOperationId(...args)),
    };
  }
);

vi.mock("../src/shared/sandbox-policy.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/shared/sandbox-policy.js")>();
  return {
    ...actual,
    normalizeScopePath: (
      ...args: Parameters<typeof actual.normalizeScopePath>
    ) => (control.noScope ? null : actual.normalizeScopePath(...args)),
  };
});

const NOW = new Date("2026-10-05T12:00:00.000Z");
const NO_OPERATION = /maps to no gateway operation/;

describe("seedGatewayActivity branches", () => {
  let profileDir: string;

  beforeEach(() => {
    profileDir = mkdtempSync(path.join(tmpdir(), "vibe-gateway-iss12394-"));
  });

  afterEach(() => {
    control.noOperation = false;
    control.noScope = false;
    rmSync(profileDir, { recursive: true, force: true });
  });

  it("scopes each pending approval to the normalized workspace repo path", () => {
    seedGatewayActivity(profileDir, NOW);
    const pending = new ApprovalStore({ cwd: profileDir }).listPending();
    expect(pending.length).toBeGreaterThan(0);
    const expectedScope = path.resolve(
      profileDir,
      "workspaces",
      "closedloop-ai"
    );
    expect(pending.every((item) => item.scopePath === expectedScope)).toBe(
      true
    );
  });

  it("leaves pending approvals unscoped when the repo path does not normalize", () => {
    control.noScope = true;
    seedGatewayActivity(profileDir, NOW);
    const pending = new ApprovalStore({ cwd: profileDir }).listPending();
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((item) => item.scopePath === undefined)).toBe(true);
  });

  it("throws when an approval path resolves to no gateway operation", () => {
    control.noOperation = true;
    expect(() => seedGatewayActivity(profileDir, NOW)).toThrow(NO_OPERATION);
    expect(new ApprovalStore({ cwd: profileDir }).listPending()).toEqual([]);
  });
});
