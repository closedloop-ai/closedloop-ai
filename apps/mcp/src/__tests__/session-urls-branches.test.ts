import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionUrlBuilder, ORG_SLUG_TTL_MS } from "../session-urls.js";
import { WEBAPP_URL } from "../tools/tool-utils.js";

vi.mock("@repo/database", () => ({ withDb: vi.fn() }));
vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  },
}));

const ORG_ID = "org-1";
const withDbMock = vi.mocked(withDb);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSessionUrlBuilder", () => {
  it("starts only one background refresh while a previous one is still in flight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let finishRefresh: (value: { slug: string }) => void = () => undefined;
    withDbMock.mockResolvedValueOnce({ slug: "acme" }).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRefresh = resolve;
      })
    );
    const urls = await createSessionUrlBuilder(ORG_ID);

    vi.setSystemTime(Date.now() + ORG_SLUG_TTL_MS / 2 + 1);
    const first = urls.withOrgPrefix("/x");
    const second = urls.withOrgPrefix("/x");

    expect(withDbMock).toHaveBeenCalledTimes(2);
    expect(first).toBe(`${WEBAPP_URL}/acme/x`);
    expect(second).toBe(`${WEBAPP_URL}/acme/x`);

    finishRefresh({ slug: "renamed" });
    await vi.waitFor(() =>
      expect(urls.withOrgPrefix("/x")).toBe(`${WEBAPP_URL}/renamed/x`)
    );
  });

  it("degrades to org-less URLs and stringifies a non-Error lookup failure in the warning", async () => {
    withDbMock.mockRejectedValueOnce("db down");

    const urls = await createSessionUrlBuilder(ORG_ID);

    expect(urls.withOrgPrefix("/x")).toBe(`${WEBAPP_URL}/x`);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "[mcp] org slug resolution failed; webUrls degrade to org-less",
      { organizationId: ORG_ID, error: "db down" }
    );
  });
});
