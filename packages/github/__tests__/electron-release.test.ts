import {
  DesktopReleaseCandidateChannel,
  DesktopReleaseChannel,
  DesktopReleaseMetadataAssetName,
  DesktopReleaseOwner,
  DesktopReleaseRepo,
  DesktopReleaseUpdaterMetadataAssetName,
  getDesktopReleaseLegacyZipAssetName,
  getDesktopReleaseTag,
  getDesktopReleaseZipAssetName,
  getPublicDesktopReleaseDownloadUrl,
} from "@repo/api/src/types/desktop-release";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DesktopRelease,
  parseDesktopReleaseMetadata,
  resolveElectronUpdaterAssetRedirectUrl,
  selectLatestDesktopRelease,
  selectLatestDesktopReleaseFromPages,
  selectLatestElectronUpdaterFeed,
} from "../electron-release";
import {
  DMG_ASSET,
  DOWNLOAD_URL,
  FEED_TEXT,
  makeAsset,
  makeDesktopRelease,
  makeDesktopReleaseForVersion,
  makeMetadata,
  SIGNED_REDIRECT_URL,
  TAG,
  VERSION,
  ZIP_ASSET,
} from "./electron-release-fixtures";

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const STALE_ZIP_ASSET = "Closedloop-0.15.114-universal-mac.zip";
// The login-free public mirror URL the release workflow writes into
// downloadUrl once the DMG is mirrored (FEA-3372).
const MIRROR_DOWNLOAD_URL = getPublicDesktopReleaseDownloadUrl(VERSION);

describe("selectLatestDesktopRelease public mirror (FEA-3372)", () => {
  it("resolves a release whose downloadUrl points at the public mirror", async () => {
    // The keystone case. The DMG asset still lives on this (private) release, but
    // downloadUrl now points at the public mirror so the public can download it
    // without a GitHub account. The completeness check used to require those two
    // to be equal, so this returned null — 404ing the download for EVERYONE,
    // team included. Fails on main before the isCompleteDesktopRelease change.
    const release = await selectLatestDesktopRelease(
      [makeDesktopRelease()],
      () =>
        Promise.resolve(
          JSON.stringify({
            ...makeMetadata(),
            downloadUrl: MIRROR_DOWNLOAD_URL,
          })
        )
    );

    expect(release).toEqual({
      downloadUrl: MIRROR_DOWNLOAD_URL,
      version: VERSION,
      releaseNotes: "Desktop release notes",
    });
  });

  it("still resolves the private asset URL when the mirror failed", async () => {
    // NFR-2 fallback: a failed mirror leaves downloadUrl on the private repo and
    // the release must still resolve. Asserted explicitly rather than leaning on
    // the pre-existing happy-path test, so a future tightening of the mirror arm
    // cannot silently drop this path.
    const release = await selectLatestDesktopRelease(
      [makeDesktopRelease()],
      loadMetadata
    );

    expect(release).toEqual({
      downloadUrl: DOWNLOAD_URL,
      version: VERSION,
      releaseNotes: "Desktop release notes",
    });
  });

  it("returns null when the mirror downloadUrl is for a different version", async () => {
    // The relaxed equality must not become "any allowlisted URL rides on any
    // release" — a cross-version swap is still a mismatch.
    const release = await selectLatestDesktopRelease(
      [makeDesktopRelease()],
      () =>
        Promise.resolve(
          JSON.stringify({
            ...makeMetadata(),
            downloadUrl: getPublicDesktopReleaseDownloadUrl("9.9.9"),
          })
        )
    );

    expect(release).toBeNull();
  });
});

describe("selectLatestDesktopRelease", () => {
  it("ignores newer non-Desktop closedloop-ai releases", async () => {
    const release = await selectLatestDesktopRelease(
      [makeNonDesktopRelease("deploy-2026-06-07"), makeDesktopRelease()],
      loadMetadata
    );

    expect(release).toEqual({
      downloadUrl: DOWNLOAD_URL,
      version: VERSION,
      releaseNotes: "Desktop release notes",
    });
  });

  it("skips the desktop-latest feed when selecting a web download", async () => {
    const loadMetadataSpy = vi.fn(loadMetadata);
    const release = await selectLatestDesktopRelease(
      [
        makeDesktopRelease({
          tagName: DesktopReleaseChannel,
          body: "Updater feed",
        }),
        makeDesktopRelease(),
      ],
      loadMetadataSpy
    );

    expect(release).toEqual({
      downloadUrl: DOWNLOAD_URL,
      version: VERSION,
      releaseNotes: "Desktop release notes",
    });
    expect(loadMetadataSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * ISS-9165 AC — the public download page never lists a candidate.
   *
   * The candidate release carries COMPLETE desktop metadata and is newer than
   * the promoted one, so the only thing keeping it off the download page is that
   * its tag is the rolling channel name rather than a `desktop-v*` version. That
   * is the load-bearing half of "candidate assets live only on the rolling
   * release", and it is asserted here rather than assumed.
   */
  it("skips the desktop-candidate release and picks the promoted versioned one", async () => {
    const loadMetadataSpy = vi.fn(loadMetadata);

    const release = await selectLatestDesktopRelease(
      [
        makeDesktopRelease({
          tagName: DesktopReleaseCandidateChannel,
          body: "Candidate build",
        }),
        makeDesktopRelease(),
      ],
      loadMetadataSpy
    );

    expect(release).toEqual({
      downloadUrl: DOWNLOAD_URL,
      version: VERSION,
      releaseNotes: "Desktop release notes",
    });
    // The candidate's metadata is never even read, so a candidate cannot fail
    // the release closed the way a malformed promoted release does.
    expect(loadMetadataSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null when Desktop metadata is malformed", async () => {
    const release = makeDesktopRelease();
    const selected = await selectLatestDesktopRelease([release], async () =>
      JSON.stringify({ owner: DesktopReleaseOwner })
    );

    expect(selected).toBeNull();
  });

  it("fails closed instead of falling back when the newest Desktop release is draft", async () => {
    const selected = await selectLatestDesktopRelease(
      [
        makeDesktopRelease({
          draft: true,
          tagName: getDesktopReleaseTag("0.15.116"),
        }),
        makeDesktopRelease(),
      ],
      loadMetadata
    );

    expect(selected).toBeNull();
  });

  it("returns null when a required Desktop asset is missing", async () => {
    const release = makeDesktopRelease({
      assets: [
        makeAsset(1, DesktopReleaseMetadataAssetName),
        makeAsset(2, DMG_ASSET, DOWNLOAD_URL),
        makeAsset(4, DesktopReleaseUpdaterMetadataAssetName),
      ],
    });
    const selected = await selectLatestDesktopRelease([release], loadMetadata);

    expect(selected).toBeNull();
  });

  it("fails closed instead of falling back when the newest Desktop release is incomplete", async () => {
    const selected = await selectLatestDesktopRelease(
      [
        makeDesktopRelease({
          assets: [
            makeAsset(1, DesktopReleaseMetadataAssetName),
            makeAsset(2, DMG_ASSET, DOWNLOAD_URL),
            makeAsset(4, DesktopReleaseUpdaterMetadataAssetName),
          ],
          tagName: getDesktopReleaseTag("0.15.116"),
        }),
        makeDesktopRelease(),
      ],
      loadMetadata
    );

    expect(selected).toBeNull();
  });

  it("rejects stale closedloop-electron download URLs", async () => {
    const metadata = parseDesktopReleaseMetadata(
      JSON.stringify({
        ...makeMetadata(),
        downloadUrl:
          "https://github.com/closedloop-ai/closedloop-electron/releases/download/v0.15.115/Closedloop-0.15.115-universal.dmg",
      })
    );

    expect(metadata).not.toBeNull();
    await expect(
      selectLatestDesktopRelease([makeDesktopRelease()], async () =>
        JSON.stringify({
          ...makeMetadata(),
          downloadUrl:
            "https://github.com/closedloop-ai/closedloop-electron/releases/download/v0.15.115/Closedloop-0.15.115-universal.dmg",
        })
      )
    ).resolves.toBeNull();
  });

  it("rejects malformed percent-encoded download URLs without throwing", async () => {
    await expect(
      selectLatestDesktopRelease([makeDesktopRelease()], async () =>
        JSON.stringify({
          ...makeMetadata(),
          downloadUrl:
            "https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-v0.15.115/Closedloop-%E0%A4%A-universal.dmg",
        })
      )
    ).resolves.toBeNull();
  });

  it("rejects non-semver metadata versions", () => {
    const metadata = parseDesktopReleaseMetadata(
      JSON.stringify({
        ...makeMetadata(),
        version: "latest",
        tagName: "desktop-vlatest",
      })
    );

    expect(metadata).toBeNull();
  });

  it("rejects metadata assets that do not match the parsed version", async () => {
    await expect(
      selectLatestDesktopRelease([makeDesktopRelease()], async () =>
        JSON.stringify({
          ...makeMetadata(),
          assets: {
            ...makeMetadata().assets,
            dmg: "Closedloop-9.9.9-universal.dmg",
          },
        })
      )
    ).resolves.toBeNull();
  });

  it("accepts a pre-rename ClosedLoop-* release end-to-end during the brand transition (FEA-2101)", async () => {
    // Regression guard for the dead-code gap: isCompleteDesktopRelease must
    // accept the legacy DMG/ZIP names, otherwise the still-published legacy
    // release on desktop-latest is dropped and existing installs cannot update
    // until the next desktop release publishes.
    const legacyDmg = `ClosedLoop-${VERSION}-universal.dmg`;
    const legacyZip = `ClosedLoop-${VERSION}-universal-mac.zip`;
    const legacyDownloadUrl = `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${TAG}/${legacyDmg}`;
    const legacyRelease = makeDesktopRelease({
      assets: [
        makeAsset(1, DesktopReleaseMetadataAssetName),
        makeAsset(2, legacyDmg, legacyDownloadUrl),
        makeAsset(3, legacyZip),
        makeAsset(4, DesktopReleaseUpdaterMetadataAssetName),
      ],
    });

    await expect(
      selectLatestDesktopRelease([legacyRelease], async () =>
        JSON.stringify({
          ...makeMetadata(),
          assets: {
            dmg: legacyDmg,
            zip: legacyZip,
            updaterMetadata: DesktopReleaseUpdaterMetadataAssetName,
          },
          downloadUrl: legacyDownloadUrl,
        })
      )
    ).resolves.toEqual({
      downloadUrl: legacyDownloadUrl,
      version: VERSION,
      releaseNotes: "Desktop release notes",
    });
  });

  it("returns null when the metadata asset is not JSON at all", async () => {
    await expect(
      selectLatestDesktopRelease(
        [makeDesktopRelease()],
        async () => "<html>502 Bad Gateway</html>"
      )
    ).resolves.toBeNull();
  });

  it("returns empty release notes when the release has no body", async () => {
    await expect(
      selectLatestDesktopRelease(
        [makeDesktopRelease({ body: null })],
        loadMetadata
      )
    ).resolves.toEqual({
      downloadUrl: DOWNLOAD_URL,
      version: VERSION,
      releaseNotes: "",
    });
  });

  it("rejects a ZIP asset name published for another version", async () => {
    // The stale ZIP is attached to the release, so the later asset-presence
    // check cannot be what rejects this — only the name/version guard can.
    await expect(
      selectLatestDesktopRelease(
        [
          makeDesktopRelease({
            assets: [
              ...makeDesktopRelease().assets,
              makeAsset(5, STALE_ZIP_ASSET),
            ],
          }),
        ],
        async () =>
          JSON.stringify({
            ...makeMetadata(),
            assets: { ...makeMetadata().assets, zip: STALE_ZIP_ASSET },
          })
      )
    ).resolves.toBeNull();
  });
});

describe("selectLatestDesktopReleaseFromPages", () => {
  it("pages past a full page of newer non-Desktop releases", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      makeNonDesktopRelease(`deploy-2026-06-07-${index}`)
    );
    const listReleasePage = vi.fn(async (page: number) =>
      page === 1 ? firstPage : [makeDesktopRelease()]
    );

    const release = await selectLatestDesktopReleaseFromPages(
      listReleasePage,
      loadMetadata
    );

    expect(release).toEqual({
      downloadUrl: DOWNLOAD_URL,
      version: VERSION,
      releaseNotes: "Desktop release notes",
    });
    expect(listReleasePage).toHaveBeenNthCalledWith(1, 1, 100);
    expect(listReleasePage).toHaveBeenNthCalledWith(2, 2, 100);
  });

  it("stops paging on the first short page and returns null", async () => {
    // A full first page must not end the walk (that is the page-size boundary);
    // the short second page is what proves there is nothing left to read.
    const fullPage = Array.from({ length: 100 }, (_, index) =>
      makeNonDesktopRelease(`deploy-2026-06-07-${index}`)
    );
    const listReleasePage = vi.fn(async (page: number) =>
      page === 1 ? fullPage : [makeNonDesktopRelease("deploy-2026-06-08")]
    );

    await expect(
      selectLatestDesktopReleaseFromPages(listReleasePage, loadMetadata)
    ).resolves.toBeNull();
    expect(listReleasePage).toHaveBeenCalledTimes(2);
  });
});

describe("selectLatestElectronUpdaterFeed", () => {
  it("selects the desktop-latest latest-mac.yml asset text", async () => {
    const feed = await selectLatestElectronUpdaterFeed(
      makeDesktopRelease({ tagName: DesktopReleaseChannel }),
      loadUpdaterAssetText
    );

    expect(feed).toBe(FEED_TEXT);
  });

  it("returns null when the channel feed asset is missing", async () => {
    const feed = await selectLatestElectronUpdaterFeed(
      makeDesktopRelease({
        tagName: DesktopReleaseChannel,
        assets: [makeAsset(1, DesktopReleaseMetadataAssetName)],
      }),
      loadUpdaterAssetText
    );

    expect(feed).toBeNull();
  });

  it.each<[string, DesktopRelease | null]>([
    ["the channel release is missing", null],
    [
      "the channel release is a draft",
      makeDesktopRelease({ tagName: DesktopReleaseChannel, draft: true }),
    ],
  ])("returns null without reading assets when %s", async (_name, release) => {
    const loadText = vi.fn(loadUpdaterAssetText);

    await expect(
      selectLatestElectronUpdaterFeed(release, loadText)
    ).resolves.toBeNull();
    expect(loadText).not.toHaveBeenCalled();
  });
});

describe("resolveElectronUpdaterAssetRedirectUrl", () => {
  it("redirects only the current ZIP derived from latest-mac.yml", async () => {
    const loadRedirect = vi.fn(async () => ({
      status: 302,
      headers: { location: SIGNED_REDIRECT_URL },
    }));

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        ZIP_ASSET,
        loadUpdaterAssetText,
        loadRedirect
      )
    ).resolves.toBe(SIGNED_REDIRECT_URL);
    expect(loadRedirect).toHaveBeenCalledTimes(1);
  });

  it("falls back to desktop-release.json metadata when the feed cannot identify a ZIP", async () => {
    const loadText = vi.fn(async (asset) =>
      asset.name === DesktopReleaseUpdaterMetadataAssetName
        ? "version: 0.15.115\n"
        : JSON.stringify(makeMetadata())
    );

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        ZIP_ASSET,
        loadText,
        loadAllowedRedirect
      )
    ).resolves.toBe(SIGNED_REDIRECT_URL);
  });

  it("keeps the feed ZIP authoritative when metadata names another ZIP", async () => {
    const metadataOnlyZip = "Closedloop-0.15.116-universal-mac.zip";
    const loadText = vi.fn(async (asset) =>
      asset.name === DesktopReleaseUpdaterMetadataAssetName
        ? FEED_TEXT
        : JSON.stringify({
            ...makeMetadata(),
            assets: { ...makeMetadata().assets, zip: metadataOnlyZip },
          })
    );

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({
          tagName: DesktopReleaseChannel,
          assets: [
            ...makeDesktopRelease().assets,
            makeAsset(5, metadataOnlyZip),
          ],
        }),
        metadataOnlyZip,
        loadText,
        loadAllowedRedirect
      )
    ).resolves.toBeNull();
  });

  it("returns null for a stale semver ZIP even when it is present on the release", async () => {
    const loadRedirect = vi.fn(loadAllowedRedirect);

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({
          tagName: DesktopReleaseChannel,
          assets: [
            ...makeDesktopRelease().assets,
            makeAsset(5, STALE_ZIP_ASSET),
          ],
        }),
        STALE_ZIP_ASSET,
        loadUpdaterAssetText,
        loadRedirect
      )
    ).resolves.toBeNull();
    expect(loadRedirect).not.toHaveBeenCalled();
  });

  it("resolves a stale semver ZIP from its matching versioned release", async () => {
    const staleVersion = "0.15.114";
    const staleZipAsset = getDesktopReleaseZipAssetName(staleVersion);
    const loadVersionedRelease = vi.fn(async (tagName: string) =>
      tagName === getDesktopReleaseTag(staleVersion)
        ? makeDesktopReleaseForVersion(staleVersion)
        : null
    );
    const loadRedirect = vi.fn(loadAllowedRedirect);

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        staleZipAsset,
        loadUpdaterAssetText,
        loadRedirect,
        loadVersionedRelease
      )
    ).resolves.toBe(SIGNED_REDIRECT_URL);
    expect(loadVersionedRelease).toHaveBeenCalledWith(
      getDesktopReleaseTag(staleVersion)
    );
    expect(loadRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ name: staleZipAsset })
    );
  });

  it("does not resolve a newer versioned ZIP before the channel points at it", async () => {
    const futureVersion = "0.15.116";
    const futureZipAsset = getDesktopReleaseZipAssetName(futureVersion);
    const loadVersionedRelease = vi.fn(async () =>
      makeDesktopReleaseForVersion(futureVersion)
    );
    const loadRedirect = vi.fn(loadAllowedRedirect);

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        futureZipAsset,
        loadUpdaterAssetText,
        loadRedirect,
        loadVersionedRelease
      )
    ).resolves.toBeNull();
    expect(loadVersionedRelease).not.toHaveBeenCalled();
    expect(loadRedirect).not.toHaveBeenCalled();
  });

  it("resolves a stale ZIP when the current channel cannot name its ZIP", async () => {
    const staleVersion = "0.15.114";
    const staleZipAsset = getDesktopReleaseZipAssetName(staleVersion);
    const loadVersionedRelease = vi.fn(async () =>
      makeDesktopReleaseForVersion(staleVersion)
    );
    const loadRedirect = vi.fn(loadAllowedRedirect);

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({
          tagName: DesktopReleaseChannel,
          assets: [makeAsset(4, DesktopReleaseUpdaterMetadataAssetName)],
        }),
        staleZipAsset,
        async () => "version: 0.15.115\n",
        loadRedirect,
        loadVersionedRelease
      )
    ).resolves.toBe(SIGNED_REDIRECT_URL);
    expect(loadVersionedRelease).toHaveBeenCalledWith(
      getDesktopReleaseTag(staleVersion)
    );
    expect(loadRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ name: staleZipAsset })
    );
  });

  it.each([
    ["current", VERSION],
    ["future", "0.15.116"],
  ])(
    "does not resolve a %s ZIP when the current channel can only name its version",
    async (_name, requestedVersion) => {
      const requestedZipAsset = getDesktopReleaseZipAssetName(requestedVersion);
      const loadVersionedRelease = vi.fn(async () =>
        makeDesktopReleaseForVersion(requestedVersion)
      );
      const loadRedirect = vi.fn(loadAllowedRedirect);

      await expect(
        resolveElectronUpdaterAssetRedirectUrl(
          makeDesktopRelease({
            tagName: DesktopReleaseChannel,
            assets: [makeAsset(4, DesktopReleaseUpdaterMetadataAssetName)],
          }),
          requestedZipAsset,
          async () => `version: ${VERSION}\n`,
          loadRedirect,
          loadVersionedRelease
        )
      ).resolves.toBeNull();
      expect(loadVersionedRelease).not.toHaveBeenCalled();
      expect(loadRedirect).not.toHaveBeenCalled();
    }
  );

  it("returns null when the matching versioned release is missing", async () => {
    const staleVersion = "0.15.114";
    const staleZipAsset = getDesktopReleaseZipAssetName(staleVersion);
    const loadVersionedRelease = vi.fn(async () => null);
    const loadRedirect = vi.fn(loadAllowedRedirect);

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        staleZipAsset,
        loadUpdaterAssetText,
        loadRedirect,
        loadVersionedRelease
      )
    ).resolves.toBeNull();
    expect(loadRedirect).not.toHaveBeenCalled();
  });

  it("returns null when the matching versioned release is draft", async () => {
    const staleVersion = "0.15.114";
    const staleZipAsset = getDesktopReleaseZipAssetName(staleVersion);
    const loadVersionedRelease = vi.fn(async () =>
      makeDesktopReleaseForVersion(staleVersion, { draft: true })
    );
    const loadRedirect = vi.fn(loadAllowedRedirect);

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        staleZipAsset,
        loadUpdaterAssetText,
        loadRedirect,
        loadVersionedRelease
      )
    ).resolves.toBeNull();
    expect(loadRedirect).not.toHaveBeenCalled();
  });

  it("returns null when the matching versioned release is missing the stale ZIP", async () => {
    const staleVersion = "0.15.114";
    const staleZipAsset = getDesktopReleaseZipAssetName(staleVersion);
    const loadVersionedRelease = vi.fn(async () =>
      makeDesktopReleaseForVersion(staleVersion, {
        zipAssetName: getDesktopReleaseZipAssetName("0.15.113"),
      })
    );
    const loadRedirect = vi.fn(loadAllowedRedirect);

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        staleZipAsset,
        loadUpdaterAssetText,
        loadRedirect,
        loadVersionedRelease
      )
    ).resolves.toBeNull();
    expect(loadRedirect).not.toHaveBeenCalled();
  });

  it("keeps pre-rename ClosedLoop ZIP requests compatible through versioned fallback", async () => {
    const legacyVersion = "0.15.114";
    const legacyZipAsset = getDesktopReleaseLegacyZipAssetName(legacyVersion);
    const loadVersionedRelease = vi.fn(async () =>
      makeDesktopReleaseForVersion(legacyVersion, {
        zipAssetName: legacyZipAsset,
      })
    );

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        legacyZipAsset,
        loadUpdaterAssetText,
        loadAllowedRedirect,
        loadVersionedRelease
      )
    ).resolves.toBe(SIGNED_REDIRECT_URL);
  });

  it.each([
    ["blockmap", `${ZIP_ASSET}.blockmap`],
    ["DMG", DMG_ASSET],
    ["metadata", DesktopReleaseMetadataAssetName],
    ["feed", DesktopReleaseUpdaterMetadataAssetName],
    ["traversal", `../${ZIP_ASSET}`],
    ["unknown", "notes.txt"],
  ])("returns null for %s requests", async (_name, assetName) => {
    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        assetName,
        loadUpdaterAssetText,
        loadAllowedRedirect
      )
    ).resolves.toBeNull();
  });

  it("returns null when the current ZIP asset is missing", async () => {
    const loadVersionedRelease = vi.fn(async () =>
      makeDesktopReleaseForVersion(VERSION)
    );

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({
          tagName: DesktopReleaseChannel,
          assets: [
            makeAsset(1, DesktopReleaseMetadataAssetName),
            makeAsset(4, DesktopReleaseUpdaterMetadataAssetName),
          ],
        }),
        ZIP_ASSET,
        loadUpdaterAssetText,
        loadAllowedRedirect,
        loadVersionedRelease
      )
    ).resolves.toBeNull();
    expect(loadVersionedRelease).not.toHaveBeenCalled();
  });

  it.each([
    ["streamed 200 response", { status: 200, headers: {} }],
    ["non-redirect 2xx response", { status: 204, headers: {} }],
    ["missing location", { status: 302, headers: {} }],
    ["malformed location", { status: 302, headers: { location: "not a url" } }],
    [
      "disallowed location host",
      { status: 302, headers: { location: "https://example.com/asset.zip" } },
    ],
  ])(
    "throws when GitHub returns %s for the current ZIP",
    async (_name, response) => {
      await expect(
        resolveElectronUpdaterAssetRedirectUrl(
          makeDesktopRelease({ tagName: DesktopReleaseChannel }),
          ZIP_ASSET,
          loadUpdaterAssetText,
          async () => response
        )
      ).rejects.toThrow("Desktop updater asset redirect unavailable");
    }
  );

  it("returns null when neither the feed nor a metadata asset names a ZIP", async () => {
    const loadRedirect = vi.fn(loadAllowedRedirect);

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({
          tagName: DesktopReleaseChannel,
          assets: [
            makeAsset(3, ZIP_ASSET),
            makeAsset(4, DesktopReleaseUpdaterMetadataAssetName),
          ],
        }),
        ZIP_ASSET,
        async () => "version: 0.15.115\n",
        loadRedirect
      )
    ).resolves.toBeNull();
    expect(loadRedirect).not.toHaveBeenCalled();
  });

  it("returns null when the metadata fallback asset is not JSON", async () => {
    const loadRedirect = vi.fn(loadAllowedRedirect);

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        ZIP_ASSET,
        async (asset) =>
          asset.name === DesktopReleaseUpdaterMetadataAssetName
            ? "version: 0.15.115\n"
            : "<html>502 Bad Gateway</html>",
        loadRedirect
      )
    ).resolves.toBeNull();
    expect(loadRedirect).not.toHaveBeenCalled();
  });

  it("resolves the ZIP from metadata when the channel has no feed asset", async () => {
    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({
          tagName: DesktopReleaseChannel,
          assets: [
            makeAsset(1, DesktopReleaseMetadataAssetName),
            makeAsset(3, ZIP_ASSET),
          ],
        }),
        ZIP_ASSET,
        loadMetadata,
        loadAllowedRedirect
      )
    ).resolves.toBe(SIGNED_REDIRECT_URL);
  });

  it("accepts a single-valued location header array", async () => {
    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        ZIP_ASSET,
        loadUpdaterAssetText,
        async () => ({
          status: 302,
          headers: { location: [SIGNED_REDIRECT_URL] },
        })
      )
    ).resolves.toBe(SIGNED_REDIRECT_URL);
  });

  it("throws when the location header carries more than one value", async () => {
    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        ZIP_ASSET,
        loadUpdaterAssetText,
        async () => ({
          status: 302,
          headers: { location: [SIGNED_REDIRECT_URL, SIGNED_REDIRECT_URL] },
        })
      )
    ).rejects.toThrow("Desktop updater asset redirect unavailable");
  });
});

describe("selectLatestDesktopRelease skipped feeds", () => {
  const SKIP_MESSAGE =
    "[github/electron-release] Skipping non-versioned Desktop release feed";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("warns about an unversioned tag that is not a rolling channel and keeps looking", async () => {
    const release = await selectLatestDesktopRelease(
      [
        makeDesktopRelease({ tagName: "desktop-unknown" }),
        makeDesktopRelease(),
      ],
      loadMetadata
    );

    expect(release?.version).toBe(VERSION);
    expect(log.warn).toHaveBeenCalledWith(SKIP_MESSAGE, {
      tag: "desktop-unknown",
    });
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("logs a rolling channel skip at debug, never as a warning", async () => {
    const release = await selectLatestDesktopRelease(
      [
        makeDesktopRelease({ tagName: DesktopReleaseCandidateChannel }),
        makeDesktopRelease(),
      ],
      loadMetadata
    );

    expect(release?.version).toBe(VERSION);
    expect(log.debug).toHaveBeenCalledWith(SKIP_MESSAGE, {
      tag: DesktopReleaseCandidateChannel,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("resolveElectronUpdaterAssetRedirectUrl staleness ordering", () => {
  // The channel names only a version (no ZIP), so staleness is decided purely
  // by comparing the requested ZIP's version against the feed version.
  it.each([
    ["major", "1.0.0", "0.15.114", true],
    ["major", "0.15.115", "1.0.0", false],
    ["minor", "0.16.0", "0.15.114", true],
    ["minor", "0.15.115", "0.16.0", false],
  ])(
    "compares %s first: channel %s, requested %s, resolves versioned release: %s",
    async (_part, channelVersion, requestedVersion, resolves) => {
      const requestedZipAsset = getDesktopReleaseZipAssetName(requestedVersion);
      const loadVersionedRelease = vi.fn(async () =>
        makeDesktopReleaseForVersion(requestedVersion)
      );

      const result = await resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({
          tagName: DesktopReleaseChannel,
          assets: [makeAsset(4, DesktopReleaseUpdaterMetadataAssetName)],
        }),
        requestedZipAsset,
        async () => `version: ${channelVersion}\n`,
        loadAllowedRedirect,
        loadVersionedRelease
      );

      expect(result).toBe(resolves ? SIGNED_REDIRECT_URL : null);
      expect(loadVersionedRelease).toHaveBeenCalledTimes(resolves ? 1 : 0);
    }
  );

  it("treats a requested ZIP as not stale when the channel exposes no version at all", async () => {
    const loadVersionedRelease = vi.fn(async () =>
      makeDesktopReleaseForVersion("0.15.114")
    );

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({
          tagName: DesktopReleaseChannel,
          assets: [makeAsset(4, DesktopReleaseUpdaterMetadataAssetName)],
        }),
        getDesktopReleaseZipAssetName("0.15.114"),
        async () => "files: []\n",
        loadAllowedRedirect,
        loadVersionedRelease
      )
    ).resolves.toBeNull();
    expect(loadVersionedRelease).not.toHaveBeenCalled();
  });
});

function makeNonDesktopRelease(tagName: string): DesktopRelease {
  return {
    tagName,
    body: "Deploy release",
    draft: false,
    assets: [makeAsset(10, "deployment.json")],
  };
}

function loadMetadata() {
  return Promise.resolve(JSON.stringify(makeMetadata()));
}

function loadUpdaterAssetText(asset: { name: string }) {
  if (asset.name === DesktopReleaseUpdaterMetadataAssetName) {
    return Promise.resolve(FEED_TEXT);
  }
  return Promise.resolve(JSON.stringify(makeMetadata()));
}

function loadAllowedRedirect() {
  return Promise.resolve({
    status: 302,
    headers: { location: SIGNED_REDIRECT_URL },
  });
}
