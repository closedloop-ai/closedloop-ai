/**
 * Public desktop installer URLs used by onboarding surfaces.
 *
 * The macOS link is the public mirror, not the private source repository, so a
 * brand-new user can download the app before they have repository access.
 */
export const DESKTOP_LATEST_DMG_URL =
  "https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-latest/Closedloop-universal.dmg";

/**
 * The rolling channel's release PAGE on that same public mirror — platform
 * neutral by construction, so it is the correct link wherever the reader's
 * platform has no published artifact of its own (ISS-9708).
 *
 * Held as a literal beside {@link DESKTOP_LATEST_DMG_URL} rather than built from
 * `buildDesktopReleaseChannelPageUrl`, for the reason this module exists at all:
 * every consumer is a `"use client"` module and that builder's file
 * (`desktop-release.ts`) imports Zod. `desktop-download.test.ts` pins this
 * literal against that builder, so the two spellings cannot drift.
 */
export const DESKTOP_LATEST_RELEASE_PAGE_URL =
  "https://github.com/closedloop-ai/closedloop-ai/releases/tag/desktop-latest";

/**
 * The rolling channel's fixed-name Linux AppImage on the same public mirror
 * (ISS-12614: AppImage chosen over `.deb` by the operator).
 */
export const DESKTOP_LATEST_LINUX_APPIMAGE_URL =
  "https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-latest/Closedloop-linux-x64.AppImage";
