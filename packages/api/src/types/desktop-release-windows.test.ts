import { describe, expect, it } from "vitest";
import {
  DesktopPublicMirrorRepo,
  DesktopReleaseChannel,
  DesktopReleaseMetadataSchema,
  DesktopReleaseOwner,
  DesktopReleaseRepo,
  DesktopReleaseUpdaterMetadataAssetName,
  getDesktopReleaseDmgAssetName,
  getDesktopReleaseTag,
  getDesktopReleaseUpdaterZipAssetNameFromMetadata,
  getDesktopReleaseZipAssetName,
  isAllowedDesktopReleaseDownloadUrl,
} from "./desktop-release";
import {
  DesktopReleaseWindowsArch,
  DesktopReleaseWindowsAssetsSchema,
  DesktopReleaseWindowsAvailabilityStatus,
  DesktopReleaseWindowsBlockmapAssetSuffix,
  DesktopReleaseWindowsInstallerAssetSuffix,
  DesktopReleaseWindowsUnavailableReason,
  DesktopReleaseWindowsUpdaterMetadataAssetName,
  getDesktopReleaseWindowsBlockmapAssetName,
  getDesktopReleaseWindowsInstallerAssetName,
  getDesktopReleaseWindowsInstallerAssetUrl,
  getPublicDesktopReleaseWindowsDownloadUrl,
  isAllowedDesktopReleaseWindowsDownloadUrl,
  isDesktopReleaseWindowsInstallerAssetName,
  resolveDesktopReleaseWindowsAvailability,
} from "./desktop-release-windows";

// Every expectation about the WINDOWS contract below is written as a literal,
// independently of the builders under test. Deleting or renaming a Windows
// asset-name part has to fail here; re-deriving the expectation from the same
// helper would make that mutation invisible. Only the unrelated macOS
// scaffolding is imported, per the shared-contract-constants rule.
const VERSION = "0.15.115";
const OTHER_VERSION = "0.15.116";
const RELEASE_TAG = getDesktopReleaseTag(VERSION);
const WINDOWS_INSTALLER_ASSET = "Closedloop-0.15.115-x64.exe";
const WINDOWS_BLOCKMAP_ASSET = "Closedloop-0.15.115-x64.exe.blockmap";
const WINDOWS_UPDATER_FEED = "latest.yml";
const WINDOWS_MIRROR_URL = `https://github.com/${DesktopReleaseOwner}/${DesktopPublicMirrorRepo}/releases/download/${RELEASE_TAG}/${WINDOWS_INSTALLER_ASSET}`;
const WINDOWS_RELEASE_ASSET_URL = `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${RELEASE_TAG}/${WINDOWS_INSTALLER_ASSET}`;
const DMG_ASSET = getDesktopReleaseDmgAssetName(VERSION);
const ZIP_ASSET = getDesktopReleaseZipAssetName(VERSION);
const DMG_DOWNLOAD_URL = `https://github.com/${DesktopReleaseOwner}/${DesktopPublicMirrorRepo}/releases/download/${RELEASE_TAG}/${DMG_ASSET}`;

type ReleaseAssets = Record<string, unknown>;

function macOnlyMetadata(assets: ReleaseAssets = {}): Record<string, unknown> {
  return {
    owner: DesktopReleaseOwner,
    repo: DesktopReleaseRepo,
    version: VERSION,
    tagName: RELEASE_TAG,
    channel: DesktopReleaseChannel,
    targetCommitish: "0123456789abcdef0123456789abcdef01234567",
    assets: {
      dmg: DMG_ASSET,
      zip: ZIP_ASSET,
      updaterMetadata: DesktopReleaseUpdaterMetadataAssetName,
      ...assets,
    },
    downloadUrl: DMG_DOWNLOAD_URL,
  };
}

const WINDOWS_ASSET_BLOCK = {
  windowsInstaller: WINDOWS_INSTALLER_ASSET,
  windowsUpdaterMetadata: WINDOWS_UPDATER_FEED,
  windowsDownloadUrl: WINDOWS_MIRROR_URL,
};

describe("Windows release asset names", () => {
  it("names the installer with the version and the x64 architecture", () => {
    expect(getDesktopReleaseWindowsInstallerAssetName(VERSION)).toBe(
      WINDOWS_INSTALLER_ASSET
    );
  });

  it("names the differential-update blockmap beside the installer", () => {
    expect(getDesktopReleaseWindowsBlockmapAssetName(VERSION)).toBe(
      WINDOWS_BLOCKMAP_ASSET
    );
  });

  it("pins the arch-derived asset suffixes", () => {
    // Both are built from DesktopReleaseWindowsArch.X64 so the arch token has
    // one source of truth. Pinned as independent literals: a change to the arch
    // const silently reshapes every asset name otherwise.
    expect(DesktopReleaseWindowsArch.X64).toBe("x64");
    expect(DesktopReleaseWindowsInstallerAssetSuffix).toBe("-x64.exe");
    expect(DesktopReleaseWindowsBlockmapAssetSuffix).toBe("-x64.exe.blockmap");
  });

  it("pins the electron-updater Windows feed basename", () => {
    // electron-updater requests this exact name on Windows; it is the library's
    // name, not ours. Renaming it strands every installed Windows client.
    expect(DesktopReleaseWindowsUpdaterMetadataAssetName).toBe("latest.yml");
  });

  it("builds both accepted installer download URLs for a version", () => {
    expect(getPublicDesktopReleaseWindowsDownloadUrl(VERSION)).toBe(
      WINDOWS_MIRROR_URL
    );
    expect(getDesktopReleaseWindowsInstallerAssetUrl(VERSION)).toBe(
      WINDOWS_RELEASE_ASSET_URL
    );
  });
});

describe("isDesktopReleaseWindowsInstallerAssetName", () => {
  it("allows the Windows installer basename", () => {
    expect(
      isDesktopReleaseWindowsInstallerAssetName(WINDOWS_INSTALLER_ASSET)
    ).toBe(true);
  });

  it.each([
    ["macOS DMG", DMG_ASSET],
    ["macOS updater ZIP", ZIP_ASSET],
    ["Windows updater feed", WINDOWS_UPDATER_FEED],
    ["blockmap", WINDOWS_BLOCKMAP_ASSET],
    ["path traversal", `../${WINDOWS_INSTALLER_ASSET}`],
    ["encoded separator", "Closedloop-%2F0.15.115-x64.exe"],
    ["encoded extension", "Closedloop-0.15.115-x64%2Eexe"],
    // No Windows asset has ever been published, so the FEA-2101 pre-rename
    // "ClosedLoop-*" alias deliberately has no Windows arm to accept.
    ["pre-rename casing", "ClosedLoop-0.15.115-x64.exe"],
    // FR14 arm64 is blocked upstream (no libsql win32-arm64 prebuild). Nothing
    // may resolve an arm64 asset name before the build that produces one ships.
    ["arm64", "Closedloop-0.15.115-arm64.exe"],
    ["non-semver version", "Closedloop-0.15-x64.exe"],
  ])("rejects a %s basename", (_label, assetName) => {
    expect(isDesktopReleaseWindowsInstallerAssetName(assetName)).toBe(false);
  });
});

describe("Windows installer download URL guard", () => {
  it.each([
    ["public mirror", WINDOWS_MIRROR_URL],
    ["private release repo", WINDOWS_RELEASE_ASSET_URL],
  ])("allows the %s installer URL", (_label, url) => {
    expect(isAllowedDesktopReleaseWindowsDownloadUrl(url)).toBe(true);
  });

  it.each([
    ["macOS DMG", DMG_DOWNLOAD_URL],
    [
      "installer whose name disagrees with the tag version",
      `https://github.com/${DesktopReleaseOwner}/${DesktopPublicMirrorRepo}/releases/download/${RELEASE_TAG}/Closedloop-${OTHER_VERSION}-x64.exe`,
    ],
    [
      "third-party host",
      `https://example.com/${DesktopReleaseOwner}/${DesktopPublicMirrorRepo}/releases/download/${RELEASE_TAG}/${WINDOWS_INSTALLER_ASSET}`,
    ],
    [
      "unrelated repo",
      `https://github.com/${DesktopReleaseOwner}/some-other-repo/releases/download/${RELEASE_TAG}/${WINDOWS_INSTALLER_ASSET}`,
    ],
    [
      "plaintext",
      `http://github.com/x/y/releases/download/z/${WINDOWS_INSTALLER_ASSET}`,
    ],
  ])("rejects a %s URL", (_label, url) => {
    expect(isAllowedDesktopReleaseWindowsDownloadUrl(url)).toBe(false);
  });
});

describe("direct-download versus managed-onboarding boundary", () => {
  // The macOS guard also gates the managed-onboarding installer script, which
  // mounts whatever URL it is handed as a disk image. The two guards must stay
  // mutually exclusive: widening either to accept the other platform's asset
  // hands an .exe to `hdiutil`, or a DMG to the Windows direct-download path.
  it("refuses a Windows installer URL on the managed-onboarding guard", () => {
    expect(isAllowedDesktopReleaseWindowsDownloadUrl(WINDOWS_MIRROR_URL)).toBe(
      true
    );
    expect(isAllowedDesktopReleaseDownloadUrl(WINDOWS_MIRROR_URL)).toBe(false);
  });

  it("refuses a macOS DMG URL on the Windows direct-download guard", () => {
    expect(isAllowedDesktopReleaseDownloadUrl(DMG_DOWNLOAD_URL)).toBe(true);
    expect(isAllowedDesktopReleaseWindowsDownloadUrl(DMG_DOWNLOAD_URL)).toBe(
      false
    );
  });
});

describe("old clients ignore the additive Windows block", () => {
  // The version-skew guarantee, executed against the SHIPPED schema an
  // already-installed macOS client compiles in. If that schema ever becomes
  // strict, or grows a Windows-aware branch, this fails.
  it("parses release metadata carrying Windows assets", () => {
    const parsed = DesktopReleaseMetadataSchema.safeParse(
      macOnlyMetadata(WINDOWS_ASSET_BLOCK)
    );

    expect(parsed.success).toBe(true);
  });

  it("still resolves the macOS updater ZIP from Windows-bearing metadata", () => {
    expect(
      getDesktopReleaseUpdaterZipAssetNameFromMetadata(
        macOnlyMetadata(WINDOWS_ASSET_BLOCK)
      )
    ).toBe(ZIP_ASSET);
  });

  it("resolves the macOS updater ZIP identically once Windows is rolled back out", () => {
    expect(
      getDesktopReleaseUpdaterZipAssetNameFromMetadata(macOnlyMetadata())
    ).toBe(ZIP_ASSET);
  });
});

describe("resolveDesktopReleaseWindowsAvailability", () => {
  it("offers the mirrored installer when the release publishes Windows assets", () => {
    const result = resolveDesktopReleaseWindowsAvailability(
      macOnlyMetadata(WINDOWS_ASSET_BLOCK)
    );

    expect(result).toEqual({
      status: DesktopReleaseWindowsAvailabilityStatus.Available,
      version: VERSION,
      installerAssetName: WINDOWS_INSTALLER_ASSET,
      updaterMetadataAssetName: WINDOWS_UPDATER_FEED,
      downloadUrl: WINDOWS_MIRROR_URL,
    });
  });

  it("accepts the private-release fallback URL the job writes when the mirror fails", () => {
    const result = resolveDesktopReleaseWindowsAvailability(
      macOnlyMetadata({
        ...WINDOWS_ASSET_BLOCK,
        windowsDownloadUrl: WINDOWS_RELEASE_ASSET_URL,
      })
    );

    expect(result).toEqual({
      status: DesktopReleaseWindowsAvailabilityStatus.Available,
      version: VERSION,
      installerAssetName: WINDOWS_INSTALLER_ASSET,
      updaterMetadataAssetName: WINDOWS_UPDATER_FEED,
      downloadUrl: WINDOWS_RELEASE_ASSET_URL,
    });
  });

  it.each([
    ["a macOS DMG name", macOnlyMetadata({ ...WINDOWS_ASSET_BLOCK, dmg: "" })],
    [
      "the macOS updater feed name",
      macOnlyMetadata({
        ...WINDOWS_ASSET_BLOCK,
        updaterMetadata: WINDOWS_UPDATER_FEED,
      }),
    ],
    [
      "the top-level macOS download URL",
      { ...macOnlyMetadata(WINDOWS_ASSET_BLOCK), downloadUrl: "" },
    ],
  ])(
    "still offers the Windows installer when the release breaks %s",
    (_label, metadata) => {
      // The platforms fail independently. Each of these makes the shared
      // DesktopReleaseMetadataSchema reject the release, and none of them says
      // anything about the Windows block — resolving them as Windows-malformed
      // would point the on-call at the platform that is fine.
      expect(resolveDesktopReleaseWindowsAvailability(metadata)).toEqual({
        status: DesktopReleaseWindowsAvailabilityStatus.Available,
        version: VERSION,
        installerAssetName: WINDOWS_INSTALLER_ASSET,
        updaterMetadataAssetName: WINDOWS_UPDATER_FEED,
        downloadUrl: WINDOWS_MIRROR_URL,
      });
    }
  );

  it("reports a pre-Windows or rolled-back release as not published", () => {
    expect(resolveDesktopReleaseWindowsAvailability(macOnlyMetadata())).toEqual(
      {
        status: DesktopReleaseWindowsAvailabilityStatus.Unavailable,
        reason: DesktopReleaseWindowsUnavailableReason.NotPublished,
      }
    );
  });

  it.each([
    [
      "a partially written block",
      { windowsInstaller: WINDOWS_INSTALLER_ASSET },
    ],
    [
      "an unrecognized updater feed name",
      { ...WINDOWS_ASSET_BLOCK, windowsUpdaterMetadata: "latest-win.yml" },
    ],
    [
      "an installer named for another version",
      {
        ...WINDOWS_ASSET_BLOCK,
        windowsInstaller: `Closedloop-${OTHER_VERSION}-x64.exe`,
      },
    ],
    [
      "a download URL for another version",
      {
        ...WINDOWS_ASSET_BLOCK,
        windowsDownloadUrl: `https://github.com/${DesktopReleaseOwner}/${DesktopPublicMirrorRepo}/releases/download/${getDesktopReleaseTag(OTHER_VERSION)}/Closedloop-${OTHER_VERSION}-x64.exe`,
      },
    ],
    [
      "a download URL on an unrelated host",
      {
        ...WINDOWS_ASSET_BLOCK,
        windowsDownloadUrl: `https://cdn.example.com/${WINDOWS_INSTALLER_ASSET}`,
      },
    ],
  ])("reports %s as malformed", (_label, assets) => {
    expect(
      resolveDesktopReleaseWindowsAvailability(macOnlyMetadata(assets))
    ).toEqual({
      status: DesktopReleaseWindowsAvailabilityStatus.Unavailable,
      reason: DesktopReleaseWindowsUnavailableReason.Malformed,
    });
  });

  it.each([
    ["one key", { windowsInstaller: null }],
    [
      "every key",
      {
        windowsInstaller: null,
        windowsUpdaterMetadata: null,
        windowsDownloadUrl: null,
      },
    ],
  ])(
    "reports an explicit null on %s as malformed, not unpublished",
    (_label, assets) => {
      // AGENTS.md cross-repo rule: an absent optional field is OMITTED, never
      // serialized as null, unless the receiving contract declares it nullable
      // — and none of these three does. So a null is a producer defect, not the
      // ordinary "no Windows build" case, and must not resolve to
      // not_published where nobody would look at it. ISS-9643 writes this block
      // and has not shipped, so no published release contradicts this yet.
      expect(
        resolveDesktopReleaseWindowsAvailability(macOnlyMetadata(assets))
      ).toEqual({
        status: DesktopReleaseWindowsAvailabilityStatus.Unavailable,
        reason: DesktopReleaseWindowsUnavailableReason.Malformed,
      });
    }
  );

  it.each([
    ["an empty object", {}],
    ["null", null],
    ["a string", "desktop-release.json"],
    ["a release with no version", { assets: { ...WINDOWS_ASSET_BLOCK } }],
    [
      "a release whose version is not a supported release version",
      { ...macOnlyMetadata(WINDOWS_ASSET_BLOCK), version: "0.15" },
    ],
  ])("reports %s metadata as malformed", (_label, metadata) => {
    expect(resolveDesktopReleaseWindowsAvailability(metadata)).toEqual({
      status: DesktopReleaseWindowsAvailabilityStatus.Unavailable,
      reason: DesktopReleaseWindowsUnavailableReason.Malformed,
    });
  });

  it.each([
    ["not published", macOnlyMetadata()],
    ["malformed", macOnlyMetadata({ windowsInstaller: "anything.exe" })],
  ])("carries no download URL on the %s arm", (_label, metadata) => {
    // The dead-link property: an unavailable result must not hand a surface a
    // URL it could render, even a well-formed-looking one.
    expect(
      resolveDesktopReleaseWindowsAvailability(metadata)
    ).not.toHaveProperty("downloadUrl");
  });
});

describe("DesktopReleaseWindowsAssetsSchema", () => {
  it("accepts the block the release job writes", () => {
    expect(
      DesktopReleaseWindowsAssetsSchema.safeParse(WINDOWS_ASSET_BLOCK).success
    ).toBe(true);
  });

  it("rejects a block whose feed is not the electron-updater Windows name", () => {
    expect(
      DesktopReleaseWindowsAssetsSchema.safeParse({
        ...WINDOWS_ASSET_BLOCK,
        windowsUpdaterMetadata: "latest-mac.yml",
      }).success
    ).toBe(false);
  });
});
