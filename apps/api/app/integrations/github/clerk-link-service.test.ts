import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveGitHubUserIdentity: vi.fn(),
}));

vi.mock("@/lib/github/github-user-credential", () => ({
  resolveGitHubUserIdentity: mocks.resolveGitHubUserIdentity,
}));

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

import {
  GitHubAccessDenialReason,
  GitHubClerkLinkClientFailureStage,
} from "@repo/api/src/types/github";
import { log } from "@repo/observability/log";
import {
  GITHUB_CLERK_LINK_FAILED_EVENT,
  githubClerkLinkFailureThrottle,
  recordClerkLinkClientFailure,
  syncClerkLinkedIdentity,
} from "./clerk-link-service";

describe("syncClerkLinkedIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports linked when identity resolution succeeds", async () => {
    mocks.resolveGitHubUserIdentity.mockResolvedValue({
      ok: true,
      identity: { githubUserId: "9001", login: "octocat" },
    });

    const result = await syncClerkLinkedIdentity({
      organizationId: "org-1",
      userId: "user-1",
      now: new Date("2026-08-18T00:00:00Z"),
    });

    expect(result).toEqual({ linked: true });
    expect(mocks.resolveGitHubUserIdentity).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      now: new Date("2026-08-18T00:00:00Z"),
    });
  });

  // The second Clerk read this used to make is gone: with the stored fallback
  // removed, the identity path reports Clerk's own reason, so an
  // insufficient_scope grant the user just approved can no longer arrive here
  // flattened into not_connected.
  it.each([
    GitHubAccessDenialReason.NotConnected,
    GitHubAccessDenialReason.InsufficientScope,
    GitHubAccessDenialReason.Revoked,
    GitHubAccessDenialReason.Unavailable,
  ])("returns the %s denial verbatim on the wire", async (denial) => {
    mocks.resolveGitHubUserIdentity.mockResolvedValue({ ok: false, denial });

    const result = await syncClerkLinkedIdentity({
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({ linked: false, reason: denial });
  });
});

/**
 * ISS-10459. A failed GitHub link used to leave no server-side record at all:
 * the route handed the denial to the browser, `no-client-debug-logging` bans a
 * browser-side log on this path, and this service had no observability import.
 * These pin the emission a Datadog monitor now keys on. Deleting either log
 * call turns the denial and thrown-sync cases red; the success case is their
 * negative control and stays green by design.
 */
describe("syncClerkLinkedIdentity failure telemetry", () => {
  const SCOPE = { organizationId: "org-1", userId: "user-1" };
  const T0 = new Date("2026-09-22T00:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    // Module-level throttle: without this, a failure recorded by an earlier
    // case suppresses the same (org, outcome) key here and the case passes or
    // fails on file order alone.
    githubClerkLinkFailureThrottle.clear();
  });

  function recordsFor(
    level: "warn" | "error"
  ): [string, Record<string, unknown>][] {
    const calls = vi.mocked(log[level]).mock.calls as unknown as [
      string,
      Record<string, unknown>,
    ][];
    return calls.filter(([name]) => name === GITHUB_CLERK_LINK_FAILED_EVENT);
  }

  it("keeps the event name the monitor queries", () => {
    expect(GITHUB_CLERK_LINK_FAILED_EVENT).toBe("github_clerk_link_failed");
  });

  it.each([
    GitHubAccessDenialReason.NotConnected,
    GitHubAccessDenialReason.Revoked,
    GitHubAccessDenialReason.OrgRestricted,
    GitHubAccessDenialReason.Unavailable,
  ])("reports the %s denial on the monitored event", async (denial) => {
    mocks.resolveGitHubUserIdentity.mockResolvedValue({
      ok: false,
      denial,
    });

    await syncClerkLinkedIdentity(SCOPE);

    // Asserted from the test body after the real entry point ran, never from
    // inside the mock: a mock that checks its own arguments stays green against
    // a service that never calls it.
    expect(recordsFor("warn")).toEqual([
      [
        GITHUB_CLERK_LINK_FAILED_EVENT,
        {
          event: GITHUB_CLERK_LINK_FAILED_EVENT,
          organizationId: "org-1",
          userId: "user-1",
          suppressedSincePreviousEmission: 0,
          reason: denial,
        },
      ],
    ]);
    expect(recordsFor("error")).toHaveLength(0);
  });

  it("reports a thrown sync at error severity and rethrows it", async () => {
    const failure = new Error("clerk unreachable");
    mocks.resolveGitHubUserIdentity.mockRejectedValue(failure);

    await expect(syncClerkLinkedIdentity(SCOPE)).rejects.toBe(failure);

    expect(recordsFor("error")).toEqual([
      [
        GITHUB_CLERK_LINK_FAILED_EVENT,
        {
          event: GITHUB_CLERK_LINK_FAILED_EVENT,
          organizationId: "org-1",
          userId: "user-1",
          suppressedSincePreviousEmission: 0,
          error: "clerk unreachable",
        },
      ],
    ]);
    // Severity is the discriminator the monitor's triage reads: a throw landing
    // on `warn` would file an unexpected cl-api fault among the denials.
    expect(recordsFor("warn")).toHaveLength(0);
  });

  /**
   * The leak this forecloses is a later `...result` / `...input` spread, or
   * handing `log.error` the error OBJECT — an Octokit/Clerk rejection carries
   * its request config, and with it the bearer token — instead of
   * `parseError`'s message. Pinning the exact key set is what makes either
   * mutation red; `reason` is the closed `GitHubAccessDenialReason` set and the
   * two ids are opaque, so the intended record has nothing sensitive in it.
   */
  it("carries only the closed record shape, with no credential in reach", async () => {
    const tokenBearing = Object.assign(new Error("request failed"), {
      config: { headers: { authorization: "Bearer gho_notatoken" } },
      token: "gho_notatoken",
    });
    mocks.resolveGitHubUserIdentity.mockRejectedValue(tokenBearing);

    await expect(syncClerkLinkedIdentity(SCOPE)).rejects.toBe(tokenBearing);

    const [[, meta]] = recordsFor("error");
    expect(Object.keys(meta).sort()).toEqual([
      "error",
      "event",
      "organizationId",
      "suppressedSincePreviousEmission",
      "userId",
    ]);
    expect(meta.error).toBe("request failed");
    expect(JSON.stringify(meta)).not.toContain("gho_notatoken");
  });

  /**
   * apps/api/AGENTS.md "Emission and Abuse Control": any signed-in caller can
   * drive this route, so emission is bounded per (org, outcome) per window.
   * Three calls on one key pin all three halves — the first emits, a repeat
   * inside the window does not, and the next window's emission carries the
   * folded count rather than dropping it.
   */
  it("folds repeats on one org and reason inside a window, then counts them", async () => {
    mocks.resolveGitHubUserIdentity.mockResolvedValue({
      ok: false,
      denial: GitHubAccessDenialReason.NotConnected,
    });

    await syncClerkLinkedIdentity({ ...SCOPE, now: T0 });
    await syncClerkLinkedIdentity({
      ...SCOPE,
      now: new Date(T0.getTime() + 1000),
    });
    expect(recordsFor("warn")).toHaveLength(1);

    await syncClerkLinkedIdentity({
      ...SCOPE,
      now: new Date(T0.getTime() + 61_000),
    });
    const records = recordsFor("warn");
    expect(records).toHaveLength(2);
    expect(records[1]?.[1]).toMatchObject({
      reason: GitHubAccessDenialReason.NotConnected,
      suppressedSincePreviousEmission: 1,
    });
  });

  it("keeps a different reason on the same org reportable inside the window", async () => {
    mocks.resolveGitHubUserIdentity
      .mockResolvedValueOnce({
        ok: false,
        denial: GitHubAccessDenialReason.NotConnected,
      })
      .mockResolvedValueOnce({
        ok: false,
        denial: GitHubAccessDenialReason.Revoked,
      });

    await syncClerkLinkedIdentity({ ...SCOPE, now: T0 });
    await syncClerkLinkedIdentity({
      ...SCOPE,
      now: new Date(T0.getTime() + 1000),
    });

    // Keyed on org alone, the second outcome would be folded into the first and
    // the monitor would never see that this org's links are also being revoked.
    expect(recordsFor("warn").map(([, meta]) => meta.reason)).toEqual([
      GitHubAccessDenialReason.NotConnected,
      GitHubAccessDenialReason.Revoked,
    ]);
  });

  /**
   * The bound is per ORG, not per user: any member of the org can drive the
   * route, so a per-user key would let one org multiply its emission by its
   * member count. Every other case here uses one `userId`, which cannot tell
   * the two keys apart — two users on the same org and reason are what make a
   * widened `org|user|reason` key go red.
   */
  it("folds a second user on the same org and reason into the first", async () => {
    mocks.resolveGitHubUserIdentity.mockResolvedValue({
      ok: false,
      denial: GitHubAccessDenialReason.NotConnected,
    });

    await syncClerkLinkedIdentity({ ...SCOPE, now: T0 });
    await syncClerkLinkedIdentity({
      organizationId: SCOPE.organizationId,
      userId: "user-2",
      now: new Date(T0.getTime() + 1000),
    });

    expect(recordsFor("warn").map(([, meta]) => meta.userId)).toEqual([
      "user-1",
    ]);
  });

  /**
   * The one denial that is not yet a failure. The linking page answers a
   * narrow grant by sending the user through GitHub's consent screen and
   * calling this route again, so recording the first one pages prod for a
   * connect that then works.
   */
  it("holds back the insufficient_scope the page answers by re-linking", async () => {
    mocks.resolveGitHubUserIdentity.mockResolvedValue({
      ok: false,
      denial: GitHubAccessDenialReason.InsufficientScope,
    });

    await expect(syncClerkLinkedIdentity(SCOPE)).resolves.toEqual({
      linked: false,
      reason: GitHubAccessDenialReason.InsufficientScope,
    });

    // The wire verdict is unchanged — only the record waits.
    expect(recordsFor("warn")).toHaveLength(0);
    expect(recordsFor("error")).toHaveLength(0);
  });

  it("reports an insufficient_scope that survived the consent round", async () => {
    mocks.resolveGitHubUserIdentity.mockResolvedValue({
      ok: false,
      denial: GitHubAccessDenialReason.InsufficientScope,
    });

    await syncClerkLinkedIdentity({ ...SCOPE, relinkAttempted: true });

    expect(recordsFor("warn")).toEqual([
      [
        GITHUB_CLERK_LINK_FAILED_EVENT,
        {
          event: GITHUB_CLERK_LINK_FAILED_EVENT,
          organizationId: "org-1",
          userId: "user-1",
          suppressedSincePreviousEmission: 0,
          reason: GitHubAccessDenialReason.InsufficientScope,
        },
      ],
    ]);
  });

  /**
   * Why holding back is not enough on its own, and why it has to happen
   * BEFORE the throttle records the key. The bound is per
   * `(org, insufficient_scope)` for 60s, and a consent round trip is faster
   * than that — so a service that records the benign attempt folds the
   * terminal one behind it away, and the monitor sees the link that worked
   * instead of the one that did not. Two members, because one `userId`
   * cannot tell the folded record from the reported one.
   */
  it("keeps a terminal denial reportable behind another member's re-link", async () => {
    mocks.resolveGitHubUserIdentity.mockResolvedValue({
      ok: false,
      denial: GitHubAccessDenialReason.InsufficientScope,
    });

    await syncClerkLinkedIdentity({ ...SCOPE, now: T0 });
    await syncClerkLinkedIdentity({
      organizationId: SCOPE.organizationId,
      userId: "user-2",
      relinkAttempted: true,
      now: new Date(T0.getTime() + 5000),
    });

    expect(recordsFor("warn").map(([, meta]) => meta.userId)).toEqual([
      "user-2",
    ]);
  });

  it("emits nothing when the link succeeds", async () => {
    mocks.resolveGitHubUserIdentity.mockResolvedValue({
      ok: true,
      identity: { githubUserId: "9001", login: "octocat" },
    });

    await expect(syncClerkLinkedIdentity(SCOPE)).resolves.toEqual({
      linked: true,
    });

    // Without this, an unconditional emitter would satisfy every case above.
    expect(recordsFor("warn")).toHaveLength(0);
    expect(recordsFor("error")).toHaveLength(0);
  });
});

/**
 * ISS-11244: the browser-reported half of the same monitored event. The GitHub
 * hand-off leg never reaches this API, so before this a refusal there was
 * recorded nowhere — the user saw the unrecognised-shape sentence and no alert
 * could see it. These pin the emission and the one hazard of sharing a throttle
 * with the sync leg.
 */
describe("recordClerkLinkClientFailure", () => {
  const SCOPE = {
    organizationId: "org-9",
    stage: GitHubClerkLinkClientFailureStage.Threw,
    userId: "user-9",
  };
  const T0 = new Date("2026-09-26T00:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    githubClerkLinkFailureThrottle.clear();
  });

  function warnRecords(): [string, Record<string, unknown>][] {
    const calls = vi.mocked(log.warn).mock.calls as unknown as [
      string,
      Record<string, unknown>,
    ][];
    return calls.filter(([name]) => name === GITHUB_CLERK_LINK_FAILED_EVENT);
  }

  // `toEqual` on the whole payload rather than field-by-field: a key-by-key
  // assertion stays green when a later edit adds a field, and what must never
  // appear here is precisely a field nobody named.
  it("records the Clerk code the browser saw, and nothing more", () => {
    recordClerkLinkClientFailure({
      ...SCOPE,
      clerkErrorCode: "external_account_exists",
      now: T0,
    });

    expect(warnRecords()).toHaveLength(1);
    expect(warnRecords()[0][1]).toEqual({
      clerkErrorCode: "external_account_exists",
      event: GITHUB_CLERK_LINK_FAILED_EVENT,
      organizationId: "org-9",
      source: "client",
      stage: GitHubClerkLinkClientFailureStage.Threw,
      suppressedSincePreviousEmission: 0,
      userId: "user-9",
    });
    expect(vi.mocked(log.error)).not.toHaveBeenCalled();
  });

  // Cross-repo rule: an absent optional field is OMITTED, never serialized as
  // `null`. A `null` here would land in the monitor's facet as a value.
  /**
   * ISS-11244, raised by tamsinb on #7968: `ApiError` carries no `errors[]`
   * array at all, so before these fields every sync-leg throw reached the
   * monitor as one codeless record — a client deadline, an expired session and
   * a refused POST indistinguishable, on the leg the ticket most needed named.
   * `toEqual` on the whole payload, so a field nobody named cannot slip in.
   */
  it("records the API status and code the sync leg refused with", () => {
    recordClerkLinkClientFailure({
      ...SCOPE,
      apiErrorCode: "client_request_timeout",
      apiErrorStatus: 0,
      now: T0,
    });

    expect(warnRecords()).toHaveLength(1);
    expect(warnRecords()[0][1]).toEqual({
      apiErrorCode: "client_request_timeout",
      apiErrorStatus: 0,
      event: GITHUB_CLERK_LINK_FAILED_EVENT,
      organizationId: "org-9",
      source: "client",
      stage: GitHubClerkLinkClientFailureStage.Threw,
      suppressedSincePreviousEmission: 0,
      userId: "user-9",
    });
  });

  /**
   * The three stages that resolve WITHOUT an error carry no code by
   * construction, so `stage` is the only thing separating them. Without it the
   * record says a browser failed and nothing about where.
   */
  it("records the stage for a failure that carried no error at all", () => {
    recordClerkLinkClientFailure({
      ...SCOPE,
      now: T0,
      stage: GitHubClerkLinkClientFailureStage.ReauthorizeNoConsentUrl,
    });

    expect(warnRecords()).toHaveLength(1);
    expect(warnRecords()[0][1]).toHaveProperty(
      "stage",
      GitHubClerkLinkClientFailureStage.ReauthorizeNoConsentUrl
    );
    expect(warnRecords()[0][1]).not.toHaveProperty("apiErrorCode");
    expect(warnRecords()[0][1]).not.toHaveProperty("apiErrorStatus");
  });

  it("omits the code entirely when the throw carried none", () => {
    recordClerkLinkClientFailure({ ...SCOPE, now: T0 });

    expect(warnRecords()).toHaveLength(1);
    expect(warnRecords()[0][1]).not.toHaveProperty("clerkErrorCode");
    expect(warnRecords()[0][1]).toHaveProperty("source", "client");
  });

  /**
   * THE AMPLIFICATION BOUND, and the reason the code is not in the throttle key.
   *
   * `clerkErrorCode` is a string a BROWSER chose, and any signed-in caller can
   * drive this route. With the code in the key every request would be a key the
   * throttle had never seen, and an unseen key always emits — so one caller could
   * fire the monitored event without bound and, sharing this map with the sync
   * leg, evict real orgs' entries whose suppressed counts are then dropped.
   * `apps/api/AGENTS.md` "Emission and Abuse Control" names exactly this vector.
   *
   * Two DIFFERENT codes is the case that matters: identical codes would fold even
   * on the broken key, so this is the mutation-killing shape.
   */
  it("bounds emission per org however the caller varies the code", () => {
    recordClerkLinkClientFailure({
      ...SCOPE,
      clerkErrorCode: "external_account_exists",
      now: T0,
    });
    recordClerkLinkClientFailure({
      ...SCOPE,
      clerkErrorCode: "a_completely_different_code",
      now: new Date(T0.getTime() + 1000),
    });

    expect(warnRecords()).toHaveLength(1);
    expect(warnRecords()[0][1]).toHaveProperty(
      "clerkErrorCode",
      "external_account_exists"
    );
  });

  // A browser-supplied string reaches a monitor facet, so it is held to Clerk's
  // own snake_case identifier shape and folded to a sentinel otherwise. Folded
  // rather than REFUSED at the route: a report this API cannot otherwise make is
  // worth more than the spelling of a code that was not Clerk's.
  it.each([
    ["Something interrupted\nfake_log_line", "unrecognized"],
    ["UPPER_CASE", "unrecognized"],
    ["has spaces", "unrecognized"],
    ["identification_deletion_failed", "identification_deletion_failed"],
  ])("normalizes a reported code %j to %j", (reported, expected) => {
    recordClerkLinkClientFailure({
      ...SCOPE,
      clerkErrorCode: reported,
      now: T0,
    });

    expect(warnRecords()).toHaveLength(1);
    expect(warnRecords()[0][1]).toHaveProperty("clerkErrorCode", expected);
  });

  /**
   * THE HAZARD OF ONE THROTTLE FOR TWO PRODUCERS: a browser report must not fold
   * away a genuine server-side denial for the same customer, because the folded
   * one is the record carrying the actionable reason.
   *
   * What this pins is that both halves stay reportable in one window — NOT that
   * the `client:` namespace is what separates them. It cannot pin that: the
   * client key no longer contains a code at all, so a collision with a
   * `GitHubAccessDenialReason` value is impossible by construction rather than
   * by naming. The report below deliberately carries a code EQUAL to the denial
   * reason to show that is now inert.
   */
  it("does not suppress the sync leg's denial for the same org", async () => {
    recordClerkLinkClientFailure({
      ...SCOPE,
      clerkErrorCode: GitHubAccessDenialReason.NotConnected,
      now: T0,
    });
    mocks.resolveGitHubUserIdentity.mockResolvedValue({
      ok: false,
      denial: GitHubAccessDenialReason.NotConnected,
    });

    await syncClerkLinkedIdentity({ ...SCOPE, now: T0 });

    const records = warnRecords();
    expect(records).toHaveLength(2);
    expect(records[1][1]).toHaveProperty(
      "reason",
      GitHubAccessDenialReason.NotConnected
    );
  });
});
