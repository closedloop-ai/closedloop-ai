import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sweep: vi.fn(), auth: vi.fn() }));
vi.mock("@/app/artifact-links/service", () => ({
  artifactLinksService: { sweepExpiredTreePages: mocks.sweep },
}));
vi.mock("@/lib/auth/cron-secret", () => ({ validateCronSecret: mocks.auth }));

import {
  GET,
  maxDuration,
} from "@/app/cron/cleanup-artifact-link-tree-pages/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockReturnValue(null);
  mocks.sweep.mockResolvedValue(12);
});

describe("tree snapshot retention route", () => {
  it("sweeps only an authenticated invocation", async () => {
    expect(maxDuration).toBe(300);
    const request = new Request(
      "http://api.test/cron/cleanup-artifact-link-tree-pages"
    );
    mocks.auth.mockReturnValueOnce(new Response(null, { status: 401 }));
    expect((await GET(request)).status).toBe(401);
    expect(mocks.sweep).not.toHaveBeenCalled();
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(mocks.sweep).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ data: { deleted: 12 } });
  });

  it("reports a failed sweep as an error", async () => {
    mocks.sweep.mockRejectedValue(new Error("database unavailable"));
    expect(
      (
        await GET(
          new Request("http://api.test/cron/cleanup-artifact-link-tree-pages")
        )
      ).status
    ).toBe(500);
  });
});
