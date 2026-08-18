import { describe, expect, it } from "vitest";
import { sanitizeElectronReleaseInfo } from "../electron-release-download";

const VALID_DESKTOP_DOWNLOAD_URL =
  "https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-v0.15.115/Closedloop-0.15.115-universal.dmg";
const STALE_OLD_REPO_DOWNLOAD_URL =
  "https://github.com/closedloop-ai/closedloop-electron/releases/download/v0.15.115/Closedloop-0.15.115-universal.dmg";
const MALFORMED_SYMPHONY_DOWNLOAD_URL =
  "https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-latest/Closedloop-0.15.115-universal.dmg";
// The public mirror of the signed DMG. Since FEA-3372 this — not the
// symphony-alpha URL — is what a successful release actually writes into
// downloadUrl, so it is the normal path through this sanitizer.
const PUBLIC_MIRROR_DOWNLOAD_URL =
  "https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-v0.15.115/Closedloop-0.15.115-universal.dmg";
const THIRD_REPO_DOWNLOAD_URL =
  "https://github.com/closedloop-ai/closedloop-ai-evil/releases/download/desktop-v0.15.115/Closedloop-0.15.115-universal.dmg";

describe("sanitizeElectronReleaseInfo", () => {
  it("keeps releases with allowlisted Desktop download URLs", () => {
    const release = {
      downloadUrl: VALID_DESKTOP_DOWNLOAD_URL,
      releaseNotes: "Release notes",
      version: "0.15.115",
    };

    expect(sanitizeElectronReleaseInfo(release)).toBe(release);
  });

  it("keeps releases pointing at the public mirror (FEA-3372)", () => {
    // If this sanitizer rejected the mirror URL, the download button would go
    // dead on the happy path — this is what every new release now looks like.
    const release = {
      downloadUrl: PUBLIC_MIRROR_DOWNLOAD_URL,
      releaseNotes: "Release notes",
      version: "0.15.115",
    };

    expect(sanitizeElectronReleaseInfo(release)).toBe(release);
  });

  it.each([
    ["stale old-repo URL", STALE_OLD_REPO_DOWNLOAD_URL],
    ["malformed symphony-alpha URL", MALFORMED_SYMPHONY_DOWNLOAD_URL],
    ["third repo under the allowed owner", THIRD_REPO_DOWNLOAD_URL],
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
