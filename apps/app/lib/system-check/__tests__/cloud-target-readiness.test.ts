import { ComputePreference } from "@repo/api/src/types/compute-target";
import { describe, expect, it } from "vitest";
import {
  CLOUD_TARGET_UNAVAILABLE_TOAST_DURATION_MS,
  CloudTargetReadiness,
  CloudTargetUnavailableMessage,
  CloudTargetUnavailableReason,
  evaluateCloudTargetReadiness,
  getCloudTargetBlockingReason,
  isCloudComputeSelection,
} from "../cloud-target-readiness";

const bothUnset = {
  org: { isSet: false, lastFour: null },
  user: { isSet: false, lastFour: null },
};

/**
 * Sonner's own default toast lifetime (`TOAST_LIFETIME`, sonner 2.0.7). The
 * shared `Toaster` in `packages/design-system/components/ui/sonner.tsx` sets no
 * `duration`, so this is what a toast that omits one actually gets — which is
 * why omitting one here was the bug.
 */
const SONNER_DEFAULT_TOAST_DURATION_MS = 4000;

describe("evaluateCloudTargetReadiness", () => {
  it("is ready when only the user key is set", () => {
    expect(
      evaluateCloudTargetReadiness({
        ...bothUnset,
        user: { isSet: true, lastFour: "abcd" },
      })
    ).toBe(CloudTargetReadiness.Ready);
  });

  it("is ready when only the org key is set", () => {
    expect(
      evaluateCloudTargetReadiness({
        ...bothUnset,
        org: { isSet: true, lastFour: "abcd" },
      })
    ).toBe(CloudTargetReadiness.Ready);
  });

  it("reports a missing key when neither level has one", () => {
    expect(evaluateCloudTargetReadiness(bothUnset)).toBe(
      CloudTargetReadiness.MissingApiKey
    );
  });

  it("stays ready when a newer API adds fields the client does not know", () => {
    expect(
      evaluateCloudTargetReadiness({
        ...bothUnset,
        user: { isSet: true, lastFour: "abcd", rotationDueAt: "2026-01-01" },
        billingMode: "metered",
      })
    ).toBe(CloudTargetReadiness.Ready);
  });

  it("degrades to unknown for a payload it cannot parse", () => {
    expect(evaluateCloudTargetReadiness(undefined)).toBe(
      CloudTargetReadiness.Unknown
    );
    expect(evaluateCloudTargetReadiness({ org: { isSet: "yes" } })).toBe(
      CloudTargetReadiness.Unknown
    );
    expect(evaluateCloudTargetReadiness("not an object")).toBe(
      CloudTargetReadiness.Unknown
    );
  });
});

describe("getCloudTargetBlockingReason", () => {
  it("blocks only on positive evidence that no key exists", () => {
    expect(
      getCloudTargetBlockingReason(CloudTargetReadiness.MissingApiKey)
    ).toBe(CloudTargetUnavailableReason.MissingApiKey);
  });

  it("does not block a ready target", () => {
    expect(getCloudTargetBlockingReason(CloudTargetReadiness.Ready)).toBeNull();
  });

  it("does not block when readiness is unknown", () => {
    // A version-skewed or briefly unreachable API must not wedge Cloud runs.
    expect(
      getCloudTargetBlockingReason(CloudTargetReadiness.Unknown)
    ).toBeNull();
  });
});

describe("isCloudComputeSelection", () => {
  it("treats an explicit null compute target as Cloud", () => {
    expect(
      isCloudComputeSelection({
        requestedComputeTargetId: null,
        preferredComputeMode: ComputePreference.Local,
      })
    ).toBe(true);
  });

  it("treats an explicitly requested target as not Cloud", () => {
    expect(
      isCloudComputeSelection({
        requestedComputeTargetId: "target-1",
        preferredComputeMode: ComputePreference.Cloud,
      })
    ).toBe(false);
  });

  it("falls back to the saved preference when no target was requested", () => {
    expect(
      isCloudComputeSelection({
        requestedComputeTargetId: undefined,
        preferredComputeMode: ComputePreference.Cloud,
      })
    ).toBe(true);
    // The no-local-target branch is also reached by a Local user whose desktop
    // is offline — that user is not on Cloud and must not be told about keys.
    expect(
      isCloudComputeSelection({
        requestedComputeTargetId: undefined,
        preferredComputeMode: ComputePreference.Local,
      })
    ).toBe(false);
  });

  it("does not assume Cloud when the preference is unknown", () => {
    expect(
      isCloudComputeSelection({
        requestedComputeTargetId: undefined,
        preferredComputeMode: undefined,
      })
    ).toBe(false);
  });
});

describe("CloudTargetUnavailableMessage", () => {
  it("covers every blocking reason, so a new one cannot render blank", () => {
    const covered = Object.keys(CloudTargetUnavailableMessage).sort();
    expect(covered).toEqual(Object.values(CloudTargetUnavailableReason).sort());
  });

  it("tells the user the command did not run, the fix, and the alternative", () => {
    const copy =
      CloudTargetUnavailableMessage[CloudTargetUnavailableReason.MissingApiKey];

    // Short title, paragraph in the description — the shape every other
    // blocked-gate toast in the pre-loop provider uses.
    expect(copy.title).toBe("Cloud runs need an Anthropic API key");
    // Never let the UI imply the command started when it did not.
    expect(copy.description).toContain("didn't start");
    // Offer the escape hatch, so the user is not stuck behind the gate.
    expect(copy.description).toContain("local compute target");
    // Say the wayfinding once. The action button performs the Settings
    // navigation, so restating the route here would leave the description
    // with nothing of its own to add. Where that button actually lands — the
    // Integrations tab, NOT the `sk_live_`-only `API Keys` tab — is asserted
    // against the navigation itself in
    // `pre-loop-cloud-target-validation.test.tsx`.
    expect(copy.description).not.toContain("Settings");
    expect(copy.description).not.toContain("API Keys");
  });

  it("outlasts sonner's acknowledgement-sized default", () => {
    // The block toast carries a title, a two-clause description, and an action
    // button, and it is the only place the user finds out why nothing ran. The
    // default is sized for "Saved", not for that — pin the floor so it cannot
    // quietly drift back down.
    expect(CLOUD_TARGET_UNAVAILABLE_TOAST_DURATION_MS).toBeGreaterThan(
      SONNER_DEFAULT_TOAST_DURATION_MS
    );
  });

  it("keeps the arrow character out of shipped toast copy", () => {
    for (const copy of Object.values(CloudTargetUnavailableMessage)) {
      expect(copy.title).not.toContain("→");
      expect(copy.description).not.toContain("→");
    }
  });
});
