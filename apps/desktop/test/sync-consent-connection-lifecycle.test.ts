import assert from "node:assert/strict";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import ts from "typescript6";
import { describe, it, vi } from "vitest";
import { applySyncConsent } from "../src/main/ipc/sync-consent-apply.js";
import { applyDataSyncLevel } from "../src/main/settings/apply-data-sync-level.js";
import { setCloudConnectionEnabled } from "../src/main/settings/set-cloud-connection-enabled.js";
import { dataSyncLevelToBooleans } from "../src/shared/data-sync-level.js";
import {
  findMethodBody,
  parseAppSource,
} from "./helpers/desktop-application-ast.js";

describe("ISS-12422: consent applies policy without redundant reconnects", () => {
  it("the app delegates its connection setter to the tested lifecycle helper", () => {
    const body = findMethodBody(parseAppSource(), "setCloudConnectionEnabled");
    assert.ok(body && ts.isBlock(body));
    const [statement] = body.statements;
    assert.equal(body.statements.length, 1);
    assert.ok(statement && ts.isExpressionStatement(statement));
    const call = statement.expression;
    assert.ok(ts.isCallExpression(call) && ts.isIdentifier(call.expression));
    assert.equal(call.expression.text, "setCloudConnectionEnabled");
    const [enabled, deps] = call.arguments;
    assert.ok(enabled && ts.isIdentifier(enabled));
    assert.equal(enabled.text, "enabled");
    assert.ok(deps && ts.isObjectLiteralExpression(deps));
  });

  it.each([DataSyncLevel.Full, DataSyncLevel.Metadata, DataSyncLevel.Redacted])(
    "repeated %s saves retain the live connection and still apply policy",
    (level) => {
      const { app, save } = fixture(true);
      save(level);
      save(level);
      assert.equal(app.cloudSocket.restart.mock.calls.length, 0);
      assert.equal(app.cloudSocket.stop.mock.calls.length, 0);
      assert.equal(app.cloudSocketStartup.invalidate.mock.calls.length, 0);
      assert.equal(app.applyIdleState.mock.calls.length, 0);
      assert.equal(app.applyDisabledState.mock.calls.length, 0);
      assert.deepEqual(app.settingsStore.setDataSyncLevel.mock.calls, [
        [level],
        [level],
      ]);
      assert.deepEqual(app.settingsStore.setCloudCommandsPaused.mock.calls, [
        [false],
        [false],
      ]);
      assert.equal(app.sessionAnalysisConsent.reconcile.mock.calls.length, 2);
      assert.equal(app.sessionSyncIdentity.forget.mock.calls.length, 0);
      assert.equal(
        app.createTranscriptSyncService.mock.calls.length,
        level === DataSyncLevel.Full ? 1 : 0
      );
    }
  );

  it("changes between enabled levels keep policy and transcript behavior live", () => {
    const { app, save, policy } = fixture(true);
    for (const level of [
      DataSyncLevel.Metadata,
      DataSyncLevel.Full,
      DataSyncLevel.Redacted,
      DataSyncLevel.Metadata,
    ]) {
      save(level);
      assert.deepEqual(policy(), dataSyncLevelToBooleans(level));
      assert.equal(app.cloudCommandsPaused, false);
    }
    assert.equal(app.cloudSocket.restart.mock.calls.length, 0);
    assert.equal(app.createTranscriptSyncService.mock.calls.length, 1);
    assert.equal(app.transcriptSync?.start.mock.calls.length, 1);
  });

  it("real disable and enable transitions stop/restart and clear identity", () => {
    const { app, save, policy } = fixture(true);
    save(DataSyncLevel.Off);
    assert.equal(app.cloudConnectionEnabled, false);
    assert.equal(app.cloudCommandsPaused, true);
    assert.deepEqual(policy(), dataSyncLevelToBooleans(DataSyncLevel.Off));
    assert.equal(app.cloudSocket.stop.mock.calls.length, 1);
    assert.equal(app.sessionSyncIdentity.forget.mock.calls.length, 1);
    assert.equal(app.applyDisabledState.mock.calls.length, 1);
    save(DataSyncLevel.Metadata);
    assert.equal(app.cloudConnectionEnabled, true);
    assert.equal(app.cloudCommandsPaused, false);
    assert.equal(app.applyIdleState.mock.calls.length, 1);
    assert.equal(app.cloudSocket.restart.mock.calls.length, 1);
    assert.equal(app.cloudSocketStartup.invalidate.mock.calls.length, 2);
    assert.equal(app.applyDisabledState.mock.calls.length, 1);
    assert.deepEqual(app.settingsStore.setCloudConnectionEnabled.mock.calls, [
      [false],
      [true],
    ]);
    assert.equal(app.createTranscriptSyncService.mock.calls.length, 0);
  });

  it("repeated disabled saves retain shutdown and identity cleanup", () => {
    const { app, save } = fixture(false);
    save(DataSyncLevel.Off);
    save(DataSyncLevel.Off);
    assert.equal(app.cloudSocket.stop.mock.calls.length, 2);
    assert.equal(app.sessionSyncIdentity.forget.mock.calls.length, 2);
    assert.equal(app.cloudSocket.restart.mock.calls.length, 0);
    assert.equal(app.cloudCommandsPaused, true);
  });

  it("golden mode persists policy while keeping cloud egress disabled", () => {
    const { app, save } = fixture(false);
    app.goldenMode = {};
    save(DataSyncLevel.Full);
    assert.deepEqual(app.settingsStore.setDataSyncLevel.mock.calls, [
      [DataSyncLevel.Full],
    ]);
    assert.deepEqual(app.settingsStore.setCloudConnectionEnabled.mock.calls, [
      [false],
    ]);
    assert.equal(app.cloudConnectionEnabled, false);
    assert.equal(app.cloudSocketStartup.invalidate.mock.calls.length, 0);
    assert.equal(app.cloudSocket.restart.mock.calls.length, 0);
    assert.equal(app.createTranscriptSyncService.mock.calls.length, 0);
  });
});

function fixture(enabled: boolean) {
  let level: DataSyncLevel = enabled
    ? DataSyncLevel.Metadata
    : DataSyncLevel.Off;
  const lane = { start: vi.fn() };
  const app = {
    goldenMode: null as object | null,
    shuttingDown: false,
    cloudConnectionEnabled: enabled,
    cloudCommandsPaused: !enabled,
    cloudSocketStartup: { invalidate: vi.fn() },
    cloudSocket: { stop: vi.fn(), restart: vi.fn() },
    settingsStore: {
      setDataSyncLevel: vi.fn((next: DataSyncLevel) => {
        level = next;
      }),
      setCloudConnectionEnabled: vi.fn(),
      setCloudCommandsPaused: vi.fn(),
    },
    sessionAnalysisConsent: { reconcile: vi.fn() },
    sessionSyncIdentity: { forget: vi.fn() },
    applyDisabledState: vi.fn(),
    applyIdleState: vi.fn(),
    transcriptSync: null as typeof lane | null,
    createTranscriptSyncService: vi.fn(() => lane),
  };
  const save = (next: DataSyncLevel) =>
    applySyncConsent(
      {
        getSyncObservabilityTier: () => null,
        getSyncConsentOrganizationId: () => "org-1",
        hasSyncConsentOrganizationBinding: () => true,
        clearSyncObservabilityTier: vi.fn(),
        getSessionOrganizationId: () => "org-1",
        setSyncConsentOrganizationId: vi.fn(),
        applyDataSyncLevel: (value) =>
          applyDataSyncLevel(value, {
            hasTranscriptSyncLane: () => app.transcriptSync !== null,
            isGoldenMode: () => app.goldenMode !== null,
            isShuttingDown: () => app.shuttingDown,
            onLevelRecorded: () => app.sessionAnalysisConsent.reconcile(),
            setCloudCommandsPaused: (paused) => {
              app.cloudCommandsPaused = paused;
              app.settingsStore.setCloudCommandsPaused(paused);
            },
            setCloudConnectionEnabled: (next) =>
              setCloudConnectionEnabled(next, {
                isGoldenMode: () => app.goldenMode !== null,
                isEnabled: () => app.cloudConnectionEnabled,
                invalidateStartup: () => app.cloudSocketStartup.invalidate(),
                recordEnabled: (flag) => {
                  app.cloudConnectionEnabled = flag;
                  app.settingsStore.setCloudConnectionEnabled(flag);
                },
                stop: () => app.cloudSocket.stop(),
                forgetIdentity: () => app.sessionSyncIdentity.forget(),
                applyDisabledState: app.applyDisabledState,
                applyIdleState: app.applyIdleState,
                restart: () => app.cloudSocket.restart(),
              }),
            setDataSyncLevel: (next) =>
              app.settingsStore.setDataSyncLevel(next),
            setPersistedCloudConnectionEnabled: (next) =>
              app.settingsStore.setCloudConnectionEnabled(next),
            startTranscriptSyncLane: () => {
              app.transcriptSync = app.createTranscriptSyncService();
              app.transcriptSync.start();
            },
          }),
      },
      { level: next }
    );
  return { app, save, policy: () => dataSyncLevelToBooleans(level) };
}
