import { describe, expect, it } from "vitest";
import {
  DESKTOP_LATEST_LINUX_APPIMAGE_URL,
  DESKTOP_LATEST_RELEASE_PAGE_URL,
} from "./desktop-download";
import {
  buildDesktopReleaseChannelPageUrl,
  DesktopPublicMirrorRepo,
  DesktopReleaseChannel,
  DesktopReleaseOwner,
} from "./desktop-release";

/**
 * `DESKTOP_LATEST_RELEASE_PAGE_URL` is a LITERAL copy of what
 * `buildDesktopReleaseChannelPageUrl` produces, held that way so a `"use client"`
 * consumer does not pull Zod in through `desktop-release.ts`. A copy needs an
 * owner to be held against, which is this: it reddens the day the channel tag,
 * the release owner or the public mirror repo moves on one side only.
 */
describe("DESKTOP_LATEST_RELEASE_PAGE_URL", () => {
  it("spells the channel page exactly as its builder does", () => {
    expect(DESKTOP_LATEST_RELEASE_PAGE_URL).toBe(
      buildDesktopReleaseChannelPageUrl(DesktopPublicMirrorRepo)
    );
  });
});

describe("DESKTOP_LATEST_LINUX_APPIMAGE_URL", () => {
  it("names the channel's fixed AppImage on the public mirror", () => {
    expect(DESKTOP_LATEST_LINUX_APPIMAGE_URL).toBe(
      `https://github.com/${DesktopReleaseOwner}/${DesktopPublicMirrorRepo}/releases/download/${DesktopReleaseChannel}/Closedloop-linux-x64.AppImage`
    );
  });
});
