import { log } from "@repo/observability/log";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RouteUtils from "@/lib/route-utils";

const { mockValidateGitHubOidcToken } = vi.hoisted(() => ({
  mockValidateGitHubOidcToken: vi.fn(),
}));

vi.mock("@/lib/auth/github-oidc-auth", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/github-oidc-auth")
  >("@/lib/auth/github-oidc-auth");
  return { ...actual, validateGitHubOidcToken: mockValidateGitHubOidcToken };
});

vi.mock("@/lib/route-utils", async () => {
  const actual = await vi.importActual<typeof RouteUtils>("@/lib/route-utils");
  return { ...actual, scheduleLogFlush: vi.fn() };
});

import {
  bodyOfBytes,
  PROBE_BRANCH,
} from "@/__tests__/support/preview-schemas/request-bodies";
import { PREVIEW_SCHEMA_REQUEST_MAX_BYTES } from "@/app/preview-schemas/constants";
import { POST as ensurePost } from "@/app/preview-schemas/ensure/route";
import {
  PREVIEW_SCHEMA_REQUEST_BODY_OVER_CAP_EVENT,
  previewSchemaRequestBodyOverCapThrottle,
} from "@/app/preview-schemas/request-body";
import { POST as cleanupPost } from "@/app/preview-schemas/route";
import { POST as seedPost } from "@/app/preview-schemas/seed/route";

const OVER_CAP_BODY = JSON.stringify(
  bodyOfBytes({ branch: PROBE_BRANCH }, PREVIEW_SCHEMA_REQUEST_MAX_BYTES + 1)
);

// ISS-11034: every route on this surface has to reach the monitored event, so
// each is driven through its real handler. The throttle and the at-cap control
// are pinned in `preview-schemas-route.test.ts`.
describe("preview schema routes report a 413 to the monitored event", () => {
  beforeEach(() => {
    previewSchemaRequestBodyOverCapThrottle.clear();
    mockValidateGitHubOidcToken.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["/preview-schemas", cleanupPost],
    ["/preview-schemas/ensure", ensurePost],
    ["/preview-schemas/seed", seedPost],
  ] as const)("%s", async (route, post) => {
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const request = new Request(`https://api.stage.example${route}`, {
      method: "POST",
      body: OVER_CAP_BODY,
    });

    const response = await post(request as NextRequest);

    expect(response.status).toBe(413);
    expect(errorLog).toHaveBeenCalledWith(
      PREVIEW_SCHEMA_REQUEST_BODY_OVER_CAP_EVENT,
      { route, maxBytes: PREVIEW_SCHEMA_REQUEST_MAX_BYTES, occurrences: 1 }
    );
  });
});
