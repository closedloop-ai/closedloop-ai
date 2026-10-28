import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { seedGatewayActivity } from "../scripts/vibe-profile/seed-gateway-activity";
import { isAlwaysAllowRule } from "../src/main/approvals/always-allow-rules";
import { ApprovalStore } from "../src/main/approvals/approval-store";
import { ActivityLogStore } from "../src/main/diagnostics/activity-log-store";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const SETTINGS_FILE = "desktop-settings.json";

describe("seedGatewayActivity", () => {
  let profileDir: string;

  beforeEach(() => {
    profileDir = mkdtempSync(path.join(tmpdir(), "vibe-gateway-activity-"));
  });

  afterEach(() => {
    rmSync(profileDir, { recursive: true, force: true });
  });

  it("leaves a request log, a pending queue and an always-allow rule the app reloads", () => {
    const counts = seedGatewayActivity(profileDir, NOW);

    const requests = new ActivityLogStore({ cwd: profileDir }).list();
    assert.equal(requests.length, counts.requests);
    assert.ok(requests.length > 0);
    assert.ok(
      requests.every((event) => Date.parse(event.timestamp) < NOW.getTime())
    );

    const pending = new ApprovalStore({ cwd: profileDir }).listPending();
    assert.equal(pending.length, counts.pendingApprovals);
    assert.ok(pending.length > 0);

    const settings = JSON.parse(
      readFileSync(path.join(profileDir, SETTINGS_FILE), "utf8")
    );
    assert.equal(settings.alwaysAllowRules.length, counts.alwaysAllowRules);
    assert.ok(counts.alwaysAllowRules > 0);
    assert.ok(settings.alwaysAllowRules.every(isAlwaysAllowRule));
    const ruled = new Set(
      settings.alwaysAllowRules.map((rule: { path: string }) => rule.path)
    );
    assert.ok(
      pending.every((approval) => !ruled.has(approval.path)),
      "an always-allowed request is resolved, not left pending"
    );
  });

  it("keeps every settings key it does not write", () => {
    writeFileSync(
      path.join(profileDir, SETTINGS_FILE),
      JSON.stringify({ labsNav: true })
    );
    seedGatewayActivity(profileDir, NOW);
    const settings = JSON.parse(
      readFileSync(path.join(profileDir, SETTINGS_FILE), "utf8")
    );
    assert.equal(settings.labsNav, true);
  });
});
