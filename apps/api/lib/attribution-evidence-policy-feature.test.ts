import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const organizations = vi.hoisted(
  () =>
    new Map<string, string>([
      ["org-on", "clerk-org-on"],
      ["org-off", "clerk-org-off"],
    ])
);

vi.mock("@repo/database", () => ({
  withDb: vi.fn(
    async (
      fn: (db: {
        organization: {
          findUnique: (args: {
            where: { id: string };
          }) => Promise<{ clerkId: string } | null>;
        };
      }) => unknown
    ) =>
      await fn({
        organization: {
          findUnique: ({ where }) => {
            const clerkId = organizations.get(where.id);
            return Promise.resolve(clerkId ? { clerkId } : null);
          },
        },
      })
  ),
}));
vi.mock("@/lib/feature-flags/feature-flag-request-scope", () => ({
  currentFeatureFlagRequestScope: vi.fn(() => undefined),
}));
vi.mock("@/lib/feature-flags/server-feature-flag-evaluation", () => ({
  evaluateServerFeatureFlagForOrganization: vi.fn(
    async (_flag: unknown, clerkOrganizationId: string) =>
      clerkOrganizationId === "clerk-org-on"
  ),
  resolveUnmemoizedFeatureFlagValue: vi.fn(async () => undefined),
}));

import { log } from "@repo/observability/log";
import { runWithAttributionEvidenceGate } from "@/lib/attribution-evidence-gate-scope";
import {
  ATTRIBUTION_EVIDENCE_DECISION_TTL_MS,
  ATTRIBUTION_EVIDENCE_POLICY_FLAG_UNAVAILABLE_LOG_KEY,
  clearAttributionEvidenceGateMemo,
  evaluateAttributionEvidenceForOrganization,
  isAttributionEvidenceEnabledForOrganization,
  isAttributionEvidenceReadOffForOrganization,
  isAttributionEvidenceReadOnForOrganization,
  readAttributionEvidenceForRequest,
} from "@/lib/attribution-evidence-policy-feature";
import { currentFeatureFlagRequestScope } from "@/lib/feature-flags/feature-flag-request-scope";
import {
  evaluateServerFeatureFlagForOrganization,
  resolveUnmemoizedFeatureFlagValue,
} from "@/lib/feature-flags/server-feature-flag-evaluation";
import { ATTRIBUTION_EVIDENCE_POLICY_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";

describe("isAttributionEvidenceEnabledForOrganization (ISS-12552)", () => {
  beforeEach(() => {
    clearAttributionEvidenceGateMemo();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers each organization from its own PostHog group", async () => {
    await expect(
      isAttributionEvidenceEnabledForOrganization("org-on")
    ).resolves.toBe(true);
    await expect(
      isAttributionEvidenceEnabledForOrganization("org-off")
    ).resolves.toBe(false);
    expect(evaluateServerFeatureFlagForOrganization).toHaveBeenCalledWith(
      ATTRIBUTION_EVIDENCE_POLICY_SERVER_FLAG,
      "clerk-org-on"
    );
    expect(evaluateServerFeatureFlagForOrganization).toHaveBeenCalledWith(
      ATTRIBUTION_EVIDENCE_POLICY_SERVER_FLAG,
      "clerk-org-off"
    );
  });

  it("reads an unavailable PostHog answer as off", async () => {
    vi.mocked(evaluateServerFeatureFlagForOrganization).mockResolvedValue(null);

    await expect(
      isAttributionEvidenceEnabledForOrganization("org-on")
    ).resolves.toBe(false);
    await expect(
      evaluateAttributionEvidenceForOrganization("org-on")
    ).resolves.toBe(null);
  });

  it("reports a thrown evaluation as unavailable and logs it", async () => {
    const warn = vi.spyOn(log, "warn");
    vi.mocked(evaluateServerFeatureFlagForOrganization).mockRejectedValue(
      new Error("posthog down")
    );

    await expect(
      evaluateAttributionEvidenceForOrganization("org-on")
    ).resolves.toBe(null);
    expect(warn).toHaveBeenCalledWith(
      ATTRIBUTION_EVIDENCE_POLICY_FLAG_UNAVAILABLE_LOG_KEY,
      expect.objectContaining({ organizationId: "org-on", status: "warn" })
    );
  });

  it("reads an organization that does not exist as off, without asking PostHog", async () => {
    await expect(
      isAttributionEvidenceEnabledForOrganization("org-missing")
    ).resolves.toBe(false);
    expect(evaluateServerFeatureFlagForOrganization).not.toHaveBeenCalled();
  });

  it("evaluates one organization once per request, however many sites read it", async () => {
    const answers = await runWithAttributionEvidenceGate(async () => [
      await isAttributionEvidenceEnabledForOrganization("org-on"),
      await isAttributionEvidenceEnabledForOrganization("org-on"),
      await isAttributionEvidenceEnabledForOrganization("org-off"),
    ]);

    expect(answers).toEqual([true, true, false]);
    expect(evaluateServerFeatureFlagForOrganization).toHaveBeenCalledTimes(2);
  });

  it("keeps the request's first answer when PostHog changes its mind mid-request", async () => {
    const answers = await runWithAttributionEvidenceGate(async () => {
      const first = await isAttributionEvidenceEnabledForOrganization("org-on");
      vi.mocked(evaluateServerFeatureFlagForOrganization).mockResolvedValue(
        false
      );
      return [
        first,
        await isAttributionEvidenceEnabledForOrganization("org-on"),
      ];
    });

    expect(answers).toEqual([true, true]);
  });

  it("evaluates PostHog once for two requests of one organization inside the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));

    const answers = [
      await runWithAttributionEvidenceGate(() =>
        isAttributionEvidenceEnabledForOrganization("org-on")
      ),
      await runWithAttributionEvidenceGate(() =>
        isAttributionEvidenceEnabledForOrganization("org-on")
      ),
    ];

    expect(answers).toEqual([true, true]);
    expect(evaluateServerFeatureFlagForOrganization).toHaveBeenCalledTimes(1);
  });

  it("asks PostHog again once the TTL has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
    await runWithAttributionEvidenceGate(() =>
      isAttributionEvidenceEnabledForOrganization("org-on")
    );
    vi.mocked(evaluateServerFeatureFlagForOrganization).mockResolvedValue(
      false
    );
    vi.setSystemTime(
      new Date(Date.now() + ATTRIBUTION_EVIDENCE_DECISION_TTL_MS + 1)
    );

    await expect(
      runWithAttributionEvidenceGate(() =>
        isAttributionEvidenceEnabledForOrganization("org-on")
      )
    ).resolves.toBe(false);
    expect(evaluateServerFeatureFlagForOrganization).toHaveBeenCalledTimes(2);
  });

  it("keeps each organization's memo separate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
    const first = [
      await isAttributionEvidenceEnabledForOrganization("org-on"),
      await isAttributionEvidenceEnabledForOrganization("org-off"),
    ];
    // PostHog now answers the opposite for both; inside the TTL each
    // organization still reads the answer memoized for it alone.
    vi.mocked(evaluateServerFeatureFlagForOrganization).mockImplementation(
      async (_flag, clerkOrganizationId) =>
        clerkOrganizationId !== "clerk-org-on"
    );
    const memoOn = await isAttributionEvidenceEnabledForOrganization("org-on");
    const memoOff =
      await isAttributionEvidenceEnabledForOrganization("org-off");

    expect(first).toEqual([true, false]);
    expect(memoOn).toBe(true);
    expect(memoOff).toBe(false);
    expect(evaluateServerFeatureFlagForOrganization).toHaveBeenCalledTimes(2);
    expect(evaluateServerFeatureFlagForOrganization).toHaveBeenNthCalledWith(
      1,
      ATTRIBUTION_EVIDENCE_POLICY_SERVER_FLAG,
      "clerk-org-on"
    );
    expect(evaluateServerFeatureFlagForOrganization).toHaveBeenNthCalledWith(
      2,
      ATTRIBUTION_EVIDENCE_POLICY_SERVER_FLAG,
      "clerk-org-off"
    );
  });

  it("reads an unavailable answer the request already holds as off, and never as on", async () => {
    vi.mocked(evaluateServerFeatureFlagForOrganization).mockResolvedValue(null);

    const held = await runWithAttributionEvidenceGate(async () => {
      await readAttributionEvidenceForRequest("org-on");
      return {
        off: isAttributionEvidenceReadOffForOrganization("org-on"),
        on: isAttributionEvidenceReadOnForOrganization("org-on"),
      };
    });

    expect(held).toEqual({ off: true, on: false });
  });

  it("holds the last evaluated answer through a later outage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
    await isAttributionEvidenceEnabledForOrganization("org-on");
    vi.mocked(evaluateServerFeatureFlagForOrganization).mockResolvedValue(null);
    vi.setSystemTime(
      new Date(Date.now() + ATTRIBUTION_EVIDENCE_DECISION_TTL_MS + 1)
    );

    await expect(
      evaluateAttributionEvidenceForOrganization("org-on")
    ).resolves.toBe(true);
  });

  it("applies the Dev Mode caller's own override instead of the organization's answer", async () => {
    vi.mocked(currentFeatureFlagRequestScope).mockReturnValue({
      distinctId: "clerk-dev",
      overrides: async () => ({}),
      checkedKeys: new Set(),
    });
    vi.mocked(resolveUnmemoizedFeatureFlagValue).mockResolvedValue(true);

    await expect(
      isAttributionEvidenceEnabledForOrganization("org-off")
    ).resolves.toBe(true);
    expect(resolveUnmemoizedFeatureFlagValue).toHaveBeenCalledWith(
      ATTRIBUTION_EVIDENCE_POLICY_SERVER_FLAG,
      ["clerk-dev"]
    );
    expect(evaluateServerFeatureFlagForOrganization).not.toHaveBeenCalled();
  });
});
