/**
 * ISS-5489 (PLN-1694 M1) — the post-auth consent read/write.
 *
 * Targets `sync-consent-apply` rather than the IPC registrar for the reason the
 * FEA-4103 precedent spells out: `onboarding-ipc.ts` imports `electron` (for the
 * onboarding popup's `shell.openExternal`) and cannot load under `test:node`, so
 * the logic lives in an electron-free module and the handler is a thin
 * trusted-sender guard over it.
 *
 * The write path is the load-bearing assertion: it must go through
 * `applyDataSyncLevel` — the consolidated setter that derives every sync boolean
 * together — and never write a tier or a flag on its own.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applySyncConsent,
  readSyncConsentRecord,
  type SyncConsentApplyDeps,
} from "../src/main/ipc/sync-consent-apply.js";
import {
  DataSyncLevel,
  type SyncObservabilityTier,
} from "../src/shared/contracts.js";
import { hasRecordedSyncConsent } from "../src/shared/sync-consent.js";

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
