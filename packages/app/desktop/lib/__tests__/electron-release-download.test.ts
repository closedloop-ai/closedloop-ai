import { describe, expect, it } from "vitest";
import { sanitizeElectronReleaseInfo } from "../electron-release-download";

const VALID_DESKTOP_DOWNLOAD_URL =
  "https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-v0.15.115/Closedloop-0.15.115-universal.dmg";
const STALE_OLD_REPO_DOWNLOAD_URL =
  "https://github.com/closedloop-ai/closedloop-electron/releases/download/v0.15.115/Closedloop-0.15.115-universal.dmg";
const MALFORMED_SYMPHONY_DOWNLOAD_URL =
  "https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-latest/Closedloop-0.15.115-universal.dmg";

describe("sanitizeElectronReleaseInfo", () => {
  it("keeps releases with allowlisted Desktop download URLs", () => {
    const release = {
      downloadUrl: VALID_DESKTOP_DOWNLOAD_URL,
      releaseNotes: "Release notes",
      version: "0.15.115",
    };

    expect(sanitizeElectronReleaseInfo(release)).toBe(release);
  });

  it.each([
    ["stale old-repo URL", STALE_OLD_REPO_DOWNLOAD_URL],
    ["malformed symphony-alpha URL", MALFORMED_SYMPHONY_DOWNLOAD_URL],
  ])("rejects %s", (_name, downloadUrl) => {
    expect(
      sanitizeElectronReleaseInfo({
        downloadUrl,
        releaseNotes: "",
        version: "0.15.115",
      })
    ).toBeNull();
  });
});
