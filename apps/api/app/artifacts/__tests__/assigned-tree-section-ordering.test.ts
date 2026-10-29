/**
 * ISS-10472: which section ordering the server resolves, and in what order it
 * asks.
 *
 * The precedence IS the behavior, not an implementation detail: the two PostHog
 * keys are independent and both can be on, so a viewer with both enabled must
 * get the same ordering the browser's `useTableViewOrdering` gives them — it
 * checks root-order first. Reversing these two checks silently hands that
 * viewer a different board than the client renders.
 */

import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ evaluate: vi.fn() }));

vi.mock("@/lib/feature-flag-identity", () => ({
  evaluateFeatureFlagForAnyIdentity: mocks.evaluate,
}));

import {
  ARTIFACT_STATUS_ROOT_ORDER_SERVER_FLAG,
  UNIVERSAL_ARTIFACT_STATUS_SERVER_FLAG,
} from "@/lib/feature-flags/server-feature-flags";
import { resolveAssignedTreeSectionOrdering } from "../assigned-tree-section-ordering";

const IDENTITY = { clerkUserId: "user_clerk_abc", userId: "u-1" };

/** Answer per FLAG, so a reversed precedence cannot pass by position. */
function answerWith(answers: {
  rootOrder: boolean | null;
  universal: boolean | null;
}) {
  mocks.evaluate.mockImplementation((flag: unknown) => {
    if (flag === ARTIFACT_STATUS_ROOT_ORDER_SERVER_FLAG) {
      return Promise.resolve(answers.rootOrder);
    }
    if (flag === UNIVERSAL_ARTIFACT_STATUS_SERVER_FLAG) {
      return Promise.resolve(answers.universal);
    }
    throw new Error("unexpected flag");
  });
}

describe("resolveAssignedTreeSectionOrdering", () => {
  beforeEach(() => {
    mocks.evaluate.mockReset();
  });

  it("defaults to today's ordering when neither key is on", async () => {
    answerWith({ rootOrder: false, universal: false });

    await expect(resolveAssignedTreeSectionOrdering(IDENTITY)).resolves.toBe(
      ArtifactSectionOrdering.Vocabulary
    );
  });

  it("picks root-first when the root-order key is on", async () => {
    answerWith({ rootOrder: true, universal: false });

    await expect(resolveAssignedTreeSectionOrdering(IDENTITY)).resolves.toBe(
      ArtifactSectionOrdering.RootFirst
    );
  });

  it("picks retained when only the universal-status key is on", async () => {
    answerWith({ rootOrder: false, universal: true });

    await expect(resolveAssignedTreeSectionOrdering(IDENTITY)).resolves.toBe(
      ArtifactSectionOrdering.Retained
    );
  });

  it("prefers root-first when BOTH keys are on, matching the browser", async () => {
    answerWith({ rootOrder: true, universal: true });

    await expect(resolveAssignedTreeSectionOrdering(IDENTITY)).resolves.toBe(
      ArtifactSectionOrdering.RootFirst
    );
  });

  it("falls back to today's ordering when a key cannot be evaluated", async () => {
    // UNAVAILABLE is not enabled. A PostHog outage must not reorder a board,
    // and the closed-by-default policy's own answer is OFF.
    answerWith({ rootOrder: null, universal: null });

    await expect(resolveAssignedTreeSectionOrdering(IDENTITY)).resolves.toBe(
      ArtifactSectionOrdering.Vocabulary
    );
  });

  it("does not ask for the second key once the first decides", async () => {
    answerWith({ rootOrder: true, universal: true });

    await resolveAssignedTreeSectionOrdering(IDENTITY);

    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
  });
});
