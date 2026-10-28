import type { GitHubBackfillSummary } from "@repo/api/src/types/github";
import {
  GitHubBackfillMode,
  GitHubBackfillStatus,
} from "@repo/api/src/types/github";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runPostConnectBackfillMock = vi.fn();
const startPostConnectBackfillMock = vi.fn();
const getLatestBackfillSummaryMock = vi.fn();
const waitUntilMock = vi.fn();
const logErrorMock = vi.fn();

vi.mock("@vercel/functions", () => ({
  waitUntil: waitUntilMock,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: logErrorMock,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    // `errorResponse` schedules a flush; without this the 500 path throws
    // inside the response helper instead of returning the declared shape.
    flush: vi.fn(() => Promise.resolve()),
  },
}));

/**
 * The route's Apply-mode retry gate is a module-level Map keyed by
 * organization, and it survives every request this module serves — that is the
 * production behavior on a warm serverless instance, not a test artifact. A
 * claim it never releases (a sweep still in flight) therefore 429s every later
 * Apply request for the SAME org, so each Apply case below runs as its own org.
 */
let authOrganizationId = "org-1";

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request) =>
      handler({ user: { organizationId: authOrganizationId } }, request),
}));

vi.mock("@/app/integrations/github/backfill-service", () => ({
  githubBackfillService: {
    getLatestBackfillSummary: getLatestBackfillSummaryMock,
    runPostConnectBackfill: runPostConnectBackfillMock,
    startPostConnectBackfill: startPostConnectBackfillMock,
  },
}));

const { GET, POST } = await import("./route");

const EMPTY_CONTEXT = { params: Promise.resolve({}) };
/**
 * A never-resolving sweep stands in for the real one, which measured 90s-180s.
 * If the route ever awaits it again the response never arrives, so these cases
 * carry an explicit short timeout rather than leaning on the runner default.
 */
const NON_BLOCKING_ASSERTION_TIMEOUT_MS = 1000;
/** Mirrors the route's private `BACKFILL_RETRY_COOLDOWN_MS` (30 * 1000). */
const BACKFILL_RETRY_COOLDOWN_SECONDS = 30;

describe("/integrations/github/backfill route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authOrganizationId = "org-1";
    runPostConnectBackfillMock.mockResolvedValue(
      backfillSummary({
        status: GitHubBackfillStatus.OwnerApprovalRequired,
        repositoryCount: 1,
        branchCount: 2,
        pullRequestCount: 3,
      })
    );
    getLatestBackfillSummaryMock.mockResolvedValue(
      backfillSummary({ status: GitHubBackfillStatus.NotStarted })
    );
    startPostConnectBackfillMock.mockResolvedValue({
      claimed: true,
      completion: Promise.resolve(
        backfillSummary({ status: GitHubBackfillStatus.Completed })
      ),
    });
  });

  // Unconditional, so a case that throws between installing and restoring a
  // fake clock cannot hand a frozen one to the rest of this worker.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("POST runs a dry run on the request path and returns its summary", async () => {
    const response = await POST(
      backfillRequest({ repositoryLimit: 1 }),
      EMPTY_CONTEXT
    );
    const body = await response.json();

    // Dry run keeps its 200: it writes nothing and the diff IS the product, so
    // a caller handed a 202 would have no way to read the preview it asked for.
    expect(response.status).toBe(200);
    expect(body.data.summary.repositoryCount).toBe(1);
    expect(runPostConnectBackfillMock).toHaveBeenCalledWith({
      approvedForVisibleWrites: false,
      organizationId: "org-1",
      repositoryLimit: 1,
    });
    expect(waitUntilMock).not.toHaveBeenCalled();
  });

  it(
    "POST apply returns 202 without waiting for the sweep to finish",
    async () => {
      authOrganizationId = "org-non-blocking";
      // The SWEEP never resolves; the claim does. The assertion is that the
      // response depends on the claim and not on the sweep.
      startPostConnectBackfillMock.mockResolvedValue({
        claimed: true,
        completion: new Promise(() => undefined),
      });

      const response = await POST(
        backfillRequest({ mode: GitHubBackfillMode.Apply }),
        EMPTY_CONTEXT
      );
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body.data).toEqual({
        accepted: true,
        status: GitHubBackfillStatus.Running,
      });
      expect(waitUntilMock).toHaveBeenCalledTimes(1);
      expect(startPostConnectBackfillMock).toHaveBeenCalledWith(
        {
          approvedForVisibleWrites: true,
          organizationId: "org-non-blocking",
          repositoryLimit: undefined,
        },
        undefined
      );
    },
    NON_BLOCKING_ASSERTION_TIMEOUT_MS
  );

  it(
    "POST apply still returns 202 when the background sweep fails",
    async () => {
      authOrganizationId = "org-background-failure";
      // The cooldown below is measured against the route's own `Date.now()`.
      // Left on the wall clock, a slow worker between the two POSTs can let the
      // 30s window lapse and turn the 429 back into a 202. `afterEach` restores
      // real timers unconditionally, so a throw here cannot leak the fake clock.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      startPostConnectBackfillMock.mockResolvedValue({
        claimed: true,
        completion: Promise.reject(new Error("provider down")),
      });

      const response = await POST(
        backfillRequest({ mode: GitHubBackfillMode.Apply }),
        EMPTY_CONTEXT
      );
      await waitUntilMock.mock.calls[0]?.[0];

      // Nothing is left to return the failure to, so it has to reach an
      // operator here or nowhere.
      expect(response.status).toBe(202);
      expect(logErrorMock).toHaveBeenCalledWith(
        "github.backfill.background_run_failed",
        expect.objectContaining({ organizationId: "org-background-failure" })
      );

      const retried = await POST(
        backfillRequest({ mode: GitHubBackfillMode.Apply }),
        EMPTY_CONTEXT
      );

      // The completed failure releases the 20-minute in-flight lease. Current
      // behavior deliberately keeps only the short post-run cooldown, which the
      // route sets to BACKFILL_RETRY_COOLDOWN_MS (30s) from the release instant.
      expect(retried.status).toBe(429);
      expect(retried.headers.get("Retry-After")).toBe(
        String(BACKFILL_RETRY_COOLDOWN_SECONDS)
      );
      const retriedBody = await retried.json();
      expect(retriedBody.details.retryAfterSeconds).toBe(
        BACKFILL_RETRY_COOLDOWN_SECONDS
      );
    },
    NON_BLOCKING_ASSERTION_TIMEOUT_MS
  );

  it("rate-limits overlapping visible-write retries for the same organization", async () => {
    authOrganizationId = "org-retry-gate";
    let releaseBackfill: (() => void) | undefined;
    startPostConnectBackfillMock.mockResolvedValue({
      claimed: true,
      completion: new Promise((resolve) => {
        releaseBackfill = () =>
          resolve(backfillSummary({ status: GitHubBackfillStatus.Completed }));
      }),
    });

    const first = await POST(
      backfillRequest({ mode: GitHubBackfillMode.Apply }),
      EMPTY_CONTEXT
    );
    const second = await POST(
      backfillRequest({ mode: GitHubBackfillMode.Apply }),
      EMPTY_CONTEXT
    );

    // The first request has already returned. What holds the gate is the run
    // still in flight in the waitUntil lane, not an unfinished response.
    expect(first.status).toBe(202);
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBeTruthy();
    expect(startPostConnectBackfillMock).toHaveBeenCalledTimes(1);

    releaseBackfill?.();
    await waitUntilMock.mock.calls[0]?.[0];
  });

  it(
    "waits for the durable run claim before answering 202",
    async () => {
      authOrganizationId = "org-claim-ordering";
      let resolveClaim: (() => void) | undefined;
      startPostConnectBackfillMock.mockReturnValue(
        new Promise((resolve) => {
          resolveClaim = () =>
            resolve({ claimed: true, completion: Promise.resolve(null) });
        })
      );

      const pending = POST(
        backfillRequest({ mode: GitHubBackfillMode.Apply }),
        EMPTY_CONTEXT
      );
      // Wait for the claim to be REACHED before judging the response. Without
      // this the assertion below passes on `parseBody`'s own async latency
      // alone, and stays green even if the route answers before claiming.
      await vi.waitFor(() =>
        expect(startPostConnectBackfillMock).toHaveBeenCalled()
      );

      let responded = false;
      pending.then(() => {
        responded = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The claim is what makes the status surface report `running`. If the 202
      // could be written before it commits, the client's first poll could read
      // the PREVIOUS run's terminal status and stop polling for good.
      expect(responded).toBe(false);

      resolveClaim?.();
      expect((await pending).status).toBe(202);
    },
    NON_BLOCKING_ASSERTION_TIMEOUT_MS
  );

  it("releases the retry gate when the durable claim throws", async () => {
    authOrganizationId = "org-claim-throws";
    // Persistent, not `…Once`: `clearAllMocks` clears calls but NOT queued
    // one-shot implementations, so an unconsumed `Once` would leak into the
    // next case. `beforeEach` re-sets the persistent impl, so this cannot.
    startPostConnectBackfillMock.mockRejectedValue(new Error("db down"));

    const failed = await POST(
      backfillRequest({ mode: GitHubBackfillMode.Apply }),
      EMPTY_CONTEXT
    );
    expect(failed.status).toBe(500);

    const retried = await POST(
      backfillRequest({ mode: GitHubBackfillMode.Apply }),
      EMPTY_CONTEXT
    );

    // Still deferred — releasing hands back a short cooldown, not an open gate.
    // The LENGTH is the finding (#5689 review): an unreleased claim holds its
    // 20-minute in-flight lease, so this would tell the caller to wait ~1200s
    // after a transient failure that already cleared. Released, the only thing
    // left is the seconds-scale post-run cooldown.
    expect(retried.status).toBe(429);
    const retryAfterSeconds = Number(retried.headers.get("Retry-After"));
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(retryAfterSeconds).toBeLessThan(60);
  });

  it("reports running when another instance already holds the durable lease", async () => {
    authOrganizationId = "org-durable-contended";
    startPostConnectBackfillMock.mockResolvedValue({
      claimed: false,
      summary: backfillSummary({ status: GitHubBackfillStatus.Completed }),
    });

    const response = await POST(
      backfillRequest({ mode: GitHubBackfillMode.Apply }),
      EMPTY_CONTEXT
    );
    const body = await response.json();

    // A run IS sweeping for this org, so the caller's intent is satisfied.
    expect(response.status).toBe(202);
    expect(body.data.status).toBe(GitHubBackfillStatus.Running);
    expect(waitUntilMock).not.toHaveBeenCalled();
  });

  it("rejects request-body visible write approval", async () => {
    const response = await POST(
      backfillRequest({ approvedForVisibleWrites: true }),
      EMPTY_CONTEXT
    );

    expect(response.status).toBe(400);
    expect(runPostConnectBackfillMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported request fields", async () => {
    const response = await POST(
      backfillRequest({ queueName: "hidden" }),
      EMPTY_CONTEXT
    );

    expect(response.status).toBe(400);
    expect(runPostConnectBackfillMock).not.toHaveBeenCalled();
  });

  it("GET returns the latest persisted summary without rerunning backfill", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3002/integrations/github/backfill"),
      EMPTY_CONTEXT
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.summary.status).toBe(GitHubBackfillStatus.NotStarted);
    expect(getLatestBackfillSummaryMock).toHaveBeenCalledWith("org-1");
    expect(runPostConnectBackfillMock).not.toHaveBeenCalled();
  });

  it("GET reports summary failures with the backfill-specific error", async () => {
    getLatestBackfillSummaryMock.mockRejectedValueOnce(new Error("db down"));

    const response = await GET(
      new NextRequest("http://localhost:3002/integrations/github/backfill"),
      EMPTY_CONTEXT
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to summarize GitHub backfill");
  });
});

function backfillRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3002/integrations/github/backfill", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function backfillSummary(
  overrides: Partial<GitHubBackfillSummary>
): GitHubBackfillSummary {
  return {
    status: GitHubBackfillStatus.NotStarted,
    repositoryCount: 0,
    branchCount: 0,
    pullRequestCount: 0,
    branchProjectionChangeCount: 0,
    pullRequestProjectionChangeCount: 0,
    reviewDecisionProjectionChangeCount: 0,
    checkProjectionChangeCount: 0,
    issueCommentProjectionChangeCount: 0,
    reviewCommentProjectionChangeCount: 0,
    reviewThreadProjectionChangeCount: 0,
    reviewProjectionChangeCount: 0,
    statusCheckProjectionChangeCount: 0,
    skippedBranchCount: 0,
    dryRun: true,
    ownerApprovalRequired: true,
    failures: [],
    ...overrides,
  };
}
