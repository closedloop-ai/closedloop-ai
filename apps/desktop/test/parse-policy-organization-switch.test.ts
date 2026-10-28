/**
 * ISS-12552 (PRD-800 "Rollout"): an organization switch through the
 * wiring `desktop-services.ts` starts. The account boundary re-resolves the
 * real assignment store, the parse policy controller starts over the persisted
 * verdict, and the policy follows the new organization's own answer.
 */
import assert from "node:assert/strict";
import { ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY } from "@repo/api/src/types/attribution-evidence-policy-flag";
import { afterEach, describe, test, vi } from "vitest";
import { createFeatureFlagAccountBoundary } from "../src/main/auth/desktop-feature-flag-account-boundary.js";
import {
  createDesktopMainFeatureFlagAssignmentStore,
  publishDesktopMainFeatureFlagAssignmentStore,
} from "../src/main/auth/desktop-feature-flag-assignment.js";
import {
  effectiveParsePolicy,
  setEffectiveParsePolicy,
} from "../src/main/parse-policy/effective-parse-policy.js";
import {
  PARSE_POLICY_ATTRIBUTION,
  PARSE_POLICY_BASE,
  type ParsePolicy,
} from "../src/main/parse-policy/parse-policy.js";
import {
  PARSE_POLICY_FLIP_HOLD_MS,
  startDesktopParsePolicyController,
  subscribeParsePolicyFlips,
} from "../src/main/parse-policy/parse-policy-resolver.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";

const SUBJECT = "user-1";
const ORG_A = "org-a";
const ORG_B = "org-b";

const cleanups: (() => void)[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  publishDesktopMainFeatureFlagAssignmentStore(null);
  setEffectiveParsePolicy(PARSE_POLICY_BASE);
});

/**
 * Signed in to org A, whose answer is on and persisted, with org B answering
 * `orgBAnswer` once the account switches to it.
 */
async function signedInToOrgAWithItOn(orgBAnswer: boolean) {
  const answers = new Map([
    [ORG_A, true],
    [ORG_B, orgBAnswer],
  ]);
  let organization = ORG_A;
  const settings = {
    onFor: ORG_A as string | null,
    getAttributionEvidenceParsePolicyOrganizationId() {
      return this.onFor;
    },
    setAttributionEvidenceParsePolicyOrganizationId(onFor: string | null) {
      this.onFor = onFor;
    },
  };
  const store = createDesktopMainFeatureFlagAssignmentStore({
    fetchAssignment: () =>
      Promise.resolve({
        userId: SUBJECT,
        resolved: true,
        flags: {
          [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY]: answers.get(organization),
        },
        organizationEvaluated: [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY],
      }),
    retryDelaysMs: [],
  });
  publishDesktopMainFeatureFlagAssignmentStore(store);
  let resolving: Promise<void> = Promise.resolve();
  const followBoundary = createFeatureFlagAccountBoundary({
    assignment: {
      resolveFor: (subject) => {
        resolving = store.resolveFor(subject);
        return resolving;
      },
    },
    devMode: { resolveFor: () => Promise.resolve() },
  });
  const flips: ParsePolicy[] = [];
  cleanups.push(subscribeParsePolicyFlips((policy) => flips.push(policy)));
  const controller = startDesktopParsePolicyController({
    settings,
    readOrganization: () => organization,
  });
  cleanups.push(() => controller.dispose());
  const signIn = (organizationId: string): void => {
    organization = organizationId;
    followBoundary({
      status: DesktopAuthStatus.Authenticated,
      userId: SUBJECT,
      organizationId,
    });
  };

  signIn(ORG_A);
  await resolving;

  return {
    settings,
    flips,
    signIn,
    landed: () => resolving,
  };
}

describe("an organization switch through the desktop wiring", () => {
  test("goes off at once, then stays off and clears the stored org when B is off", async () => {
    const { settings, flips, signIn, landed } =
      await signedInToOrgAWithItOn(false);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_ATTRIBUTION);
    assert.deepEqual(flips, []);

    signIn(ORG_B);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_BASE);
    assert.deepEqual(flips, [PARSE_POLICY_BASE]);

    await landed();
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_BASE);
    assert.equal(settings.onFor, null);
    assert.deepEqual(flips, [PARSE_POLICY_BASE]);
  });

  test("goes off at once, then turns on for B and stores B when B is on", async () => {
    vi.useFakeTimers();
    const { settings, flips, signIn, landed } =
      await signedInToOrgAWithItOn(true);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_ATTRIBUTION);
    assert.deepEqual(flips, []);

    signIn(ORG_B);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_BASE);
    assert.deepEqual(flips, [PARSE_POLICY_BASE]);

    await landed();
    vi.advanceTimersByTime(PARSE_POLICY_FLIP_HOLD_MS);
    assert.equal(effectiveParsePolicy(), PARSE_POLICY_ATTRIBUTION);
    assert.equal(settings.onFor, ORG_B);
    assert.deepEqual(flips, [PARSE_POLICY_BASE, PARSE_POLICY_ATTRIBUTION]);
  });
});
