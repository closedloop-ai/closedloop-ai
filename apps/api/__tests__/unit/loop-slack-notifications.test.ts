/**
 * Unit tests for apps/api/lib/loop-slack-notifications.ts
 *
 * Verifies dispatchLoopCompletedSlackNotification:
 * - no-ops when the org has no connected SlackIntegration
 * - no-ops when the rollout flag is off (and never touches the DB)
 * - posts "Shipped <loop> in <project>" to the integration's default channel
 * - omits the "in <project>" suffix when the loop has no repo
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede all imports
// ---------------------------------------------------------------------------

const isFeatureFlagEnabledForDistinctId = vi.fn();
const findUnique = vi.fn();
const postToSlackChannel = vi.fn();

vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (e: unknown) => e,
}));

// Run the waitUntil-wrapped promise inline and surface it so tests can await it.
let lastDispatched: Promise<unknown> | undefined;
vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => {
    lastDispatched = p;
  },
}));

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: (...args: unknown[]) =>
    isFeatureFlagEnabledForDistinctId(...args),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({ slackIntegration: { findUnique } }),
}));

vi.mock("@/lib/slack-notifier", () => ({
  postToSlackChannel: (...args: unknown[]) => postToSlackChannel(...args),
}));

const resolveIntegrationToken = vi.fn();
vi.mock("@/lib/integration-encryption", () => ({
  resolveIntegrationToken: (...args: unknown[]) =>
    resolveIntegrationToken(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { dispatchLoopCompletedSlackNotification } from "@/lib/loop-slack-notifications";

const ORG_ID = "org-1";

beforeEach(() => {
  vi.clearAllMocks();
  lastDispatched = undefined;
  isFeatureFlagEnabledForDistinctId.mockResolvedValue(true);
  postToSlackChannel.mockResolvedValue({ ok: true });
  // Mirror the real helper: prefer the encrypted column (decrypting it), else
  // fall back to the plaintext column — without touching KMS.
  resolveIntegrationToken.mockImplementation(
    (encrypted: string | null | undefined, plaintext: string | null) =>
      Promise.resolve(encrypted ? `decrypted:${encrypted}` : plaintext)
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispatchLoopCompletedSlackNotification", () => {
  it("posts 'Shipped <loop> in <project>' to the integration default channel", async () => {
    findUnique.mockResolvedValue({
      accessToken: "xoxb-org",
      defaultChannelId: "C0ORG",
    });

    dispatchLoopCompletedSlackNotification({
      organizationId: ORG_ID,
      loopLabel: "Execute",
      projectLabel: "acme/widgets",
    });
    await lastDispatched;

    expect(postToSlackChannel).toHaveBeenCalledWith(
      "xoxb-org",
      "C0ORG",
      "Shipped Execute in acme/widgets"
    );
  });

  it("resolves the encrypted token when present, preferring it over plaintext", async () => {
    findUnique.mockResolvedValue({
      accessToken: "xoxb-plaintext",
      accessTokenEncrypted: "ENC",
      defaultChannelId: "C0ORG",
    });

    dispatchLoopCompletedSlackNotification({
      organizationId: ORG_ID,
      loopLabel: "Execute",
      projectLabel: "acme/widgets",
    });
    await lastDispatched;

    expect(postToSlackChannel).toHaveBeenCalledWith(
      "decrypted:ENC",
      "C0ORG",
      "Shipped Execute in acme/widgets"
    );
  });

  it("omits the project suffix when the loop has no repo", async () => {
    findUnique.mockResolvedValue({
      accessToken: "xoxb-org",
      defaultChannelId: "C0ORG",
    });

    dispatchLoopCompletedSlackNotification({
      organizationId: ORG_ID,
      loopLabel: "Plan",
      projectLabel: null,
    });
    await lastDispatched;

    expect(postToSlackChannel).toHaveBeenCalledWith(
      "xoxb-org",
      "C0ORG",
      "Shipped Plan"
    );
  });

  it("fails closed without posting when token decryption throws", async () => {
    findUnique.mockResolvedValue({
      accessToken: "xoxb-plaintext",
      accessTokenEncrypted: "ENC",
      defaultChannelId: "C0ORG",
    });
    resolveIntegrationToken.mockRejectedValue(new Error("kms unavailable"));

    dispatchLoopCompletedSlackNotification({
      organizationId: ORG_ID,
      loopLabel: "Execute",
      projectLabel: "acme/widgets",
    });
    await lastDispatched;

    expect(postToSlackChannel).not.toHaveBeenCalled();
  });

  it("no-ops when the org has no connected SlackIntegration", async () => {
    findUnique.mockResolvedValue(null);

    dispatchLoopCompletedSlackNotification({
      organizationId: ORG_ID,
      loopLabel: "Execute",
      projectLabel: "acme/widgets",
    });
    await lastDispatched;

    expect(postToSlackChannel).not.toHaveBeenCalled();
  });

  it("no-ops when the integration has no default channel selected", async () => {
    findUnique.mockResolvedValue({
      accessToken: "xoxb-org",
      defaultChannelId: null,
    });

    dispatchLoopCompletedSlackNotification({
      organizationId: ORG_ID,
      loopLabel: "Execute",
      projectLabel: "acme/widgets",
    });
    await lastDispatched;

    expect(postToSlackChannel).not.toHaveBeenCalled();
  });

  it("no-ops without touching the DB when the rollout flag is off", async () => {
    isFeatureFlagEnabledForDistinctId.mockResolvedValue(false);

    dispatchLoopCompletedSlackNotification({
      organizationId: ORG_ID,
      loopLabel: "Execute",
      projectLabel: "acme/widgets",
    });
    await lastDispatched;

    expect(findUnique).not.toHaveBeenCalled();
    expect(postToSlackChannel).not.toHaveBeenCalled();
  });

  it("fails closed when flag evaluation throws", async () => {
    isFeatureFlagEnabledForDistinctId.mockRejectedValue(new Error("posthog"));

    dispatchLoopCompletedSlackNotification({
      organizationId: ORG_ID,
      loopLabel: "Execute",
      projectLabel: "acme/widgets",
    });
    await lastDispatched;

    expect(findUnique).not.toHaveBeenCalled();
    expect(postToSlackChannel).not.toHaveBeenCalled();
  });
});
