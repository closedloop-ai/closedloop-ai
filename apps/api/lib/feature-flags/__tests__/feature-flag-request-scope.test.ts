import {
  FEATURE_FLAG_OVERRIDES_HEADER,
  FEATURE_FLAGS_CHECKED_HEADER,
  RESTRICTION_FEATURE_FLAG_KEYS,
} from "@repo/api/src/types/feature-flag-overrides";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoizedFeatureFlagGate } from "@/lib/memoized-feature-flag-gate";
import { runWithFeatureFlagOverrides } from "../feature-flag-request-scope-auth";
import { ServerFeatureFlagKind } from "../server-feature-flag";
import { evaluateServerFeatureFlagForDistinctId } from "../server-feature-flag-evaluation";
import {
  COMPUTE_TARGET_SIGNING_SERVER_FLAG,
  DEV_MODE_SERVER_FLAG,
  listServerFeatureFlags,
  MCP_UPLOAD_ATTACHMENT_SERVER_FLAG,
  PENSERO_INTEGRATION_SERVER_FLAG,
} from "../server-feature-flags";

const posthog = vi.hoisted(() => ({
  answers: new Map<string, boolean>(),
  pinned: null as Record<string, boolean | string> | null,
}));

/**
 * PostHog, as `@repo/analytics/feature-flags` presents it. Only the live read
 * and the pinned read are replaced; `isPinnedFeatureFlagEnabled` stays real.
 */
vi.mock("@repo/analytics/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/analytics/feature-flags")>()),
  isFeatureFlagEnabledForDistinctId: vi.fn((flag: string) =>
    Promise.resolve(posthog.answers.get(flag) ?? false)
  ),
  readPinnedFeatureFlags: vi.fn(() => Promise.resolve(posthog.pinned)),
}));

const STAFF = { clerkUserId: "clerk_staff", email: "ada@closedloop.ai" };
const CUSTOMER = { clerkUserId: "clerk_customer", email: "dana@acme-corp.com" };

beforeEach(() => {
  posthog.answers = new Map([
    [DEV_MODE_SERVER_FLAG.key, true],
    [PENSERO_INTEGRATION_SERVER_FLAG.key, true],
    [MCP_UPLOAD_ATTACHMENT_SERVER_FLAG.key, false],
    [COMPUTE_TARGET_SIGNING_SERVER_FLAG.key, true],
  ]);
  posthog.pinned = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

function requestWithOverrides(overrides: unknown): Request {
  return new Request("https://api.closedloop.ai/documents", {
    headers: { [FEATURE_FLAG_OVERRIDES_HEADER]: JSON.stringify(overrides) },
  });
}

/** Reads two grants for `distinctId` inside a scoped request. */
async function readInScope(
  request: Request,
  caller: { clerkUserId: string; email: string },
  distinctId: string = caller.clerkUserId
) {
  let reads: (boolean | null)[] = [];
  const response = await runWithFeatureFlagOverrides(
    request,
    caller,
    async () => {
      reads = [
        await evaluateServerFeatureFlagForDistinctId(
          PENSERO_INTEGRATION_SERVER_FLAG,
          distinctId
        ),
        await evaluateServerFeatureFlagForDistinctId(
          MCP_UPLOAD_ATTACHMENT_SERVER_FLAG,
          distinctId
        ),
      ];
      return new Response("ok");
    }
  );
  return { reads, checked: response.headers.get(FEATURE_FLAGS_CHECKED_HEADER) };
}

describe("Dev Tools overrides on the server (ISS-12048)", () => {
  it("applies a verified staff caller's overrides in both directions and reports the keys checked", async () => {
    const { reads, checked } = await readInScope(
      requestWithOverrides({
        [PENSERO_INTEGRATION_SERVER_FLAG.key]: false,
        [MCP_UPLOAD_ATTACHMENT_SERVER_FLAG.key]: true,
      }),
      STAFF
    );

    expect(reads).toEqual([false, true]);
    expect(checked?.split(",")).toEqual(
      expect.arrayContaining([
        PENSERO_INTEGRATION_SERVER_FLAG.key,
        MCP_UPLOAD_ATTACHMENT_SERVER_FLAG.key,
      ])
    );
  });

  it("ignores the header, and reports nothing, for a non-staff caller", async () => {
    const { reads, checked } = await readInScope(
      requestWithOverrides({ [MCP_UPLOAD_ATTACHMENT_SERVER_FLAG.key]: true }),
      CUSTOMER
    );

    expect(reads).toEqual([true, false]);
    expect(checked).toBeNull();
  });

  it("ignores the header for staff whose dev-mode flag is off", async () => {
    posthog.answers.set(DEV_MODE_SERVER_FLAG.key, false);

    const { reads, checked } = await readInScope(
      requestWithOverrides({ [MCP_UPLOAD_ATTACHMENT_SERVER_FLAG.key]: true }),
      STAFF
    );

    expect(reads).toEqual([true, false]);
    expect(checked).toBeNull();
  });

  it("cannot override dev-mode itself to unlock the rest", async () => {
    posthog.answers.set(DEV_MODE_SERVER_FLAG.key, false);

    const { reads } = await readInScope(
      requestWithOverrides({
        [DEV_MODE_SERVER_FLAG.key]: true,
        [MCP_UPLOAD_ATTACHMENT_SERVER_FLAG.key]: true,
      }),
      STAFF
    );

    expect(reads).toEqual([true, false]);
  });

  it("applies overrides only to reads for the caller's own distinct id", async () => {
    const { reads } = await readInScope(
      requestWithOverrides({ [MCP_UPLOAD_ATTACHMENT_SERVER_FLAG.key]: true }),
      STAFF,
      "clerk_someone_else"
    );

    expect(reads).toEqual([true, false]);
  });

  it("never overrides a restriction flag, in either direction", async () => {
    let read: boolean | null = null;
    await runWithFeatureFlagOverrides(
      requestWithOverrides({
        [COMPUTE_TARGET_SIGNING_SERVER_FLAG.key]: false,
      }),
      STAFF,
      async () => {
        read = await evaluateServerFeatureFlagForDistinctId(
          COMPUTE_TARGET_SIGNING_SERVER_FLAG,
          STAFF.clerkUserId
        );
        return new Response("ok");
      }
    );

    expect(read).toBe(true);
  });

  it("does nothing at all for a request without the header", async () => {
    const response = await runWithFeatureFlagOverrides(
      new Request("https://api.closedloop.ai/documents"),
      STAFF,
      () => Promise.resolve(new Response("ok"))
    );

    expect(response.headers.get(FEATURE_FLAGS_CHECKED_HEADER)).toBeNull();
  });
});

describe("the memoized gate under overrides and a pinned snapshot (ISS-12048)", () => {
  function createGate() {
    const publish = vi.fn(() => Promise.resolve());
    const gate = createMemoizedFeatureFlagGate({
      flag: MCP_UPLOAD_ATTACHMENT_SERVER_FLAG,
      ttlMs: 60_000,
      unavailableBackoffMs: 5000,
      maxEntries: 10,
      unavailableLogKey: "test_unavailable",
      sharedDecisionStore: { read: () => Promise.resolve(null), publish },
      sharedDecisionTtlMs: 3_600_000,
    });
    return { gate, publish };
  }

  it("serves an override without caching or publishing it", async () => {
    const { gate, publish } = createGate();
    const identity = { userId: "user_staff", clerkUserId: STAFF.clerkUserId };

    let overridden: boolean | null = null;
    await runWithFeatureFlagOverrides(
      requestWithOverrides({ [MCP_UPLOAD_ATTACHMENT_SERVER_FLAG.key]: true }),
      STAFF,
      async () => {
        overridden = await gate.resolve(identity);
        return new Response("ok");
      }
    );

    expect(overridden).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    // The next, unscoped read is PostHog's own answer, not the override.
    await expect(gate.resolve(identity)).resolves.toBe(false);
  });

  it("serves a pinned snapshot value without caching or publishing it", async () => {
    const { gate, publish } = createGate();
    const identity = { userId: "user_any", clerkUserId: "clerk_any" };
    posthog.pinned = { [MCP_UPLOAD_ATTACHMENT_SERVER_FLAG.key]: "variant-a" };

    await expect(gate.resolve(identity)).resolves.toBe(true);
    expect(publish).not.toHaveBeenCalled();

    posthog.pinned = null;
    await expect(gate.resolve(identity)).resolves.toBe(false);
  });

  it("reports the flag in every request even when the gate uses a memoized answer", async () => {
    const { gate, publish } = createGate();
    const identity = { userId: "user_staff", clerkUserId: STAFF.clerkUserId };
    const request = requestWithOverrides({});

    for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
      const response = await runWithFeatureFlagOverrides(
        request,
        STAFF,
        async () => {
          await gate.resolve(identity);
          return new Response("ok");
        }
      );
      expect(
        response.headers.get(FEATURE_FLAGS_CHECKED_HEADER)?.split(",")
      ).toEqual(
        expect.arrayContaining([MCP_UPLOAD_ATTACHMENT_SERVER_FLAG.key])
      );
    }
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("restriction keys shared with the browser and Desktop (ISS-12048)", () => {
  it("equals the server registry's restriction entries", () => {
    const registryRestrictions = new Set(
      listServerFeatureFlags()
        .filter((flag) => flag.kind === ServerFeatureFlagKind.Restriction)
        .map((flag) => flag.key)
    );

    expect(new Set(RESTRICTION_FEATURE_FLAG_KEYS)).toEqual(
      registryRestrictions
    );
  });
});
