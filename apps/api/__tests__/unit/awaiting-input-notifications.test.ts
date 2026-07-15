/**
 * Unit tests for apps/api/lib/awaiting-input-notifications.ts
 *
 * Verifies dispatchAwaitingInputNotification:
 * - no-ops (without touching the DB) when the `emergent` flag is off / throws
 * - sends the in-app inbox notification with a relative session deep-link
 * - DMs the run owner on Slack with an absolute deep-link when both the org's
 *   Slack workspace and the owner's Slack identity are connected
 * - skips only the Slack leg when the workspace or the owner's Slack id is absent
 * - resolves the workspace token via the shared encryption helper, preferring
 *   the KMS-encrypted column so the DM keeps working once plaintext is retired
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_URL = "https://app.example.com";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede all imports
// ---------------------------------------------------------------------------

const isFeatureFlagEnabledForDistinctId = vi.fn();
const slackIntegrationFindUnique = vi.fn();
const userFindUnique = vi.fn();
const postToSlackChannel = vi.fn();
const sendAwaitingInputNotification = vi.fn();
const resolveIntegrationToken = vi.fn();

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
    fn({
      slackIntegration: { findUnique: slackIntegrationFindUnique },
      user: { findUnique: userFindUnique },
    }),
}));

vi.mock("@repo/collaboration/server/inbox-notifications", () => ({
  sendAwaitingInputNotification: (...args: unknown[]) =>
    sendAwaitingInputNotification(...args),
}));

vi.mock("@/lib/slack-notifier", () => ({
  postToSlackChannel: (...args: unknown[]) => postToSlackChannel(...args),
}));

vi.mock("@/lib/integration-encryption", () => ({
  resolveIntegrationToken: (...args: unknown[]) =>
    resolveIntegrationToken(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { dispatchAwaitingInputNotification } from "@/lib/awaiting-input-notifications";

const PARAMS = {
  userId: "user-1",
  organizationId: "org-1",
  sessionId: "ses-abc",
  sessionName: "Refactor auth",
};

beforeEach(() => {
  vi.clearAllMocks();
  lastDispatched = undefined;
  // vi.stubEnv restores cleanly via unstubAllEnvs in afterEach — assigning the
  // raw process.env leaks state (and assigning `undefined` stores the STRING
  // "undefined", which is truthy and never exercises the absent-env branch).
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_URL);
  isFeatureFlagEnabledForDistinctId.mockResolvedValue(true);
  slackIntegrationFindUnique.mockResolvedValue({
    accessToken: "xoxb-org",
    accessTokenEncrypted: null,
  });
  // Mirror the real helper: prefer the encrypted column, else the plaintext
  // fallback. Individual tests override to exercise the KMS-encrypted path.
  resolveIntegrationToken.mockImplementation(
    (encrypted: string | null, plaintext: string | null) =>
      Promise.resolve(encrypted ?? plaintext)
  );
  // The gate resolves the owner's clerkId for the multi-identity flag check;
  // the Slack path reads slackId. The single `user.findUnique` mock covers both.
  userFindUnique.mockResolvedValue({ slackId: "U123", clerkId: "clerk-1" });
  postToSlackChannel.mockResolvedValue({ ok: true });
  sendAwaitingInputNotification.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("dispatchAwaitingInputNotification", () => {
  it("sends the in-app inbox notification with the relative session deep-link", async () => {
    dispatchAwaitingInputNotification(PARAMS);
    await lastDispatched;

    expect(sendAwaitingInputNotification).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: "org-1",
      subjectId: "ses-abc",
      sessionTitle: "Refactor auth",
      sessionUrl: "/sessions/ses-abc",
    });
  });

  it("DMs the run owner on Slack with an absolute deep-link", async () => {
    dispatchAwaitingInputNotification(PARAMS);
    await lastDispatched;

    expect(postToSlackChannel).toHaveBeenCalledWith(
      "xoxb-org",
      "U123",
      expect.stringContaining("https://app.example.com/sessions/ses-abc")
    );
    expect(postToSlackChannel).toHaveBeenCalledWith(
      "xoxb-org",
      "U123",
      expect.stringContaining("Refactor auth")
    );
  });

  it("falls back to the relative path in the DM when the app URL is unset", async () => {
    // vi.stubEnv(key, undefined) genuinely REMOVES the var (unlike
    // `process.env.X = undefined`, which stores the truthy string "undefined"
    // and leaves the production base URL falsely present). This exercises the
    // real absent-env fallback branch in toAbsoluteUrl.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);

    dispatchAwaitingInputNotification(PARAMS);
    await lastDispatched;

    // With no base URL the DM must carry the bare relative path — never an
    // "undefined/sessions/..." string built off a truthy "undefined" base.
    expect(postToSlackChannel).toHaveBeenCalledWith(
      "xoxb-org",
      "U123",
      expect.stringContaining("/sessions/ses-abc")
    );
    expect(postToSlackChannel).not.toHaveBeenCalledWith(
      "xoxb-org",
      "U123",
      expect.stringContaining("undefined/sessions/ses-abc")
    );
  });

  it("resolves the KMS-encrypted token via the shared helper once plaintext is retired", async () => {
    // Simulates the post-backfill world the `add_slack_access_token_encrypted`
    // migration moves toward: the plaintext column is gone, only the encrypted
    // one remains. The DM must still fire off the decrypted token.
    slackIntegrationFindUnique.mockResolvedValue({
      accessToken: null,
      accessTokenEncrypted: "cipher",
    });
    resolveIntegrationToken.mockResolvedValue("xoxb-decrypted");

    dispatchAwaitingInputNotification(PARAMS);
    await lastDispatched;

    expect(resolveIntegrationToken).toHaveBeenCalledWith("cipher", null);
    expect(postToSlackChannel).toHaveBeenCalledWith(
      "xoxb-decrypted",
      "U123",
      expect.stringContaining("https://app.example.com/sessions/ses-abc")
    );
  });

  it("skips the Slack DM when the workspace token cannot be resolved", async () => {
    slackIntegrationFindUnique.mockResolvedValue({
      accessToken: null,
      accessTokenEncrypted: null,
    });
    resolveIntegrationToken.mockResolvedValue(null);

    dispatchAwaitingInputNotification(PARAMS);
    await lastDispatched;

    expect(sendAwaitingInputNotification).toHaveBeenCalledTimes(1);
    expect(postToSlackChannel).not.toHaveBeenCalled();
  });

  it("fails closed on the Slack leg when token decryption throws", async () => {
    resolveIntegrationToken.mockRejectedValue(new Error("kms unavailable"));

    dispatchAwaitingInputNotification(PARAMS);
    await lastDispatched;

    // The inbox leg is independent (Promise.allSettled) and still fires; the
    // Slack DM is swallowed by the outer catch rather than rejecting dispatch.
    expect(sendAwaitingInputNotification).toHaveBeenCalledTimes(1);
    expect(postToSlackChannel).not.toHaveBeenCalled();
  });

  it("still sends the inbox notification when the org has no Slack workspace", async () => {
    slackIntegrationFindUnique.mockResolvedValue(null);

    dispatchAwaitingInputNotification(PARAMS);
    await lastDispatched;

    expect(sendAwaitingInputNotification).toHaveBeenCalledTimes(1);
    expect(postToSlackChannel).not.toHaveBeenCalled();
  });

  it("skips the Slack DM when the owner has no linked Slack identity", async () => {
    userFindUnique.mockResolvedValue({ slackId: null });

    dispatchAwaitingInputNotification(PARAMS);
    await lastDispatched;

    expect(sendAwaitingInputNotification).toHaveBeenCalledTimes(1);
    expect(postToSlackChannel).not.toHaveBeenCalled();
  });

  it("no-ops (no inbox, no Slack) when the flag is off for both identities", async () => {
    isFeatureFlagEnabledForDistinctId.mockResolvedValue(false);

    dispatchAwaitingInputNotification(PARAMS);
    await lastDispatched;

    // Both distinct ids are evaluated before failing closed: the internal DB
    // UUID and the resolved Clerk id.
    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      "emergent",
      "user-1"
    );
    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      "emergent",
      "clerk-1"
    );
    // Nothing beyond the clerk-id lookup happens: no inbox entry, no Slack.
    expect(sendAwaitingInputNotification).not.toHaveBeenCalled();
    expect(slackIntegrationFindUnique).not.toHaveBeenCalled();
    expect(postToSlackChannel).not.toHaveBeenCalled();
  });

  it("sends when the rollout targets the owner by Clerk id, not the DB UUID (FEA-2858)", async () => {
    // The internal DB UUID is NOT in the rollout, but the owner's Clerk distinct
    // id — the same id the client Active Runs flag is evaluated against — IS.
    // Without the multi-identity check these users would see Active Runs but get
    // no notifications.
    isFeatureFlagEnabledForDistinctId.mockImplementation(
      (_flag: string, distinctId: string) =>
        Promise.resolve(distinctId === "clerk-1")
    );

    dispatchAwaitingInputNotification(PARAMS);
    await lastDispatched;

    expect(sendAwaitingInputNotification).toHaveBeenCalledTimes(1);
    expect(postToSlackChannel).toHaveBeenCalledTimes(1);
  });

  it("still gates on the DB UUID alone when the owner has no Clerk id", async () => {
    userFindUnique.mockResolvedValue({ slackId: "U123", clerkId: null });
    isFeatureFlagEnabledForDistinctId.mockImplementation(
      (_flag: string, distinctId: string) =>
        Promise.resolve(distinctId === "user-1")
    );

    dispatchAwaitingInputNotification(PARAMS);
    await lastDispatched;

    // Only the internal id is ever evaluated (null clerk id is dropped).
    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      "emergent",
      "user-1"
    );
    expect(isFeatureFlagEnabledForDistinctId).not.toHaveBeenCalledWith(
      "emergent",
      null
    );
    expect(sendAwaitingInputNotification).toHaveBeenCalledTimes(1);
  });

  it("fails closed when flag evaluation throws", async () => {
    isFeatureFlagEnabledForDistinctId.mockRejectedValue(new Error("posthog"));

    dispatchAwaitingInputNotification(PARAMS);
    await lastDispatched;

    expect(sendAwaitingInputNotification).not.toHaveBeenCalled();
    expect(postToSlackChannel).not.toHaveBeenCalled();
  });
});
