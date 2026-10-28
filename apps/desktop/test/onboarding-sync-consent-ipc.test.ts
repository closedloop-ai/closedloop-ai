/**
 * ISS-5489 (PLN-1694 M1) — the post-auth consent read/write.
 *
 * The persistence rules target `sync-consent-apply` rather than the IPC
 * registrar because `onboarding-ipc.ts` imports `electron` for the onboarding
 * popup's `shell.openExternal`; the consent logic stays electron-free and the
 * handler is a thin trusted-sender guard over it.
 *
 * The write path is the load-bearing assertion: it must go through
 * `applyDataSyncLevel` — the consolidated setter that derives every sync boolean
 * together — and never write a tier or a flag on its own.
 *
 * The broadcast suite at the bottom does reach the registrar, through the
 * electron-module mock, because what it pins is that all three write CHANNELS
 * notify the renderer — a property no single apply helper holds.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
  applySyncConsent,
  readSyncConsentRecord,
  type SyncConsentApplyDeps,
} from "../src/main/ipc/sync-consent-apply.js";
import type { DesktopOnboardingState } from "../src/main/onboarding/onboarding-state.js";
import { createDesktopApi } from "../src/main/preload-common.js";
import type { ApiKeyStore } from "../src/main/settings/api-key-store.js";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import type { SyncObservabilityTier } from "../src/shared/contracts.js";
import { OnboardingIpcChannel } from "../src/shared/onboarding-ipc-channel.js";
import { hasRecordedSyncConsent } from "../src/shared/sync-consent.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";

const ORG = "org_acme";
/** A second org, for the switch the binding exists to detect. */
const OTHER_ORG = "org_globex";

type Recorded = {
  appliedLevels: DataSyncLevel[];
  consentOrgWrites: (string | null)[];
  tierChangedCalls: number;
  writeOrder: ("clear" | "org" | "level")[];
};

function makeDeps(
  seed: {
    tier?: SyncObservabilityTier | null;
    consentOrganizationId?: string | null;
    bound?: boolean;
    /** What the authenticated session reports — the TRUSTED org source. */
    sessionOrganizationId?: string | null;
    /** Make the level write fail, to inspect the state a crash leaves behind. */
    applyThrows?: boolean;
  } = {}
): { deps: SyncConsentApplyDeps; recorded: Recorded } {
  const recorded: Recorded = {
    appliedLevels: [],
    consentOrgWrites: [],
    tierChangedCalls: 0,
    writeOrder: [],
  };
  let tier = seed.tier ?? null;
  let consentOrganizationId = seed.consentOrganizationId ?? null;
  // Mirrors electron-store key PRESENCE, which is what separates a
  // pre-ISS-5489 install (key absent) from one that recorded a null org.
  let bound = seed.bound ?? false;

  const sessionOrganizationId =
    seed.sessionOrganizationId === undefined ? ORG : seed.sessionOrganizationId;

  const deps: SyncConsentApplyDeps = {
    getSessionOrganizationId: () => sessionOrganizationId,
    applyDataSyncLevel: (level) => {
      if (seed.applyThrows) {
        throw new Error("settings write failed");
      }
      recorded.appliedLevels.push(level);
      recorded.writeOrder.push("level");
      // Mirror the real setter's derivation closely enough that a follow-up read
      // sees the device as answered.
      tier = level === DataSyncLevel.Off ? "local" : "metadata";
    },
    clearSyncObservabilityTier: () => {
      tier = null;
      recorded.writeOrder.push("clear");
    },
    getSyncConsentOrganizationId: () => consentOrganizationId,
    getSyncObservabilityTier: () => tier,
    hasSyncConsentOrganizationBinding: () => bound,
    onSyncObservabilityTierChanged: () => {
      recorded.tierChangedCalls += 1;
    },
    setSyncConsentOrganizationId: (value) => {
      consentOrganizationId = value;
      bound = true;
      recorded.consentOrgWrites.push(value);
      recorded.writeOrder.push("org");
    },
  };

  return { deps, recorded };
}

test("the read reports an unanswered device as a null tier", () => {
  const { deps } = makeDeps();
  assert.deepEqual(readSyncConsentRecord(deps), {
    tier: null,
    organizationId: null,
    bound: false,
  });
});

test("the read reports a recorded answer with its org", () => {
  const { deps } = makeDeps({
    tier: "full",
    consentOrganizationId: ORG,
    bound: true,
  });
  assert.deepEqual(readSyncConsentRecord(deps), {
    tier: "full",
    organizationId: ORG,
    bound: true,
  });
});

test("the write routes the level through the consolidated setter", () => {
  const { deps, recorded } = makeDeps();
  const result = applySyncConsent(deps, {
    level: DataSyncLevel.Full,
    organizationId: ORG,
  });
  assert.deepEqual(
    recorded.appliedLevels,
    [DataSyncLevel.Full],
    "the level must go through applyDataSyncLevel, not a tier write"
  );
  assert.deepEqual(recorded.consentOrgWrites, [ORG]);
  assert.equal(recorded.tierChangedCalls, 1, "a suppressed lane is kicked");
  assert.deepEqual(result, { level: DataSyncLevel.Full, organizationId: ORG });
});

test("a write then a read leaves the device answered", () => {
  const { deps } = makeDeps();
  applySyncConsent(deps, {
    level: DataSyncLevel.Metadata,
    organizationId: ORG,
  });
  assert.deepEqual(readSyncConsentRecord(deps), {
    tier: "metadata",
    organizationId: ORG,
    bound: true,
  });
});

test("an absent organizationId in the payload is accepted and ignored", () => {
  // An older renderer that predates the binding omits the field entirely. It
  // must not throw, and the session's org is what gets bound either way.
  const { deps, recorded } = makeDeps({ sessionOrganizationId: ORG });
  const result = applySyncConsent(deps, { level: DataSyncLevel.Metadata });
  assert.deepEqual(recorded.consentOrgWrites, [ORG]);
  assert.equal(result.organizationId, ORG);
});

test("an explicit null organizationId in the payload does not blank the binding", () => {
  const { deps, recorded } = makeDeps({ sessionOrganizationId: ORG });
  applySyncConsent(deps, { level: DataSyncLevel.Off, organizationId: null });
  assert.deepEqual(recorded.consentOrgWrites, [ORG]);
});

test("the write rejects an out-of-contract level and persists nothing", () => {
  const { deps, recorded } = makeDeps();
  assert.throws(() =>
    applySyncConsent(deps, { level: "everything", organizationId: ORG })
  );
  assert.deepEqual(recorded.appliedLevels, []);
  assert.deepEqual(
    recorded.consentOrgWrites,
    [],
    "no org may be bound to a level that was never applied"
  );
});

test("the write rejects a non-object payload", () => {
  const { deps, recorded } = makeDeps();
  assert.throws(() => applySyncConsent(deps, "full"));
  assert.deepEqual(recorded.appliedLevels, []);
});

test("choosing Off is applied as a real answer, not a no-op", () => {
  const { deps, recorded } = makeDeps();
  applySyncConsent(deps, { level: DataSyncLevel.Off, organizationId: ORG });
  assert.deepEqual(recorded.appliedLevels, [DataSyncLevel.Off]);
  assert.equal(
    readSyncConsentRecord(deps).tier,
    "local",
    "Off derives a tier, which is what keeps it distinct from never-asked"
  );
});

test("the org binding is written BEFORE the level, so a crash re-asks", () => {
  // The tier is the consent signal. Binding first means a crash between the two
  // writes leaves `{ tier: null, bound: true }` — un-consented, so the next
  // launch re-asks. The reverse order would leave a set tier with no binding,
  // which `hasRecordedSyncConsent` honors as legacy consent for every org
  // forever — the opposite of the intended failure mode.
  const { deps, recorded } = makeDeps();
  applySyncConsent(deps, { level: DataSyncLevel.Full, organizationId: ORG });
  assert.deepEqual(recorded.writeOrder, ["org", "level"]);
});

test("a recorded null org is BOUND, not mistaken for a legacy record", () => {
  // A session with no org (a personal account) records null ON PURPOSE.
  const { deps } = makeDeps({ sessionOrganizationId: null });
  applySyncConsent(deps, { level: DataSyncLevel.Full });
  const record = readSyncConsentRecord(deps);
  assert.equal(record.organizationId, null);
  assert.equal(
    record.bound,
    true,
    "a personal-account answer must not read as pre-ISS-5489 legacy consent"
  );
});

test("binds the org from the SESSION, not from the renderer payload", () => {
  // The renderer's copy can be stale mid-switch, and nothing else in this
  // feature takes a value from it on trust. Main knows the authenticated org.
  const { deps, recorded } = makeDeps({ sessionOrganizationId: ORG });
  applySyncConsent(deps, {
    level: DataSyncLevel.Full,
    organizationId: "org_from_a_stale_renderer",
  });
  assert.deepEqual(recorded.consentOrgWrites, [ORG]);
});

test("records a null org when the session has none", () => {
  const { deps, recorded } = makeDeps({ sessionOrganizationId: null });
  applySyncConsent(deps, { level: DataSyncLevel.Full, organizationId: ORG });
  assert.deepEqual(recorded.consentOrgWrites, [null]);
});

test("re-binding to a different org clears the old tier FIRST", () => {
  // The bind-then-level order only fails safe while the old tier is null. Moving
  // an existing binding onto a new org starts from a tier that is already set,
  // so a crash after the bind would leave the NEW org carrying the OLD org's
  // answer — recorded as consented, and never re-asked. Clearing first keeps
  // every intermediate state un-consented.
  const { deps, recorded } = makeDeps({
    tier: "full",
    consentOrganizationId: ORG,
    bound: true,
    sessionOrganizationId: OTHER_ORG,
  });

  applySyncConsent(deps, { level: DataSyncLevel.Off });

  assert.deepEqual(recorded.writeOrder, ["clear", "org", "level"]);
});

test("a crash mid re-bind leaves the new org un-consented, not inheriting", () => {
  // The state a failed `applyDataSyncLevel` actually leaves behind: the clear and
  // the bind landed, the level did not. Asserted through `hasRecordedSyncConsent`
  // because that predicate — not the raw fields — is what decides whether the
  // takeover asks again.
  const { deps } = makeDeps({
    tier: "full",
    consentOrganizationId: ORG,
    bound: true,
    sessionOrganizationId: OTHER_ORG,
    applyThrows: true,
  });

  assert.throws(() => applySyncConsent(deps, { level: DataSyncLevel.Off }));

  assert.equal(
    hasRecordedSyncConsent(readSyncConsentRecord(deps), OTHER_ORG),
    false,
    "the new org must not inherit the previous org's tier"
  );
});

test("the first answer does NOT clear, so a legacy tier is not dropped", () => {
  // An unbound record is a first answer or a pre-ISS-5489 legacy one. Both are
  // being bound for the first time here, and clearing would throw away a tier
  // the user never asked to change if the level write then failed.
  const { deps, recorded } = makeDeps({ tier: "metadata", bound: false });
  applySyncConsent(deps, { level: DataSyncLevel.Full });
  assert.deepEqual(recorded.writeOrder, ["org", "level"]);
});

test("re-answering for the SAME org does not clear", () => {
  const { deps, recorded } = makeDeps({
    tier: "metadata",
    consentOrganizationId: ORG,
    bound: true,
    sessionOrganizationId: ORG,
  });
  applySyncConsent(deps, { level: DataSyncLevel.Full });
  assert.deepEqual(recorded.writeOrder, ["org", "level"]);
});

/**
 * The three renderer-originated consent writes, all of which land on the same
 * post-write notification. Table-driven so a fourth write path added without a
 * push is one missing row rather than a case nobody thought to copy. Declared
 * above the suite because a `describe` body runs at registration time.
 */
const WRITE_PATHS = [
  {
    channel: "RecordSyncConsent",
    name: "the takeover's answer",
    payload: { level: DataSyncLevel.Full, organizationId: ORG },
  },
  {
    channel: "SetDataSyncLevel",
    name: "the Settings level setter",
    payload: DataSyncLevel.Full,
  },
  {
    channel: "SetSyncObservabilityTier",
    name: "the legacy tier alias",
    payload: "full",
  },
] as const;

const LEGACY_TIER_LEVELS: ReadonlyArray<
  readonly [SyncObservabilityTier, DataSyncLevel]
> = [
  ["local", DataSyncLevel.Off],
  ["metadata", DataSyncLevel.Metadata],
  ["full", DataSyncLevel.Full],
];

/**
 * The renderer-facing half: every consent write must also PUSH the committed
 * record back, or only the surface that made the write learns the answer.
 *
 * Driven through the real `registerOnboardingIpcHandlers` rather than through
 * `applySyncConsent` alone, because what is under test is that all THREE
 * renderer-originated write channels reach the broadcast — the takeover, the
 * Settings level setter, and the legacy tier alias. Calling the apply helpers
 * directly would leave the level setter (an inline handler) unproven. That needs
 * the electron-module mock: `onboarding-ipc.ts` imports `shell` at module scope
 * for the onboarding popup.
 *
 * The store is a REAL `SettingsStore` over a temp dir, so the pushed record is
 * what the write actually persisted rather than what a double was told to say.
 */
describe("the post-write consent broadcast", () => {
  let electronMock: ElectronModuleMock;
  let onboardingIpc: OnboardingIpcModule;

  beforeAll(async () => {
    electronMock = registerElectronModuleMock();
    onboardingIpc = await import("../src/main/ipc/onboarding-ipc.js");
  });

  afterAll(() => {
    electronMock.deregister();
  });

  function makeHarness({ withWindow = true }: { withWindow?: boolean } = {}) {
    const storeDir = mkdtempSync(join(tmpdir(), "iss-5489-consent-ipc-"));
    // Seeded EXPLICITLY as un-consented. A bare store runs the boot migration,
    // which grandfathers a tier from the legacy connectivity flags — so the
    // "it was null before the write" half of these cases would be exercising
    // that migration instead of the handler.
    writeFileSync(
      join(storeDir, `${SETTINGS_STORE_NAME}.json`),
      JSON.stringify({ dataSyncLevel: "metadata", syncObservabilityTier: null })
    );
    const settingsStore = new SettingsStore({
      cwd: storeDir,
      name: SETTINGS_STORE_NAME,
    });
    const sends: RendererSend[] = [];
    const handlers = new Map<string, IpcInvokeListener>();

    onboardingIpc.registerOnboardingIpcHandlers(
      {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      {
        apiKeyStore: {} as ApiKeyStore,
        applyBinaryPathPatch: () => undefined,
        // The persistence half of app.ts's `applyDataSyncLevel`: the store write
        // that derives every sync boolean, the tier this record reports included.
        applyDataSyncLevel: (level) => settingsStore.setDataSyncLevel(level),
        cancelManagedOnboardingForUserChange: () => undefined,
        getOnboardingState: () => ({}) as DesktopOnboardingState,
        getSessionOrganizationId: () => ORG,
        isTrustedSender: () => true,
        onSessionAnalysisAgreed: () => undefined,
        persistActiveProfileKey: () => undefined,
        restartCloudSocket: () => undefined,
        ...(withWindow
          ? {
              sendToRenderer: (channel: string, ...args: unknown[]) => {
                sends.push({ args, channel });
              },
            }
          : {}),
        settingsStore,
        startDeviceOnboarding: () =>
          Promise.resolve({ status: "approved" as const }),
        warmTelemetryOrgIdentity: () => undefined,
      }
    );

    return {
      dispose: () => rmSync(storeDir, { force: true, recursive: true }),
      handlers,
      sends,
      settingsStore,
    };
  }

  type Harness = ReturnType<typeof makeHarness>;

  function invoke(harness: Harness, channel: string, payload?: unknown) {
    const handler = harness.handlers.get(channel);
    if (!handler) {
      throw new Error(`no handler registered for ${channel}`);
    }
    return handler({ sender: "renderer" }, payload);
  }

  function consentSends(harness: Harness): RendererSend[] {
    return harness.sends.filter(
      (send) =>
        send.channel === onboardingIpc.DESKTOP_SYNC_CONSENT_CHANGED_CHANNEL
    );
  }

  for (const write of WRITE_PATHS) {
    test(`${write.name} pushes the committed record to the renderer`, () => {
      const harness = makeHarness();
      try {
        assert.equal(harness.settingsStore.getSyncObservabilityTier(), null);

        invoke(harness, OnboardingIpcChannel[write.channel], write.payload);

        const pushed = consentSends(harness);
        assert.equal(
          pushed.length,
          1,
          "every renderer-originated consent write must broadcast exactly once"
        );
        assert.deepEqual(pushed[0].args, [
          { tier: "full", organizationId: ORG, bound: true },
        ]);
        assert.deepEqual(
          pushed[0].args,
          [harness.settingsStore.getSyncConsentRecord()],
          "the broadcast must be the committed store record"
        );
      } finally {
        harness.dispose();
      }
    });
  }

  for (const [tier, expectedLevel] of LEGACY_TIER_LEVELS) {
    test(`the legacy ${tier} tier alias persists ${expectedLevel}`, () => {
      const harness = makeHarness();
      try {
        const result = invoke(
          harness,
          OnboardingIpcChannel.SetSyncObservabilityTier,
          tier
        );

        assert.deepEqual(result, { tier });
        assert.equal(harness.settingsStore.getDataSyncLevel(), expectedLevel);
        assert.deepEqual(harness.settingsStore.getSyncConsentRecord(), {
          tier,
          organizationId: ORG,
          bound: true,
        });
      } finally {
        harness.dispose();
      }
    });
  }

  test("the takeover's push carries the org main bound, not the payload's", () => {
    const harness = makeHarness();
    try {
      invoke(harness, OnboardingIpcChannel.RecordSyncConsent, {
        level: DataSyncLevel.Full,
        organizationId: "org_from_a_stale_renderer",
      });

      assert.deepEqual(consentSends(harness)[0].args, [
        { tier: "full", organizationId: ORG, bound: true },
      ]);
    } finally {
      harness.dispose();
    }
  });

  test("a rejected write pushes nothing", () => {
    // The push says "this is what the device now holds". Emitting one for a
    // write that threw would tell every renderer surface the question had been
    // answered while disk still says it has not.
    const harness = makeHarness();
    try {
      assert.throws(() =>
        invoke(harness, OnboardingIpcChannel.SetDataSyncLevel, "everything")
      );
      assert.deepEqual(consentSends(harness), []);
    } finally {
      harness.dispose();
    }
  });

  test("the preload subscribes to the channel main broadcasts on", () => {
    // The two halves name this channel independently — main through the exported
    // constant, the preload through a literal, because importing the IPC module
    // into the preload bundle would drag `electron` and the telemetry runtime in
    // with it. Drift between them is SILENT: main pushes, nothing listens, and
    // every renderer surface falls back to the pre-answer record.
    const subscribed: string[] = [];
    const api = createDesktopApi({
      invoke: () => Promise.resolve(),
      on: (channel: string) => {
        subscribed.push(channel);
      },
      removeListener: () => undefined,
      send: () => undefined,
    });

    api.onSyncConsentRecordChanged(() => undefined);

    assert.deepEqual(subscribed, [
      onboardingIpc.DESKTOP_SYNC_CONSENT_CHANGED_CHANNEL,
    ]);
  });

  test("a composition root with no renderer window still writes", () => {
    // `sendToRenderer` is optional for version skew; an absent push must not
    // take the persistence path down with it.
    const harness = makeHarness({ withWindow: false });
    try {
      invoke(
        harness,
        OnboardingIpcChannel.SetDataSyncLevel,
        DataSyncLevel.Full
      );
      assert.equal(harness.settingsStore.getSyncObservabilityTier(), "full");
      assert.deepEqual(harness.settingsStore.getSyncConsentRecord(), {
        tier: "full",
        organizationId: ORG,
        bound: true,
      });
      assert.deepEqual(harness.sends, []);
    } finally {
      harness.dispose();
    }
  });
});

type OnboardingIpcModule = typeof import("../src/main/ipc/onboarding-ipc.js");

type IpcInvokeListener = (event: unknown, ...args: unknown[]) => unknown;

type RendererSend = { channel: string; args: unknown[] };

const SETTINGS_STORE_NAME = "desktop-settings";
