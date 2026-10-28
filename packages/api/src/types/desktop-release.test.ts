import { describe, expect, it } from "vitest";
import {
  DesktopMacosTestNodeValidationContext,
  DesktopPackagingValidationContext,
  DesktopPublicMirrorRepo,
  DesktopReleaseCandidateChannel,
  DesktopReleaseChannel,
  DesktopReleaseMetadataAssetName,
  DesktopReleaseMetadataSchema,
  DesktopReleaseOwner,
  DesktopReleaseRepo,
  DesktopReleaseRing,
  DesktopReleaseUpdaterMetadataAssetName,
  DesktopTestValidationContext,
  desktopReleaseChannelsForRing,
  getDesktopReleaseDmgAssetName,
  getDesktopReleaseLegacyDmgAssetName,
  getDesktopReleaseLegacyZipAssetName,
  getDesktopReleaseSeries,
  getDesktopReleaseTag,
  getDesktopReleaseUpdaterVersionFromFeed,
  getDesktopReleaseUpdaterZipAssetNameFromFeed,
  getDesktopReleaseUpdaterZipAssetNameFromMetadata,
  getDesktopReleaseVersionFromUpdaterZipAssetName,
  getDesktopReleaseZipAssetName,
  getHighestDesktopReleaseVersion,
  getPublicDesktopReleaseDownloadUrl,
  isAcceptedDesktopReleaseDmgAssetName,
  isAcceptedDesktopReleaseZipAssetName,
  isAllowedDesktopReleaseAssetRedirectUrl,
  isAllowedDesktopReleaseDownloadUrl,
  isDesktopReleaseUpdaterZipAssetName,
  isSafeDesktopReleaseAssetBasename,
  parseDesktopReleaseVersion,
  resolveDesktopReleaseVersion,
} from "./desktop-release";
import {
  getDesktopReleaseUpdaterZipAssetNameForAsset,
  isDesktopReleaseUpdaterBlockmapAssetName,
} from "./desktop-release-blockmap";

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
// Public mirror of the signed DMG — the login-free download URL (FEA-3372).
const MIRROR_DOWNLOAD_URL = `https://github.com/${DesktopReleaseOwner}/${DesktopPublicMirrorRepo}/releases/download/${RELEASE_TAG}/${DMG_ASSET}`;

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

describe("getDesktopReleaseVersionFromUpdaterZipAssetName", () => {
  it("extracts the version from current and legacy updater ZIP basenames", () => {
    expect(getDesktopReleaseVersionFromUpdaterZipAssetName(ZIP_ASSET)).toBe(
      VERSION
    );
    expect(
      getDesktopReleaseVersionFromUpdaterZipAssetName(LEGACY_ZIP_ASSET)
    ).toBe(VERSION);
  });

  it.each([
    ["DMG", DMG_ASSET],
    ["path traversal", `../${ZIP_ASSET}`],
    ["encoded separator", `Closedloop-%2F${VERSION}-universal-mac.zip`],
    ["non-semver", "Closedloop-latest-universal-mac.zip"],
    ["blockmap", `${ZIP_ASSET}.blockmap`],
  ])("returns null for %s", (_name, assetName) => {
    expect(
      getDesktopReleaseVersionFromUpdaterZipAssetName(assetName)
    ).toBeNull();
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

describe("getDesktopReleaseUpdaterVersionFromFeed", () => {
  it("returns the updater version from latest-mac.yml", () => {
    expect(
      getDesktopReleaseUpdaterVersionFromFeed(
        `version: ${VERSION}\npath: ${ZIP_ASSET}\nsha512: abc\n`
      )
    ).toBe(VERSION);
  });

  it.each([
    ["missing", `path: ${ZIP_ASSET}\n`],
    ["non-semver", "version: latest\n"],
    ["prerelease", "version: 0.15.115-rc.1\n"],
  ])("returns null for %s version", (_name, feedText) => {
    expect(getDesktopReleaseUpdaterVersionFromFeed(feedText)).toBeNull();
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
  it("allows the versioned closedloop-ai Desktop DMG asset", () => {
    expect(isAllowedDesktopReleaseDownloadUrl(VALID_DOWNLOAD_URL)).toBe(true);
  });

  it("allows the pre-rename ClosedLoop-* DMG download URL during the transition (FEA-2101)", () => {
    expect(isAllowedDesktopReleaseDownloadUrl(LEGACY_DOWNLOAD_URL)).toBe(true);
  });

  it("allows the public mirror DMG asset (FEA-3372)", () => {
    expect(isAllowedDesktopReleaseDownloadUrl(MIRROR_DOWNLOAD_URL)).toBe(true);
  });

  it("allows a pre-rename ClosedLoop-* asset name on the public mirror", () => {
    // The asset-name guard is casing-blind, so this URL shape validates even
    // though the mirror only ever publishes current-cased assets. Pinned so a
    // future FEA-2101 cleanup sees the behavior rather than discovering it.
    expect(
      isAllowedDesktopReleaseDownloadUrl(
        `https://github.com/${DesktopReleaseOwner}/${DesktopPublicMirrorRepo}/releases/download/${RELEASE_TAG}/${LEGACY_DMG_ASSET}`
      )
    ).toBe(true);
  });

  it("round-trips getPublicDesktopReleaseDownloadUrl through the guard", () => {
    const url = getPublicDesktopReleaseDownloadUrl(VERSION);

    expect(url).toBe(MIRROR_DOWNLOAD_URL);
    expect(isAllowedDesktopReleaseDownloadUrl(url)).toBe(true);
  });

  it.each([
    [
      "public mirror URL with a non-Desktop release tag",
      `https://github.com/${DesktopReleaseOwner}/${DesktopPublicMirrorRepo}/releases/download/v${VERSION}/${DMG_ASSET}`,
    ],
    [
      "public mirror URL with a mismatched asset version",
      `https://github.com/${DesktopReleaseOwner}/${DesktopPublicMirrorRepo}/releases/download/${RELEASE_TAG}/Closedloop-9.9.9-universal.dmg`,
    ],
    [
      "public mirror zip asset",
      `https://github.com/${DesktopReleaseOwner}/${DesktopPublicMirrorRepo}/releases/download/${RELEASE_TAG}/${ZIP_ASSET}`,
    ],
    [
      "third repo under the allowed owner",
      `https://github.com/${DesktopReleaseOwner}/closedloop-ai-evil/releases/download/${RELEASE_TAG}/${DMG_ASSET}`,
    ],
  ])("rejects %s (FEA-3372 widened surface)", (_name, candidateUrl) => {
    expect(isAllowedDesktopReleaseDownloadUrl(candidateUrl)).toBe(false);
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
      `https://github.com/${DesktopReleaseOwner}/not-closedloop-ai/releases/download/${RELEASE_TAG}/${DMG_ASSET}`,
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
      "non-Desktop closedloop-ai release tag",
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

describe("commit-status validation contexts (FEA-3902, FEA-4224)", () => {
  it("pins every backstop context and keeps them pairwise distinct", () => {
    // SSOT for each producing workflow and for the per-episode alerter that
    // consumes them. All three write verdicts for the SAME `main` SHAs, so any
    // two sharing a spelling merges their verdicts and their episode state.
    expect(DesktopPackagingValidationContext).toBe(
      "desktop-packaging/validated"
    );
    expect(DesktopTestValidationContext).toBe("desktop-test/validated");
    expect(DesktopMacosTestNodeValidationContext).toBe(
      "desktop-testnode-macos/validated"
    );

    const contexts = [
      DesktopPackagingValidationContext,
      DesktopTestValidationContext,
      DesktopMacosTestNodeValidationContext,
    ];
    expect(new Set(contexts).size).toBe(contexts.length);
  });
});

describe("isSafeDesktopReleaseAssetBasename", () => {
  // Exported for ISS-9637 so every per-platform asset-name guard composes ONE
  // traversal check instead of each platform's pattern being trusted to imply
  // it. Covered directly here, at its owning module, because it is now public
  // surface rather than an implementation detail of the macOS ZIP guard.
  it.each([
    ["current DMG", DMG_ASSET],
    ["current updater ZIP", ZIP_ASSET],
    ["pre-rename DMG", LEGACY_DMG_ASSET],
  ])("allows a plain %s basename", (_label, assetName) => {
    expect(isSafeDesktopReleaseAssetBasename(assetName)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["forward-slash path", `releases/${DMG_ASSET}`],
    ["backslash path", `releases\\${DMG_ASSET}`],
    ["parent traversal", `../${DMG_ASSET}`],
    ["percent-encoded separator", "Closedloop-%2F0.15.115-universal.dmg"],
    ["percent-encoded dot", "Closedloop-0.15.115-universal%2Edmg"],
    ["malformed percent escape", "Closedloop-%zz-universal.dmg"],
  ])("rejects a %s basename", (_label, assetName) => {
    expect(isSafeDesktopReleaseAssetBasename(assetName)).toBe(false);
  });
});

describe("desktopReleaseChannelsForRing (ISS-9165)", () => {
  it("prefers the candidate for the internal ring and falls back to the promoted one", () => {
    expect(desktopReleaseChannelsForRing(DesktopReleaseRing.Internal)).toEqual([
      DesktopReleaseCandidateChannel,
      DesktopReleaseChannel,
    ]);
  });

  it("never offers the candidate to the general ring, at any position", () => {
    // The load-bearing asymmetry. The internal list falls back to the promoted
    // channel because no candidate is published before the candidate workflow's
    // first run; the general list must have NO such second entry, or a missing
    // or re-pointed candidate would walk a customer onto one.
    expect(desktopReleaseChannelsForRing(DesktopReleaseRing.General)).toEqual([
      DesktopReleaseChannel,
    ]);
    expect(
      desktopReleaseChannelsForRing(DesktopReleaseRing.General)
    ).not.toContain(DesktopReleaseCandidateChannel);
  });

  it("gives every ring a non-empty list, so a new one cannot resolve to no channel", () => {
    for (const ring of Object.values(DesktopReleaseRing)) {
      expect(desktopReleaseChannelsForRing(ring).length).toBeGreaterThan(0);
    }
  });

  it("keeps the two channels distinct wire strings", () => {
    // The whole mechanism is one string picking one GitHub release. If these
    // ever collapsed to the same literal every assertion above would still pass
    // and the internal ring would silently be the general ring.
    expect(DesktopReleaseCandidateChannel).toBe("desktop-candidate");
    expect(DesktopReleaseCandidateChannel).not.toBe(DesktopReleaseChannel);
  });

  it("accepts a candidate channel in release metadata and rejects an unknown one", () => {
    const base = {
      owner: DesktopReleaseOwner,
      repo: DesktopReleaseRepo,
      version: "0.15.115",
      tagName: getDesktopReleaseTag("0.15.115"),
      targetCommitish: "0".repeat(40),
      assets: {
        dmg: getDesktopReleaseDmgAssetName("0.15.115"),
        zip: getDesktopReleaseZipAssetName("0.15.115"),
        updaterMetadata: DesktopReleaseUpdaterMetadataAssetName,
      },
      downloadUrl: "https://github.com/closedloop-ai/closedloop-ai/x.dmg",
    };

    expect(
      DesktopReleaseMetadataSchema.safeParse({
        ...base,
        channel: DesktopReleaseCandidateChannel,
      }).success
    ).toBe(true);
    expect(
      DesktopReleaseMetadataSchema.safeParse({
        ...base,
        channel: DesktopReleaseChannel,
      }).success
    ).toBe(true);
    expect(
      DesktopReleaseMetadataSchema.safeParse({
        ...base,
        channel: "desktop-beta",
      }).success
    ).toBe(false);
  });
});

// ISS-10424. Every name is written out rather than built from the module's own
// suffix or pattern: a fixture derived from the predicate agrees with it by
// construction, so these rows could not fail.
describe("updater blockmap asset names (ISS-10424)", () => {
  it.each([
    [
      "the updater ZIP",
      "Closedloop-0.17.20-universal-mac.zip",
      "Closedloop-0.17.20-universal-mac.zip",
    ],
    [
      "the updater ZIP's blockmap",
      "Closedloop-0.17.20-universal-mac.zip.blockmap",
      "Closedloop-0.17.20-universal-mac.zip",
    ],
    [
      "a pre-rename ZIP's blockmap (FEA-2101)",
      "ClosedLoop-0.16.1635-universal-mac.zip.blockmap",
      "ClosedLoop-0.16.1635-universal-mac.zip",
    ],
  ])("resolves %s to the ZIP it is served through", (_name, asset, zip) => {
    expect(getDesktopReleaseUpdaterZipAssetNameForAsset(asset)).toBe(zip);
  });

  it("recognizes only the ZIP's blockmap as a blockmap", () => {
    expect(
      isDesktopReleaseUpdaterBlockmapAssetName(
        "Closedloop-0.17.20-universal-mac.zip.blockmap"
      )
    ).toBe(true);
    expect(
      isDesktopReleaseUpdaterBlockmapAssetName(
        "Closedloop-0.17.20-universal-mac.zip"
      )
    ).toBe(false);
  });

  it.each([
    // electron-builder writes one, but the macOS updater never asks for it.
    ["a DMG blockmap", "Closedloop-0.17.20-universal.dmg.blockmap"],
    ["a feed blockmap", "latest-mac.yml.blockmap"],
    ["a metadata blockmap", "desktop-release.json.blockmap"],
    ["an arbitrary blockmap", "notes.blockmap"],
    ["a bare suffix", ".blockmap"],
    [
      "a doubled suffix",
      "Closedloop-0.17.20-universal-mac.zip.blockmap.blockmap",
    ],
    [
      "a differently cased suffix",
      "Closedloop-0.17.20-universal-mac.zip.BLOCKMAP",
    ],
    [
      "a non-semver ZIP's blockmap",
      "Closedloop-latest-universal-mac.zip.blockmap",
    ],
    ["path traversal", "../Closedloop-0.17.20-universal-mac.zip.blockmap"],
    ["a nested path", "x/Closedloop-0.17.20-universal-mac.zip.blockmap"],
    [
      "a backslash path",
      String.raw`x\Closedloop-0.17.20-universal-mac.zip.blockmap`,
    ],
    [
      "an encoded separator",
      "Closedloop-%2F0.17.20-universal-mac.zip.blockmap",
    ],
    ["an encoded suffix", "Closedloop-0.17.20-universal-mac.zip%2Eblockmap"],
  ])("serves nothing for %s", (_name, assetName) => {
    expect(getDesktopReleaseUpdaterZipAssetNameForAsset(assetName)).toBeNull();
    expect(isDesktopReleaseUpdaterBlockmapAssetName(assetName)).toBe(false);
  });
});
