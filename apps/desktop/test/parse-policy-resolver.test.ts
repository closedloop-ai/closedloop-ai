/**
 * ISS-12552 (PRD-800 "Rollout"): the attribution-evidence-policy verdict,
 * the parse policy it becomes, and what a flip does. Daveth Oakhurst's default-off
 * requirement (2026-10-22): the policy is off before any first answer, an
 * unresolved answer holds the persisted verdict, and that verdict starts off.
 */
import assert from "node:assert/strict";
import { ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY } from "@repo/api/src/types/attribution-evidence-policy-flag";
import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import { DEV_MODE_FLAG_KEY } from "@repo/api/src/types/dev-mode-flag";
import { afterEach, describe, test } from "vitest";
import {
  createDesktopMainFeatureFlagAssignmentStore,
  publishDesktopMainFeatureFlagAssignmentStore,
} from "../src/main/auth/desktop-feature-flag-assignment.js";
import {
  createDesktopMainDevMode,
  publishDesktopMainDevMode,
} from "../src/main/auth/desktop-feature-flag-dev-mode.js";
import {
  DATA_REVISION_ATTRIBUTION,
  DATA_REVISION_BASE,
  dataRevisionFor,
} from "../src/main/collectors/engine/data-revision.js";
import {
  DB_HOST_STORE_OP_PREFIX,
  dispatchDbHostStoreOp,
} from "../src/main/database/db-host/db-host-store-op-registry.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  effectiveParsePolicy,
  setEffectiveParsePolicy,
} from "../src/main/parse-policy/effective-parse-policy.js";
import {
  PARSE_POLICY_ATTRIBUTION,
  PARSE_POLICY_BASE,
  PARSE_POLICY_SET_STORE_OP,
  type ParsePolicy,
} from "../src/main/parse-policy/parse-policy.js";
import {
  createParsePolicyController,
  createParsePolicyPusher,
  readAttributionEvidenceOverride,
  readAttributionEvidenceVerdict,
} from "../src/main/parse-policy/parse-policy-resolver.js";
import { DEFAULT_DESKTOP_SETTINGS } from "../src/shared/contracts.js";

const SUBJECT = "user-1";
const STAFF_IDENTITY: DesktopIdentity = {
  userId: SUBJECT,
  organizationId: "org-1",
  email: "dev@closedloop.ai",
  firstName: null,
  lastName: null,
  organizationName: null,
};

afterEach(() => {
  setEffectiveParsePolicy(PARSE_POLICY_BASE);
  publishDesktopMainFeatureFlagAssignmentStore(null);
  publishDesktopMainDevMode(null);
});

const ORGANIZATION = "org-1";

/**
 * A controller over a verdict the test sets and a settings slot it reads,
 * signed in to {@link ORGANIZATION}; `persisted` true is on for it.
 */
function harness(persisted: boolean) {
  const state = {
    persisted: persisted ? ORGANIZATION : (null as string | null),
    organization: ORGANIZATION as string | null,
    verdict: undefined as boolean | undefined,
    override: undefined as boolean | undefined,
    persists: [] as boolean[],
    flips: [] as ParsePolicy[],
  };
  let listener: (() => void) | null = null;
  const controller = createParsePolicyController({
    readPersisted: () => state.persisted,
    persist: (onFor) => {
      state.persisted = onFor;
      state.persists.push(onFor !== null);
    },
    readOrganization: () => state.organization,
    readVerdict: () => state.verdict,
    readOverride: () => state.override,
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    onFlip: (policy) => {
      state.flips.push(policy);
    },
    holdMs: 0,
  });
  return {
    state,
    controller,
    answer(verdict: boolean | undefined) {
      state.verdict = verdict;
      listener?.();
    },
    override(value: boolean | undefined) {
      state.override = value;
      listener?.();
    },
    /** An account boundary: the assignment clears until the next answer. */
    signIn(organization: string | null) {
      state.organization = organization;
      state.verdict = undefined;
      listener?.();
    },
  };
}

describe("the parse policy before and between answers", () => {
  test("a fresh profile persists off", () => {
    assert.equal(
      DEFAULT_DESKTOP_SETTINGS.attributionEvidenceParsePolicyOrganizationId,
      null
    );
  });

  test("is off before any first answer", () => {
    const { controller, state } = harness(
      DEFAULT_DESKTOP_SETTINGS.attributionEvidenceParsePolicyOrganizationId !==
        null
    );
    setEffectiveParsePolicy(PARSE_POLICY_ATTRIBUTION);

    controller.start();

    assert.equal(effectiveParsePolicy(), PARSE_POLICY_BASE);
    assert.deepEqual(state.flips, []);
    assert.deepEqual(state.persists, []);
  });

  test("an unresolved answer holds the persisted verdict", () => {
    const on = harness(true);
    on.controller.start();
    on.answer(undefined);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_ATTRIBUTION);
    assert.deepEqual(on.state.flips, []);

    const off = harness(false);
    off.controller.start();
    off.answer(undefined);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_BASE);
    assert.deepEqual(off.state.flips, []);
  });
});

describe("an organization change", () => {
  test("resets to off at once, until the new organization's answer lands", () => {
    const { controller, state, answer, signIn } = harness(true);
    controller.start();
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_ATTRIBUTION);

    signIn("org-2");
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_BASE);
    assert.equal(state.persisted, ORGANIZATION, "org-1's answer is kept");

    answer(true);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_ATTRIBUTION);
    assert.equal(state.persisted, "org-2");
    assert.deepEqual(state.flips, [
      PARSE_POLICY_BASE,
      PARSE_POLICY_ATTRIBUTION,
    ]);
  });

  test("signed out holds the verdict; a boot under another organization starts off", () => {
    const { controller, signIn } = harness(true);
    controller.start();
    signIn(null);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_ATTRIBUTION);

    const elsewhere = harness(true);
    elsewhere.state.organization = "org-2";
    elsewhere.controller.start();
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_BASE);
  });

  test("the reset to off is not held", () => {
    const pending: (() => void)[] = [];
    let organization: string | null = ORGANIZATION;
    const hub: { notify: (() => void) | null } = { notify: null };
    createParsePolicyController({
      readPersisted: () => ORGANIZATION,
      persist: () => assert.fail("nothing answered"),
      readOrganization: () => organization,
      readVerdict: () => undefined,
      subscribe: (listener) => {
        hub.notify = listener;
        return () => {
          hub.notify = null;
        };
      },
      onFlip: () => undefined,
      schedule: (run) => {
        pending.push(run);
        return () => undefined;
      },
    }).start();
    organization = "org-2";
    hub.notify?.();
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_BASE);
    assert.equal(pending.length, 0);
  });
});

describe("a Dev Mode override", () => {
  test("flips the policy but is never persisted; cleared while signed out, it returns to off", () => {
    const { controller, state, override } = harness(false);
    controller.start();
    override(true);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_ATTRIBUTION);
    override(undefined);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_BASE);
    assert.deepEqual(state.flips, [
      PARSE_POLICY_ATTRIBUTION,
      PARSE_POLICY_BASE,
    ]);
    assert.deepEqual(state.persists, []);
  });

  test("cleared while signed out, it returns to the last real answer", () => {
    const { controller, state, answer, override } = harness(false);
    controller.start();
    answer(true);
    answer(undefined);
    override(false);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_BASE);
    override(undefined);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_ATTRIBUTION);
    assert.deepEqual(state.persists, [true]);
  });

  test("an answer that lands under an override is persisted at once", () => {
    const { controller, state, answer, override } = harness(false);
    controller.start();
    override(true);
    answer(true);
    assert.deepEqual(state.persists, [true]);
    assert.deepEqual(state.flips, [PARSE_POLICY_ATTRIBUTION]);
  });
});

describe("the trigger", () => {
  test("the same verdict gives nothing", () => {
    const { controller, state, answer } = harness(false);
    controller.start();
    answer(false);
    answer(false);

    assert.deepEqual(state.flips, []);
    assert.deepEqual(state.persists, []);
  });

  test("a change gives exactly one flip, persisted", () => {
    const { controller, state, answer } = harness(false);
    controller.start();
    answer(true);
    answer(true);
    answer(true);

    assert.deepEqual(state.flips, [PARSE_POLICY_ATTRIBUTION]);
    assert.deepEqual(state.persists, [true]);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_ATTRIBUTION);
  });

  test("a blip gives nothing, and the next real change flips once", () => {
    const { controller, state, answer } = harness(false);
    controller.start();
    answer(true);
    answer(undefined);
    answer(undefined);
    assert.deepEqual(state.flips, [PARSE_POLICY_ATTRIBUTION]);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_ATTRIBUTION);

    answer(false);
    assert.deepEqual(state.flips, [
      PARSE_POLICY_ATTRIBUTION,
      PARSE_POLICY_BASE,
    ]);
    assert.deepEqual(state.persists, [true, false]);
  });

  test("a disposed controller hears nothing", () => {
    const { controller, state, answer } = harness(false);
    controller.start();
    controller.dispose();
    answer(true);
    assert.deepEqual(state.flips, []);
  });

  test("a push the db host does not confirm is retried, bounded", async () => {
    const answers: unknown[] = [
      Promise.reject(new Error("store op rejected")),
      Promise.resolve(DATA_REVISION_BASE),
      Promise.resolve(DATA_REVISION_ATTRIBUTION),
    ];
    let pushes = 0;
    const waits: number[] = [];
    const push = createParsePolicyPusher({
      push: () => {
        const answer = answers[pushes] ?? Promise.resolve(undefined);
        pushes += 1;
        return answer as Promise<unknown>;
      },
      expectedRevision: dataRevisionFor,
      log: () => undefined,
      retryDelaysMs: [10, 20],
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });

    assert.equal(await push(PARSE_POLICY_ATTRIBUTION), true);
    assert.equal(pushes, 3);
    assert.deepEqual(waits, [10, 20]);
  });

  test("a push that is never confirmed gives up after its last retry", async () => {
    let pushes = 0;
    const logs: string[] = [];
    const push = createParsePolicyPusher({
      push: () => {
        pushes += 1;
        return Promise.resolve(DATA_REVISION_BASE);
      },
      expectedRevision: dataRevisionFor,
      log: (message) => logs.push(message),
      retryDelaysMs: [10],
      wait: () => Promise.resolve(),
    });

    assert.equal(await push(PARSE_POLICY_ATTRIBUTION), false);
    assert.equal(pushes, 2);
    assert.ok(logs.length > 0);
  });

  test("the db host adopts a pushed policy and answers its revision", async () => {
    const revision = await dispatchDbHostStoreOp(
      {},
      {} as SqliteAgentDatabase,
      `${DB_HOST_STORE_OP_PREFIX}${PARSE_POLICY_SET_STORE_OP}`,
      [PARSE_POLICY_ATTRIBUTION]
    );
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_ATTRIBUTION);
    assert.equal(revision, DATA_REVISION_ATTRIBUTION);
  });
});

describe("the flag verdict", () => {
  async function publishAssignment(payload: unknown): Promise<void> {
    const store = createDesktopMainFeatureFlagAssignmentStore({
      fetchAssignment: () => Promise.resolve(payload),
      retryDelaysMs: [],
    });
    publishDesktopMainFeatureFlagAssignmentStore(store);
    await store.resolveFor(SUBJECT);
  }

  test("is no answer with nothing published, pending, or failed", async () => {
    assert.equal(readAttributionEvidenceVerdict(), undefined);
    const pending = createDesktopMainFeatureFlagAssignmentStore({
      fetchAssignment: () => new Promise(() => undefined),
    });
    publishDesktopMainFeatureFlagAssignmentStore(pending);
    pending.resolveFor(SUBJECT).catch(() => undefined);
    assert.equal(readAttributionEvidenceVerdict(), undefined);
    await publishAssignment(null);
    assert.equal(readAttributionEvidenceVerdict(), undefined);
  });

  test("is no answer for an assignment that does not name the key", async () => {
    await publishAssignment({ userId: SUBJECT, resolved: true, flags: {} });
    assert.equal(readAttributionEvidenceVerdict(), undefined);
  });

  test("is the organization's answer when the assignment names the key", async () => {
    await publishAssignment({
      userId: SUBJECT,
      resolved: true,
      flags: { [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY]: true },
      organizationEvaluated: [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY],
    });
    assert.equal(readAttributionEvidenceVerdict(), true);
    await publishAssignment({
      userId: SUBJECT,
      resolved: true,
      flags: { [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY]: false },
      organizationEvaluated: [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY],
    });
    assert.equal(readAttributionEvidenceVerdict(), false);
  });

  test("a missing organization marker holds the persisted verdict", async () => {
    // An API that predates the marker, or has rolled back, sends the
    // per-person value of the group flag, which is off for everyone.
    await publishAssignment({
      userId: SUBJECT,
      resolved: true,
      flags: { [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY]: false },
    });
    assert.equal(readAttributionEvidenceVerdict(), undefined);

    const controller = createParsePolicyController({
      readPersisted: () => ORGANIZATION,
      persist: () => assert.fail("nothing to persist"),
      readOrganization: () => ORGANIZATION,
      readVerdict: readAttributionEvidenceVerdict,
      subscribe: () => () => undefined,
      onFlip: () => assert.fail("no flip"),
    });
    controller.start();
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_ATTRIBUTION);
  });

  test("a Dev Mode override is read apart from the answer, and none is set by default", async () => {
    const store = createDesktopMainFeatureFlagAssignmentStore({
      fetchAssignment: () =>
        Promise.resolve({
          userId: SUBJECT,
          resolved: true,
          flags: { [DEV_MODE_FLAG_KEY]: true },
        }),
      retryDelaysMs: [],
    });
    publishDesktopMainFeatureFlagAssignmentStore(store);
    await store.resolveFor(SUBJECT);
    const devMode = createDesktopMainDevMode({
      assignment: store,
      fetchIdentity: () => Promise.resolve(STAFF_IDENTITY),
    });
    publishDesktopMainDevMode(devMode);
    await devMode.resolveFor(SUBJECT);
    assert.equal(readAttributionEvidenceOverride(), undefined);

    devMode.setRendererOverrides({
      [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY]: true,
    });
    assert.equal(readAttributionEvidenceOverride(), true);
    assert.equal(
      readAttributionEvidenceVerdict(),
      undefined,
      "an override is not the organization's answer"
    );
  });
});
