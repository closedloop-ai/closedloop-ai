import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import { DEV_MODE_FLAG_KEY } from "@repo/api/src/types/dev-mode-flag";
import { FeatureAssignmentDelivery } from "@repo/api/src/types/feature-assignment-delivery";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DesktopMainFeatureFlagAssignment,
  type DesktopMainFeatureFlagAssignmentStore,
  isDesktopMainFeatureFlagEnabled,
  publishDesktopMainFeatureFlagAssignmentStore,
  subscribeToDesktopMainFeatureFlagAssignment,
} from "../src/main/auth/desktop-feature-flag-assignment.js";
import {
  createDesktopMainDevMode,
  type DesktopMainDevMode,
  publishDesktopMainDevMode,
  readDesktopMainCheckedFeatureFlags,
  setDesktopMainFeatureFlagOverrides,
} from "../src/main/auth/desktop-feature-flag-dev-mode.js";

/**
 * ISS-12048: main applies Dev Tools overrides to its own flag reads only under
 * its OWN eligibility check (its assignment's `dev-mode` plus a staff email from
 * its own identity fetch), never on the renderer's say-so, never to a
 * restriction flag, and never across an account boundary.
 */
const STAFF_USER = "user-staff";
const CUSTOMER_USER = "user-customer";
const GRANT_FLAG = "agentsNav";
const SECOND_GRANT_FLAG = "docsHelp";
// A value this repo does not own the meaning of here: written as the literal
// PostHog key so the refusal is proven against the key itself.
const RESTRICTION_FLAG = "compute-target-signing";

afterEach(() => {
  vi.useRealTimers();
  publishDesktopMainDevMode(null);
  publishDesktopMainFeatureFlagAssignmentStore(null);
});

describe("Desktop main Dev Mode overrides", () => {
  it("applies an override in both directions for an eligible staff account", async () => {
    const { devMode } = await wire({
      subject: STAFF_USER,
      flags: { [DEV_MODE_FLAG_KEY]: true, [GRANT_FLAG]: true },
      email: "ada@closedloop.ai",
    });

    devMode.setRendererOverrides({
      [GRANT_FLAG]: false,
      [SECOND_GRANT_FLAG]: true,
    });

    expect(isDesktopMainFeatureFlagEnabled(GRANT_FLAG)).toBe(false);
    expect(isDesktopMainFeatureFlagEnabled(SECOND_GRANT_FLAG)).toBe(true);
  });

  it("ignores overrides for a customer, whatever the renderer sends", async () => {
    await wire({
      subject: CUSTOMER_USER,
      flags: { [DEV_MODE_FLAG_KEY]: true, [GRANT_FLAG]: true },
      email: "dana@acme-corp.com",
    });

    // The renderer's claim of Dev Mode is not an input: nothing it sends can
    // make main treat this account as eligible.
    setDesktopMainFeatureFlagOverrides({
      [GRANT_FLAG]: false,
      [SECOND_GRANT_FLAG]: true,
    });

    expect(isDesktopMainFeatureFlagEnabled(GRANT_FLAG)).toBe(true);
    expect(isDesktopMainFeatureFlagEnabled(SECOND_GRANT_FLAG)).toBe(false);
  });

  it("ignores overrides for staff while dev-mode is not rolled out to them", async () => {
    await wire({
      subject: STAFF_USER,
      flags: { [GRANT_FLAG]: true },
      email: "ada@closedloop.ai",
    });

    setDesktopMainFeatureFlagOverrides({ [GRANT_FLAG]: false });

    expect(isDesktopMainFeatureFlagEnabled(GRANT_FLAG)).toBe(true);
  });

  it("refuses to override a restriction flag", async () => {
    await wire({
      subject: STAFF_USER,
      flags: { [DEV_MODE_FLAG_KEY]: true, [RESTRICTION_FLAG]: true },
      email: "ada@closedloop.ai",
    });

    setDesktopMainFeatureFlagOverrides({
      [RESTRICTION_FLAG]: false,
      [GRANT_FLAG]: true,
    });

    expect(isDesktopMainFeatureFlagEnabled(RESTRICTION_FLAG)).toBe(true);
    expect(isDesktopMainFeatureFlagEnabled(GRANT_FLAG)).toBe(true);
  });

  it("stores no overrides from a malformed payload", async () => {
    await wire({
      subject: STAFF_USER,
      flags: { [DEV_MODE_FLAG_KEY]: true, [GRANT_FLAG]: true },
      email: "ada@closedloop.ai",
    });

    setDesktopMainFeatureFlagOverrides({ [GRANT_FLAG]: "off" });
    expect(isDesktopMainFeatureFlagEnabled(GRANT_FLAG)).toBe(true);

    setDesktopMainFeatureFlagOverrides("not a record");
    expect(isDesktopMainFeatureFlagEnabled(GRANT_FLAG)).toBe(true);
  });

  it("clears overrides and staff status on an account change, before the new identity lands", async () => {
    const identities = new Map<string, DesktopIdentity>([
      [STAFF_USER, identityFor(STAFF_USER, "ada@closedloop.ai")],
    ]);
    let subject: string | null = STAFF_USER;
    const flags = { [DEV_MODE_FLAG_KEY]: true, [GRANT_FLAG]: true };
    const assignment = fakeAssignmentStore(() => ({ subject, flags }));
    let currentUser = STAFF_USER;
    const devMode = createDesktopMainDevMode({
      assignment,
      fetchIdentity: () => Promise.resolve(identities.get(currentUser) ?? null),
    });
    publishDesktopMainFeatureFlagAssignmentStore(assignment);
    publishDesktopMainDevMode(devMode);
    await devMode.resolveFor(STAFF_USER);
    devMode.setRendererOverrides({ [GRANT_FLAG]: false });
    expect(isDesktopMainFeatureFlagEnabled(GRANT_FLAG)).toBe(false);

    subject = CUSTOMER_USER;
    currentUser = CUSTOMER_USER;
    const pending = devMode.resolveFor(CUSTOMER_USER);
    // Synchronously cleared: no window reads the previous account's overrides.
    expect(isDesktopMainFeatureFlagEnabled(GRANT_FLAG)).toBe(true);
    await pending;
    devMode.setRendererOverrides({ [GRANT_FLAG]: false });
    expect(isDesktopMainFeatureFlagEnabled(GRANT_FLAG)).toBe(true);
  });

  it("drops a late identity reply that lands after sign-out", async () => {
    let resolveIdentity: (identity: DesktopIdentity | null) => void = () =>
      undefined;
    // The fake store still names the staff account, so only the generation
    // check can keep the stale reply from making main eligible.
    const assignment = fakeAssignmentStore(() => ({
      subject: STAFF_USER,
      flags: { [DEV_MODE_FLAG_KEY]: true, [GRANT_FLAG]: true },
    }));
    const devMode = createDesktopMainDevMode({
      assignment,
      fetchIdentity: () =>
        new Promise((resolve) => {
          resolveIdentity = resolve;
        }),
    });
    publishDesktopMainFeatureFlagAssignmentStore(assignment);
    publishDesktopMainDevMode(devMode);

    const signedIn = devMode.resolveFor(STAFF_USER);
    await devMode.resolveFor(null);
    resolveIdentity(identityFor(STAFF_USER, "ada@closedloop.ai"));
    await signedIn;

    expect(devMode.isEligible()).toBe(false);
  });

  it("retries a failed main identity lookup on a later flag read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const assignment = fakeAssignmentStore(() => ({
      subject: STAFF_USER,
      flags: { [DEV_MODE_FLAG_KEY]: true, [GRANT_FLAG]: true },
    }));
    const fetchIdentity = vi
      .fn<() => Promise<DesktopIdentity | null>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(identityFor(STAFF_USER, "ada@closedloop.ai"));
    const devMode = createDesktopMainDevMode({ assignment, fetchIdentity });
    publishDesktopMainFeatureFlagAssignmentStore(assignment);
    publishDesktopMainDevMode(devMode);
    await devMode.resolveFor(STAFF_USER);
    devMode.setRendererOverrides({ [GRANT_FLAG]: false });

    expect(isDesktopMainFeatureFlagEnabled(GRANT_FLAG)).toBe(true);
    expect(fetchIdentity).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5001);
    expect(isDesktopMainFeatureFlagEnabled(GRANT_FLAG)).toBe(true);
    await vi.waitFor(() => expect(devMode.isEligible()).toBe(true));
    expect(isDesktopMainFeatureFlagEnabled(GRANT_FLAG)).toBe(false);
    expect(fetchIdentity).toHaveBeenCalledTimes(2);
  });
});

describe("Desktop main checked flag keys", () => {
  it("records keys only while eligible and notifies once per new key", async () => {
    const { devMode } = await wire({
      subject: STAFF_USER,
      flags: { [DEV_MODE_FLAG_KEY]: true, [GRANT_FLAG]: true },
      email: "ada@closedloop.ai",
    });
    const listener = vi.fn();
    devMode.subscribeChecked(listener);

    isDesktopMainFeatureFlagEnabled(GRANT_FLAG);
    isDesktopMainFeatureFlagEnabled(GRANT_FLAG);
    isDesktopMainFeatureFlagEnabled(SECOND_GRANT_FLAG);

    expect(readDesktopMainCheckedFeatureFlags()).toEqual([
      GRANT_FLAG,
      SECOND_GRANT_FLAG,
    ]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("records and reports nothing for an ineligible account", async () => {
    await wire({
      subject: CUSTOMER_USER,
      flags: { [DEV_MODE_FLAG_KEY]: true, [GRANT_FLAG]: true },
      email: "dana@acme-corp.com",
    });

    isDesktopMainFeatureFlagEnabled(GRANT_FLAG);

    expect(readDesktopMainCheckedFeatureFlags()).toEqual([]);
  });

  it("tells assignment subscribers when the overrides change", async () => {
    const { devMode } = await wire({
      subject: STAFF_USER,
      flags: { [DEV_MODE_FLAG_KEY]: true, [GRANT_FLAG]: true },
      email: "ada@closedloop.ai",
    });
    const listener = vi.fn();
    const unsubscribe = subscribeToDesktopMainFeatureFlagAssignment(listener);

    devMode.setRendererOverrides({ [GRANT_FLAG]: false });
    unsubscribe();
    devMode.setRendererOverrides({});

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

async function wire(options: {
  subject: string;
  flags: Record<string, boolean>;
  email: string;
}): Promise<{ devMode: DesktopMainDevMode }> {
  const assignment = fakeAssignmentStore(() => ({
    subject: options.subject,
    flags: options.flags,
  }));
  const devMode = createDesktopMainDevMode({
    assignment,
    fetchIdentity: () =>
      Promise.resolve(identityFor(options.subject, options.email)),
  });
  publishDesktopMainFeatureFlagAssignmentStore(assignment);
  publishDesktopMainDevMode(devMode);
  await devMode.resolveFor(options.subject);
  return { devMode };
}

function fakeAssignmentStore(
  current: () => { subject: string | null; flags: Record<string, boolean> }
): DesktopMainFeatureFlagAssignmentStore {
  const read = (): DesktopMainFeatureFlagAssignment => ({
    ...current(),
    delivery: FeatureAssignmentDelivery.Assigned,
  });
  return {
    resolveFor: () => Promise.resolve(),
    isEnabled: (key) => read().flags[key] === true,
    read,
    subscribe: () => () => undefined,
  };
}

function identityFor(userId: string, email: string): DesktopIdentity {
  return {
    userId,
    organizationId: "org-1",
    email,
    firstName: null,
    lastName: null,
    organizationName: null,
  };
}
