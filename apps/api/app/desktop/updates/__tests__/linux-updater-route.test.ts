import {
  DesktopReleaseAssetChannels,
  DesktopReleaseChannel,
  DesktopReleaseLinuxUpdaterMetadataAssetName,
} from "@repo/api/src/types/desktop-release";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getElectronUpdaterAssetRedirectUrl: vi.fn(),
  getLatestElectronUpdaterFeed: vi.fn(),
  findUnique: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  env: {} as {
    DESKTOP_INTERNAL_RING_TARGETS?: string;
    DESKTOP_INTERNAL_RING_ORGANIZATIONS?: string;
  },
}));

vi.mock("@repo/github/electron-release", () => ({
  getElectronUpdaterAssetRedirectUrl: mocks.getElectronUpdaterAssetRedirectUrl,
  getLatestElectronUpdaterFeed: mocks.getLatestElectronUpdaterFeed,
}));

vi.mock("@repo/database", () => ({
  withDb: (
    fn: (db: {
      computeTarget: { findUnique: typeof mocks.findUnique };
    }) => unknown
  ) => fn({ computeTarget: { findUnique: mocks.findUnique } }),
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: mocks.logDebug,
    error: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    info: vi.fn(),
    warn: mocks.logWarn,
  },
}));

vi.mock("@/env", () => ({ env: mocks.env }));

import { GET as assetGET } from "../[assetName]/route";
import { GET as feedGET } from "../latest-linux.yml/route";
import { resetDesktopUpdaterRateLimiterForTests } from "../updater-abuse-control";
import { resetDesktopUpdaterRingCacheForTests } from "../updater-ring-service";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env = {};
  resetDesktopUpdaterRateLimiterForTests();
  resetDesktopUpdaterRingCacheForTests();
  mocks.getLatestElectronUpdaterFeed.mockResolvedValue("version: 0.17.123");
  mocks.getElectronUpdaterAssetRedirectUrl.mockResolvedValue(
    "https://release-assets.githubusercontent.com/package"
  );
});

describe("Linux updater routes", () => {
  it("requests only the Linux feed on the general ring", async () => {
    const response = await feedGET(
      new Request("https://api.closedloop.ai/desktop/updates/latest-linux.yml")
    );
    expect(response.status).toBe(200);
    expect(mocks.getLatestElectronUpdaterFeed).toHaveBeenCalledWith(
      [DesktopReleaseChannel],
      DesktopReleaseLinuxUpdaterMetadataAssetName
    );
    expect(response.headers.get("Content-Type")).toContain(
      "application/x-yaml"
    );
  });
  it("returns unavailable when no platform feed is published", async () => {
    mocks.getLatestElectronUpdaterFeed.mockResolvedValue(null);
    expect(
      (
        await feedGET(
          new Request(
            "https://api.closedloop.ai/desktop/updates/latest-linux.yml"
          )
        )
      ).status
    ).toBe(404);
  });
  it.each([
    "Closedloop-0.17.123-linux-x64.deb",
    "Closedloop-0.17.123-linux-x64.AppImage",
  ])("resolves %s against both asset channels", async (assetName) => {
    const response = await assetGET(
      new Request(`https://api.closedloop.ai/desktop/updates/${assetName}`),
      { params: Promise.resolve({ assetName }) }
    );
    expect(response.status).toBe(302);
    expect(mocks.getElectronUpdaterAssetRedirectUrl).toHaveBeenCalledWith(
      assetName,
      DesktopReleaseAssetChannels
    );
  });
  it.each([
    "../Closedloop-0.17.123-linux-x64.deb",
    "Closedloop-0.17.123-linux-arm64.deb",
    "Closedloop-0.17.123-linux-x64.rpm",
  ])("rejects %s before any provider lookup", async (assetName) => {
    expect(
      (
        await assetGET(
          new Request("https://api.closedloop.ai/desktop/updates/asset"),
          { params: Promise.resolve({ assetName }) }
        )
      ).status
    ).toBe(404);
    expect(mocks.getElectronUpdaterAssetRedirectUrl).not.toHaveBeenCalled();
  });
});
