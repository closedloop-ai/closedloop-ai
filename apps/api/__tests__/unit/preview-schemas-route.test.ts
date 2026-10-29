import { BRANCH_NAME_MAX_LENGTH } from "@repo/api/src/types/artifact";
import { makeCounters } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RouteUtils from "@/lib/route-utils";

const { mockScheduleLogFlush, mockValidateGitHubOidcToken } = vi.hoisted(
  () => ({
    mockScheduleLogFlush: vi.fn(),
    mockValidateGitHubOidcToken: vi.fn(),
  })
);

vi.mock("@/lib/auth/github-oidc-auth", () => ({
  validateGitHubOidcToken: mockValidateGitHubOidcToken,
}));

vi.mock("@/lib/route-utils", async () => {
  const actual = await vi.importActual<typeof RouteUtils>("@/lib/route-utils");
  return {
    ...actual,
    scheduleLogFlush: mockScheduleLogFlush,
  };
});

vi.mock("@/app/preview-schemas/service", () => ({
  previewSchemaCleanupService: {
    dropSchemaForBranch: vi.fn(),
    runDailySweep: vi.fn(),
    runDryRun: vi.fn(),
  },
}));

import {
  bodyOfBytes,
  PROBE_BRANCH,
} from "@/__tests__/support/preview-schemas/request-bodies";
import { PREVIEW_SCHEMA_REQUEST_MAX_BYTES } from "@/app/preview-schemas/constants";
import {
  PREVIEW_SCHEMA_REQUEST_BODY_OVER_CAP_EVENT,
  previewSchemaRequestBodyOverCapThrottle,
} from "@/app/preview-schemas/request-body";
import { POST } from "@/app/preview-schemas/route";
import type { DryRunResult, SweepResult } from "@/app/preview-schemas/service";
import { previewSchemaCleanupService } from "@/app/preview-schemas/service";
import { emptyVibeObjectCleanupReport } from "@/app/preview-schemas/service/vibe-object-cleanup";
import {
  EmissionRollupCause,
  FIXED_WINDOW_EMISSION_WINDOW_MS,
} from "@/lib/observability/fixed-window-emission-throttle";

/** Never asserted on — only enough shape for the route to answer 200. */
const DROPPED = {
  schemaName: `preview_${PROBE_BRANCH}`,
  dropped: true,
  alreadyGone: false,
  error: null,
};

/** Never asserted on — only enough shape for the route to answer 200. */
const SWEPT: SweepResult = {
  summary: "summary",
  counters: makeCounters(),
  vibeObjects: emptyVibeObjectCleanupReport(),
  exitCode: 0,
};

/** Never asserted on — only enough shape for the route to answer 200. */
const DRY_RUN: DryRunResult = {
  summary: "dry-run summary",
  wouldDropStale: [],
  wouldDropOrphaned: [],
  wouldDropOrphanBranch: [],
  wouldKeepInGrace: [],
  withheldByMassDropCap: [],
  keptActive: [],
  counters: makeCounters(),
};

function cleanupRequest(body: unknown) {
  const request = new Request("https://api.closedloop.ai/preview-schemas", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return request as Parameters<typeof POST>[0];
}

describe("preview schema cleanup route", () => {
  // Armed here, not per test: `vi.clearAllMocks` clears calls but NOT
  // implementations, so a value set by one case would otherwise survive into
  // the next and let a test that forgot to arm auth pass fully authenticated.
  beforeEach(() => {
    previewSchemaRequestBodyOverCapThrottle.clear();
    mockValidateGitHubOidcToken.mockResolvedValue(null);
    vi.mocked(
      previewSchemaCleanupService.dropSchemaForBranch
    ).mockResolvedValue(DROPPED);
    vi.mocked(previewSchemaCleanupService.runDailySweep).mockResolvedValue(
      SWEPT
    );
    vi.mocked(previewSchemaCleanupService.runDryRun).mockResolvedValue(DRY_RUN);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("leaves the terminal log flush to withRequestCompleted on an OIDC auth error", async () => {
    mockValidateGitHubOidcToken.mockResolvedValue(
      new Response("Unauthorized", { status: 401 })
    );

    const response = await POST(cleanupRequest({ dryRun: true }));

    expect(response.status).toBe(401);
    expect(mockScheduleLogFlush).not.toHaveBeenCalled();
  });

  /**
   * ISS-8139 section A item 1, review (whitlockk). `github-oidc-auth.test.ts` pins
   * that the DEFAULT caller accepts a feature-ref cleanup token, but it calls
   * the validator directly; this suite drives the route but MOCKS the validator
   * and never read its arguments. So the wiring between the two halves was
   * unpinned, and naming a ref-pinned caller HERE — the "hardening" that makes
   * this route match its `ensure`/`seed` siblings — would leave both suites
   * green while operator dispatch from any branch but `main` began answering
   * 403.
   *
   * The request alone is the whole expected argument list, so a caller added as
   * a second argument fails this on arity. Which caller the DEFAULT then
   * resolves to is the other half, and stays in `github-oidc-auth.test.ts`.
   */
  it("authenticates through the default caller, naming none of its own", async () => {
    const request = cleanupRequest({});

    await POST(request);

    expect(mockValidateGitHubOidcToken).toHaveBeenCalledOnce();
    expect(mockValidateGitHubOidcToken).toHaveBeenCalledWith(request);
  });

  it("accepts a branch at the shared name bound and rejects one past it", async () => {
    const accepted = await POST(
      cleanupRequest({ branch: "a".repeat(BRANCH_NAME_MAX_LENGTH) })
    );
    expect(accepted.status).toBe(200);
    expect(
      previewSchemaCleanupService.dropSchemaForBranch
    ).toHaveBeenCalledWith("a".repeat(BRANCH_NAME_MAX_LENGTH));

    vi.mocked(previewSchemaCleanupService.dropSchemaForBranch).mockClear();
    const rejected = await POST(
      cleanupRequest({ branch: "a".repeat(BRANCH_NAME_MAX_LENGTH + 1) })
    );

    expect(rejected.status).toBe(400);
    expect(
      previewSchemaCleanupService.dropSchemaForBranch
    ).not.toHaveBeenCalled();
  });

  it("rejects a branch outside the shared character class", async () => {
    const rejected = await POST(cleanupRequest({ branch: "@@@" }));

    expect(rejected.status).toBe(400);
    expect(
      previewSchemaCleanupService.dropSchemaForBranch
    ).not.toHaveBeenCalled();
  });

  it("redacts credential-bearing drop-failure text out of the reflected error", async () => {
    vi.mocked(
      previewSchemaCleanupService.dropSchemaForBranch
    ).mockResolvedValue({
      ...DROPPED,
      dropped: false,
      error:
        "DROP SCHEMA failed: postgres://vercel_iam:pw-that-must-not-escape@db.internal.example.com:5432/symphony",
    });

    const response = await POST(cleanupRequest({ branch: PROBE_BRANCH }));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("pw-that-must-not-escape");
    expect(body).not.toContain("db.internal.example.com");
    expect(body).toContain("[redacted sensitive value]");
  });

  it("leaves drop-failure text carrying no credential unmarked", async () => {
    vi.mocked(
      previewSchemaCleanupService.dropSchemaForBranch
    ).mockResolvedValue({
      ...DROPPED,
      dropped: false,
      error: "DROP SCHEMA failed: permission denied for schema",
    });

    const response = await POST(cleanupRequest({ branch: PROBE_BRANCH }));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("permission denied for schema");
    expect(body).not.toContain("[redacted sensitive value]");
  });

  it("answers a thrown sweep with a fixed message instead of the throw text", async () => {
    vi.mocked(previewSchemaCleanupService.runDailySweep).mockRejectedValue(
      new Error(
        'connection to server at "db.internal.example.com" port 5432 failed'
      )
    );

    const response = await POST(cleanupRequest({}));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("db.internal.example.com");
    expect(body).toContain(
      "Unexpected failure while cleaning up preview schemas"
    );
  });

  it("accepts a body at the request cap and refuses one past it", async () => {
    const atCap = bodyOfBytes(
      { branch: PROBE_BRANCH },
      PREVIEW_SCHEMA_REQUEST_MAX_BYTES
    );
    expect(JSON.stringify(atCap).length).toBe(PREVIEW_SCHEMA_REQUEST_MAX_BYTES);

    expect((await POST(cleanupRequest(atCap))).status).toBe(200);
    expect(
      previewSchemaCleanupService.dropSchemaForBranch
    ).toHaveBeenCalledWith(PROBE_BRANCH);

    vi.mocked(previewSchemaCleanupService.dropSchemaForBranch).mockClear();
    const refused = await POST(
      cleanupRequest(
        bodyOfBytes(
          { branch: PROBE_BRANCH },
          PREVIEW_SCHEMA_REQUEST_MAX_BYTES + 1
        )
      )
    );

    expect(refused.status).toBe(413);
    expect(
      previewSchemaCleanupService.dropSchemaForBranch
    ).not.toHaveBeenCalled();
  });

  it("reports a 413 to the monitored event once per window, without the body", async () => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const overCapEvents = () =>
      errorLog.mock.calls.filter(
        ([event]) => event === PREVIEW_SCHEMA_REQUEST_BODY_OVER_CAP_EVENT
      );

    const atCap = bodyOfBytes(
      { branch: PROBE_BRANCH },
      PREVIEW_SCHEMA_REQUEST_MAX_BYTES
    );
    expect((await POST(cleanupRequest(atCap))).status).toBe(200);
    expect(overCapEvents()).toEqual([]);

    const overCap = bodyOfBytes(
      { branch: PROBE_BRANCH },
      PREVIEW_SCHEMA_REQUEST_MAX_BYTES + 1
    );
    expect((await POST(cleanupRequest(overCap))).status).toBe(413);
    expect((await POST(cleanupRequest(overCap))).status).toBe(413);

    expect(overCapEvents()).toEqual([
      [
        PREVIEW_SCHEMA_REQUEST_BODY_OVER_CAP_EVENT,
        {
          route: "/preview-schemas",
          maxBytes: PREVIEW_SCHEMA_REQUEST_MAX_BYTES,
          occurrences: 1,
        },
      ],
    ]);
  });

  it("flushes a suppressed 413 on the next in-cap request once the window closes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const overCap = bodyOfBytes(
      { branch: PROBE_BRANCH },
      PREVIEW_SCHEMA_REQUEST_MAX_BYTES + 1
    );
    expect((await POST(cleanupRequest(overCap))).status).toBe(413);
    expect((await POST(cleanupRequest(overCap))).status).toBe(413);
    errorLog.mockClear();

    vi.setSystemTime(Date.now() + FIXED_WINDOW_EMISSION_WINDOW_MS);
    const atCap = bodyOfBytes(
      { branch: PROBE_BRANCH },
      PREVIEW_SCHEMA_REQUEST_MAX_BYTES
    );
    expect((await POST(cleanupRequest(atCap))).status).toBe(200);

    expect(
      errorLog.mock.calls.filter(
        ([event]) => event === PREVIEW_SCHEMA_REQUEST_BODY_OVER_CAP_EVENT
      )
    ).toEqual([
      [
        PREVIEW_SCHEMA_REQUEST_BODY_OVER_CAP_EVENT,
        {
          route: "/preview-schemas",
          maxBytes: PREVIEW_SCHEMA_REQUEST_MAX_BYTES,
          occurrences: 1,
          aggregated: true,
          flushedBy: EmissionRollupCause.Expiry,
        },
      ],
    ]);
  });

  /**
   * The guard exists because the two flags select mutually exclusive arms and
   * `branch` is tested first: without the refusal a request carrying both
   * silently takes the branch-drop path, so an operator who asked for a dry run
   * gets a real DROP.
   */
  it("refuses branch combined with dryRun instead of dropping the branch schema", async () => {
    const response = await POST(
      cleanupRequest({ branch: PROBE_BRANCH, dryRun: true })
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "Combining branch with dryRun is not supported"
    );
    expect(
      previewSchemaCleanupService.dropSchemaForBranch
    ).not.toHaveBeenCalled();
    expect(previewSchemaCleanupService.runDryRun).not.toHaveBeenCalled();
  });

  // Positive control for the two dry-run cases below: without it, a mistake
  // that made the dry-run arm unreachable would satisfy them vacuously.
  it("answers a clean dry-run with the dry-run result", async () => {
    const response = await POST(cleanupRequest({ dryRun: true }));

    expect(response.status).toBe(200);
    // The dry-run RESULT, not merely a 200: this arm and the sweep arm below
    // both answer 200, so the body is what tells them apart.
    expect(await response.json()).toMatchObject({ data: DRY_RUN });
    expect(previewSchemaCleanupService.runDryRun).toHaveBeenCalledOnce();
    expect(
      previewSchemaCleanupService.dropSchemaForBranch
    ).not.toHaveBeenCalled();
    expect(previewSchemaCleanupService.runDailySweep).not.toHaveBeenCalled();
  });

  it("answers a dry-run that hit registry-read errors with a 500 naming the count", async () => {
    const counters = makeCounters();
    counters.registryReadErrored = 1;
    vi.mocked(previewSchemaCleanupService.runDryRun).mockResolvedValue({
      ...DRY_RUN,
      counters,
    });

    const response = await POST(cleanupRequest({ dryRun: true }));

    expect(response.status).toBe(500);
    expect(await response.text()).toContain(
      "Dry-run completed with 1 registry-read error(s)"
    );
  });

  /**
   * The sweep's own exitCode translation. `cleanup-preview-schemas-cron-alert`
   * covers the cron sibling's handling of the same non-zero exitCode, but the
   * two translate it differently (a Slack alert there, a plain 500 here), so
   * that suite cannot stand in for this one.
   */
  it("translates a non-zero sweep exitCode into a 500 carrying the summary", async () => {
    vi.mocked(previewSchemaCleanupService.runDailySweep).mockResolvedValue({
      ...SWEPT,
      summary: "3 dropped, 1 errored",
      exitCode: 1,
    });

    const response = await POST(cleanupRequest({}));

    expect(response.status).toBe(500);
    expect(await response.text()).toContain(
      "Daily sweep completed with errors: 3 dropped, 1 errored"
    );
  });
});
