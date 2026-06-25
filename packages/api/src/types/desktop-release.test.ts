import { describe, expect, it } from "vitest";
import {
  DesktopReleaseChannel,
  DesktopReleaseMetadataAssetName,
  DesktopReleaseOwner,
  DesktopReleaseRepo,
  DesktopReleaseUpdaterMetadataAssetName,
  getDesktopReleaseDmgAssetName,
  getDesktopReleaseLegacyDmgAssetName,
  getDesktopReleaseLegacyZipAssetName,
  getDesktopReleaseSeries,
  getDesktopReleaseTag,
  getDesktopReleaseUpdaterZipAssetNameFromFeed,
  getDesktopReleaseUpdaterZipAssetNameFromMetadata,
  getDesktopReleaseZipAssetName,
  getHighestDesktopReleaseVersion,
  isAcceptedDesktopReleaseDmgAssetName,
  isAcceptedDesktopReleaseZipAssetName,
  isAllowedDesktopReleaseAssetRedirectUrl,
  isAllowedDesktopReleaseDownloadUrl,
  isDesktopReleaseUpdaterZipAssetName,
  parseDesktopReleaseVersion,
  resolveDesktopReleaseVersion,
} from "./desktop-release";

const BEHIND_SERIES_ERROR = /behind the highest released series/;
const VERSION = "0.15.115";
const RELEASE_TAG = getDesktopReleaseTag(VERSION);
const DMG_ASSET = getDesktopReleaseDmgAssetName(VERSION);
const ZIP_ASSET = getDesktopReleaseZipAssetName(VERSION);
const VALID_DOWNLOAD_URL = `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${RELEASE_TAG}/${DMG_ASSET}`;
// Pre-rename (FEA-2101) asset basenames, still present on desktop-latest.
const LEGACY_DMG_ASSET = getDesktopReleaseLegacyDmgAssetName(VERSION);
const LEGACY_ZIP_ASSET = getDesktopReleaseLegacyZipAssetName(VERSION);
const LEGACY_DOWNLOAD_URL = `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${RELEASE_TAG}/${LEGACY_DMG_ASSET}`;

describe("isDesktopReleaseUpdaterZipAssetName", () => {
  it("allows the supported macOS updater ZIP asset basename", () => {
    expect(isDesktopReleaseUpdaterZipAssetName(ZIP_ASSET)).toBe(true);
  });

  it("allows the pre-rename ClosedLoop-* ZIP basename during the transition (FEA-2101)", () => {
    expect(isDesktopReleaseUpdaterZipAssetName(LEGACY_ZIP_ASSET)).toBe(true);
  });

  it.each([
    ["DMG", DMG_ASSET],
    ["updater feed", DesktopReleaseUpdaterMetadataAssetName],
    ["metadata", DesktopReleaseMetadataAssetName],
    ["path traversal", `../${ZIP_ASSET}`],
    ["encoded separator", `Closedloop-%2F${VERSION}-universal-mac.zip`],
    ["non-semver", "Closedloop-latest-universal-mac.zip"],
    ["extra suffix", `${ZIP_ASSET}.sha256`],
    ["absolute path", `/${ZIP_ASSET}`],
    ["blockmap", `${ZIP_ASSET}.blockmap`],
  ])("rejects %s", (_name, assetName) => {
    expect(isDesktopReleaseUpdaterZipAssetName(assetName)).toBe(false);
  });
});

describe("isAcceptedDesktopReleaseDmgAssetName (FEA-2101 transition)", () => {
  it("accepts the current Closedloop-* DMG name", () => {
    expect(isAcceptedDesktopReleaseDmgAssetName(DMG_ASSET, VERSION)).toBe(true);
  });

  it("accepts the pre-rename ClosedLoop-* DMG name", () => {
    expect(
      isAcceptedDesktopReleaseDmgAssetName(LEGACY_DMG_ASSET, VERSION)
    ).toBe(true);
  });

  it.each([
    ["wrong version", "Closedloop-9.9.9-universal.dmg"],
    ["zip not dmg", ZIP_ASSET],
    ["arbitrary name", "Evil-0.15.115-universal.dmg"],
  ])("rejects %s", (_name, assetName) => {
    expect(isAcceptedDesktopReleaseDmgAssetName(assetName, VERSION)).toBe(
      false
    );
  });
});

describe("isAcceptedDesktopReleaseZipAssetName (FEA-2101 transition)", () => {
  it("accepts the current Closedloop-* ZIP name", () => {
    expect(isAcceptedDesktopReleaseZipAssetName(ZIP_ASSET, VERSION)).toBe(true);
  });

  it("accepts the pre-rename ClosedLoop-* ZIP name", () => {
    expect(
      isAcceptedDesktopReleaseZipAssetName(
        getDesktopReleaseLegacyZipAssetName(VERSION),
        VERSION
      )
    ).toBe(true);
  });

  it.each([
    ["wrong version", "Closedloop-9.9.9-universal-mac.zip"],
    ["dmg not zip", DMG_ASSET],
  ])("rejects %s", (_name, assetName) => {
    expect(isAcceptedDesktopReleaseZipAssetName(assetName, VERSION)).toBe(
      false
    );
  });
});

describe("getDesktopReleaseUpdaterZipAssetNameFromFeed", () => {
  it("returns the updater ZIP basename from the generated files url value", () => {
    expect(
      getDesktopReleaseUpdaterZipAssetNameFromFeed(
        `version: ${VERSION}\nfiles:\n  - url: ${ZIP_ASSET}\n    sha512: abc\n    size: 123\npath: ${ZIP_ASSET}\n`
      )
    ).toBe(ZIP_ASSET);
  });

  it("falls back to the generated path value when files url is absent", () => {
    expect(
      getDesktopReleaseUpdaterZipAssetNameFromFeed(
        `version: ${VERSION}\npath: ${ZIP_ASSET}\nsha512: abc\n`
      )
    ).toBe(ZIP_ASSET);
  });

  it("keeps the legacy top-level url value compatible", () => {
    expect(
      getDesktopReleaseUpdaterZipAssetNameFromFeed(
        `version: ${VERSION}\nurl: ${ZIP_ASSET}\n`
      )
    ).toBe(ZIP_ASSET);
  });

  it("keeps files url authoritative over a mismatched path", () => {
    expect(
      getDesktopReleaseUpdaterZipAssetNameFromFeed(
        `version: ${VERSION}\nfiles:\n  - url: ${ZIP_ASSET}\npath: Closedloop-9.9.9-universal-mac.zip\n`
      )
    ).toBe(ZIP_ASSET);
  });

  it.each([
    ["missing url", `version: ${VERSION}\n`],
    ["absolute path", `url: /${ZIP_ASSET}\n`],
    ["traversal", `url: ../${ZIP_ASSET}\n`],
    ["encoded separator", `url: Closedloop-%2F${VERSION}-universal-mac.zip\n`],
    ["DMG", `url: ${DMG_ASSET}\n`],
    ["metadata", `url: ${DesktopReleaseMetadataAssetName}\n`],
    ["blockmap", `url: ${ZIP_ASSET}.blockmap\n`],
    ["non-semver", "url: Closedloop-latest-universal-mac.zip\n"],
  ])("rejects %s", (_name, feedText) => {
    expect(getDesktopReleaseUpdaterZipAssetNameFromFeed(feedText)).toBeNull();
  });
});

describe("getDesktopReleaseUpdaterZipAssetNameFromMetadata", () => {
  it("returns metadata.assets.zip when valid", () => {
    expect(
      getDesktopReleaseUpdaterZipAssetNameFromMetadata(makeMetadata())
    ).toBe(ZIP_ASSET);
  });

  it.each([
    ["absent", {}],
    ["null", null],
    [
      "non-string",
      { ...makeMetadata(), assets: { ...makeMetadata().assets, zip: 123 } },
    ],
    [
      "malformed",
      {
        ...makeMetadata(),
        assets: {
          ...makeMetadata().assets,
          zip: "Closedloop-latest-universal-mac.zip",
        },
      },
    ],
    [
      "traversal",
      {
        ...makeMetadata(),
        assets: { ...makeMetadata().assets, zip: `../${ZIP_ASSET}` },
      },
    ],
    [
      "DMG",
      {
        ...makeMetadata(),
        assets: { ...makeMetadata().assets, zip: DMG_ASSET },
      },
    ],
    [
      "metadata",
      {
        ...makeMetadata(),
        assets: {
          ...makeMetadata().assets,
          zip: DesktopReleaseMetadataAssetName,
        },
      },
    ],
    [
      "blockmap",
      {
        ...makeMetadata(),
        assets: { ...makeMetadata().assets, zip: `${ZIP_ASSET}.blockmap` },
      },
    ],
  ])("rejects %s", (_name, metadata) => {
    expect(
      getDesktopReleaseUpdaterZipAssetNameFromMetadata(metadata)
    ).toBeNull();
  });
});

describe("isAllowedDesktopReleaseAssetRedirectUrl", () => {
  it.each([
    [
      "objects.githubusercontent.com",
      "https://objects.githubusercontent.com/github-production-release-asset-2e65be/file.zip?sig=abc",
    ],
    [
      "release-assets.githubusercontent.com",
      "https://release-assets.githubusercontent.com/github-production-release-asset/file.zip?sig=abc",
    ],
  ])("allows %s", (_name, candidateUrl) => {
    expect(isAllowedDesktopReleaseAssetRedirectUrl(candidateUrl)).toBe(true);
  });

  it.each([
    [
      "non-HTTPS",
      "http://objects.githubusercontent.com/github-production-release-asset/file.zip",
    ],
    [
      "userinfo",
      "https://token@objects.githubusercontent.com/github-production-release-asset/file.zip",
    ],
    [
      "fragment",
      "https://objects.githubusercontent.com/github-production-release-asset/file.zip#secret",
    ],
    ["malformed", "not a url"],
    [
      "non-GitHub host",
      "https://example.com/github-production-release-asset/file.zip",
    ],
    ["empty path", "https://objects.githubusercontent.com"],
  ])("rejects %s", (_name, candidateUrl) => {
    expect(isAllowedDesktopReleaseAssetRedirectUrl(candidateUrl)).toBe(false);
  });
});

describe("isAllowedDesktopReleaseDownloadUrl", () => {
  it("allows the versioned symphony-alpha Desktop DMG asset", () => {
    expect(isAllowedDesktopReleaseDownloadUrl(VALID_DOWNLOAD_URL)).toBe(true);
  });

  it("allows the pre-rename ClosedLoop-* DMG download URL during the transition (FEA-2101)", () => {
    expect(isAllowedDesktopReleaseDownloadUrl(LEGACY_DOWNLOAD_URL)).toBe(true);
  });

  it.each([
    [
      "old closedloop-electron repo",
      "https://github.com/closedloop-ai/closedloop-electron/releases/download/v0.15.115/Closedloop-0.15.115-universal.dmg",
    ],
    [
      "other org",
      `https://github.com/acme/${DesktopReleaseRepo}/releases/download/${RELEASE_TAG}/${DMG_ASSET}`,
    ],
    [
      "other repo",
      `https://github.com/${DesktopReleaseOwner}/not-symphony-alpha/releases/download/${RELEASE_TAG}/${DMG_ASSET}`,
    ],
    [
      "non-HTTPS",
      `http://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${RELEASE_TAG}/${DMG_ASSET}`,
    ],
    [
      "userinfo",
      `https://token@github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${RELEASE_TAG}/${DMG_ASSET}`,
    ],
    [
      "host spoofing",
      `https://github.com.evil.example/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${RELEASE_TAG}/${DMG_ASSET}`,
    ],
    ["query string", `${VALID_DOWNLOAD_URL}?download=1`],
    ["hash", `${VALID_DOWNLOAD_URL}#asset`],
    [
      "encoded slash in asset",
      `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${RELEASE_TAG}/Closedloop-%2F${VERSION}-universal.dmg`,
    ],
    [
      "encoded traversal in asset",
      `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${RELEASE_TAG}/Closedloop-..%2F${VERSION}-universal.dmg`,
    ],
    ["extra path segment", `${VALID_DOWNLOAD_URL}/extra`],
    [
      "non-Desktop symphony-alpha release tag",
      `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/v${VERSION}/${DMG_ASSET}`,
    ],
    [
      "mismatched asset version",
      `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${RELEASE_TAG}/Closedloop-9.9.9-universal.dmg`,
    ],
    [
      "zip asset",
      `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${RELEASE_TAG}/Closedloop-${VERSION}-universal-mac.zip`,
    ],
    [
      "updater metadata asset",
      `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${RELEASE_TAG}/latest-mac.yml`,
    ],
    [
      "metadata asset",
      `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${RELEASE_TAG}/desktop-release.json`,
    ],
    ["malformed URL", "not a url"],
    [
      "malformed percent escape",
      `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${RELEASE_TAG}/Closedloop-%E0%A4%A-universal.dmg`,
    ],
  ])("rejects %s", (_name, candidateUrl) => {
    expect(isAllowedDesktopReleaseDownloadUrl(candidateUrl)).toBe(false);
  });
});

function makeMetadata() {
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
    },
    downloadUrl: VALID_DOWNLOAD_URL,
  };
}

describe("parseDesktopReleaseVersion", () => {
  it("splits supported versions and rejects unsupported forms", () => {
    expect(parseDesktopReleaseVersion("0.16.41")).toEqual({
      major: 0,
      minor: 16,
      patch: 41,
    });
    expect(parseDesktopReleaseVersion("12.3.0")).toEqual({
      major: 12,
      minor: 3,
      patch: 0,
    });
    expect(parseDesktopReleaseVersion("0.16")).toBeNull();
    expect(parseDesktopReleaseVersion("0.16.41-rc.1")).toBeNull();
    expect(parseDesktopReleaseVersion("v0.16.41")).toBeNull();
    expect(parseDesktopReleaseVersion("00.1.2")).toBeNull();
  });
});

describe("getDesktopReleaseSeries", () => {
  it("returns the major.minor anchor of a supported version", () => {
    expect(getDesktopReleaseSeries("0.16.41")).toBe("0.16");
    expect(getDesktopReleaseSeries("0.16.0")).toBe("0.16");
    expect(getDesktopReleaseSeries("3.7.12")).toBe("3.7");
    expect(getDesktopReleaseSeries("nonsense")).toBeNull();
  });
});

describe("getHighestDesktopReleaseVersion", () => {
  it("returns the highest supported version regardless of input order", () => {
    expect(
      getHighestDesktopReleaseVersion(["0.16.10", "0.16.41", "0.16.14"])
    ).toBe("0.16.41");
    // Compares across series, not lexically: 0.16.9 < 0.16.41 and 0.17.0 wins.
    expect(
      getHighestDesktopReleaseVersion(["0.16.9", "0.16.41", "0.17.0"])
    ).toBe("0.17.0");
  });

  it("ignores unsupported entries and returns null when none are valid", () => {
    expect(
      getHighestDesktopReleaseVersion(["not-a-version", "0.16.5", "0.16"])
    ).toBe("0.16.5");
    expect(getHighestDesktopReleaseVersion([])).toBeNull();
    expect(getHighestDesktopReleaseVersion(["nope", "v1.2.3"])).toBeNull();
  });
});

describe("resolveDesktopReleaseVersion", () => {
  it("starts a fresh series at .0", () => {
    expect(
      resolveDesktopReleaseVersion({
        seriesVersion: "0.17.0",
        releasedVersions: ["0.16.10", "0.16.41"],
        shaReleasedVersion: null,
      })
    ).toEqual({ version: "0.17.0" });
  });

  it("increments contiguously from the max patch in the series", () => {
    // Out-of-order, lower-series, and malformed entries must not perturb the max.
    expect(
      resolveDesktopReleaseVersion({
        seriesVersion: "0.16.0",
        releasedVersions: [
          "0.16.10",
          "0.16.41",
          "0.16.14",
          "0.15.99",
          "not-a-version",
        ],
        shaReleasedVersion: null,
      })
    ).toEqual({ version: "0.16.42" });
  });

  it("fails closed when the anchor series is behind the highest released series", () => {
    const resolved = resolveDesktopReleaseVersion({
      seriesVersion: "0.16.0",
      releasedVersions: ["0.16.41", "0.17.0", "0.17.1"],
      shaReleasedVersion: null,
    });
    expect("error" in resolved).toBe(true);
    expect("error" in resolved && resolved.error).toMatch(BEHIND_SERIES_ERROR);
  });

  it("is idempotent for an already-tagged SHA", () => {
    expect(
      resolveDesktopReleaseVersion({
        seriesVersion: "0.17.0",
        releasedVersions: ["0.16.41", "0.17.0", "0.17.1"],
        shaReleasedVersion: "0.16.41",
      })
    ).toEqual({ version: "0.16.41" });
  });

  it("ignores an unsupported SHA tag and falls back to derivation", () => {
    expect(
      resolveDesktopReleaseVersion({
        seriesVersion: "0.16.0",
        releasedVersions: ["0.16.41"],
        shaReleasedVersion: "0.16",
      })
    ).toEqual({ version: "0.16.42" });
  });

  it("errors on a malformed series anchor", () => {
    const resolved = resolveDesktopReleaseVersion({
      seriesVersion: "0.16",
      releasedVersions: [],
      shaReleasedVersion: null,
    });
    expect("error" in resolved).toBe(true);
  });

  it("floors the next patch at the anchor patch when the ledger is behind (FEA-2156)", () => {
    // The manifest patch (0.16.71) is a deliberate floor above the ledger
    // (which only reached 0.16.52), so the next version is 0.16.71 — never a
    // number an earlier main commit already carried in package.json.
    expect(
      resolveDesktopReleaseVersion({
        seriesVersion: "0.16.71",
        releasedVersions: ["0.16.47", "0.16.50", "0.16.52"],
        shaReleasedVersion: null,
      })
    ).toEqual({ version: "0.16.71" });
  });

  it("lets the ledger lead once it passes the anchor-patch floor", () => {
    // Floor 0.16.71 but the ledger already reached 0.16.75 → contiguous +1 wins.
    expect(
      resolveDesktopReleaseVersion({
        seriesVersion: "0.16.71",
        releasedVersions: ["0.16.71", "0.16.75"],
        shaReleasedVersion: null,
      })
    ).toEqual({ version: "0.16.76" });
  });
});
