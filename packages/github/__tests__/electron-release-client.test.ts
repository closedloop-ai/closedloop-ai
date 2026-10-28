import type { Octokit } from "@octokit/rest";
import {
  DesktopReleaseCandidateChannel,
  DesktopReleaseChannel,
  DesktopReleaseOwner,
  DesktopReleaseRepo,
  DesktopReleaseStagedUpdaterMetadataAssetName,
  DesktopReleaseUpdaterMetadataAssetName,
  getDesktopReleaseTag,
  getDesktopReleaseZipAssetName,
} from "@repo/api/src/types/desktop-release";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));

vi.mock("../index", () => ({
  getAuthenticatedOctokit: vi.fn(),
}));
vi.mock("@repo/observability/log", () => ({
  log: {
    error: mockLogError,
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  type DesktopRelease,
  getElectronUpdaterAssetRedirectUrl,
  getLatestElectronRelease,
  getLatestElectronUpdaterFeed,
} from "../electron-release";
import { getAuthenticatedOctokit } from "../index";
import {
  DOWNLOAD_URL,
  FEED_TEXT,
  makeAsset,
  makeDesktopRelease,
  makeDesktopReleaseForVersion,
  makeMetadata,
  SIGNED_REDIRECT_URL,
  VERSION,
  ZIP_ASSET,
} from "./electron-release-fixtures";

// The two ring channel lists, as `desktopReleaseChannelsForRing` returns them.
const PROMOTED_ONLY = [DesktopReleaseChannel] as const;
const CANDIDATE_FIRST = [
  DesktopReleaseCandidateChannel,
  DesktopReleaseChannel,
] as const;

// Declared above the suites because `it.each` reads the table while the
// describe body runs.
const GITHUB_CLIENT_ENTRY_POINTS: [string, () => Promise<unknown>][] = [
  ["getLatestElectronRelease", () => getLatestElectronRelease()],
  [
    "getLatestElectronUpdaterFeed",
    () => getLatestElectronUpdaterFeed(PROMOTED_ONLY),
  ],
  [
    "getElectronUpdaterAssetRedirectUrl",
    () => getElectronUpdaterAssetRedirectUrl(ZIP_ASSET, PROMOTED_ONLY),
  ],
];

describe("getLatestElectronRelease", () => {
  beforeEach(() => {
    resetGitHubClientMocks();
  });

  it.each<[string, (metadataJson: string) => unknown]>([
    ["a UTF-8 string", (metadataJson) => metadataJson],
    [
      "an ArrayBuffer",
      (metadataJson) => new TextEncoder().encode(metadataJson).buffer,
    ],
    [
      "a Uint8Array view",
      (metadataJson) => new TextEncoder().encode(metadataJson),
    ],
    // Pins current behavior; a Buffer is an ArrayBuffer view, so it decodes
    // through the view arm and the later Buffer.isBuffer arm is unreachable.
    ["a Buffer", (metadataJson) => Buffer.from(metadataJson, "utf8")],
    ["an already-parsed object", () => makeMetadata()],
  ])(
    "reads the metadata asset when GitHub returns %s",
    async (_name, encodeAssetData) => {
      const metadataJson = JSON.stringify(makeMetadata());
      vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
        makeOctokit({
          listReleases: vi.fn(async () => ({
            data: [toGitHubRelease(makeDesktopRelease())],
          })),
          request: vi.fn(async () => ({
            data: encodeAssetData(metadataJson),
          })),
        })
      );

      await expect(getLatestElectronRelease()).resolves.toEqual({
        downloadUrl: DOWNLOAD_URL,
        version: VERSION,
        releaseNotes: "Desktop release notes",
      });
    }
  );

  it("normalizes a null GitHub release body to empty release notes", async () => {
    vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
      makeOctokit({
        listReleases: vi.fn(async () => ({
          data: [toGitHubRelease(makeDesktopRelease({ body: null }))],
        })),
        request: vi.fn(async () => ({
          data: JSON.stringify(makeMetadata()),
        })),
      })
    );

    await expect(getLatestElectronRelease()).resolves.toEqual({
      downloadUrl: DOWNLOAD_URL,
      version: VERSION,
      releaseNotes: "",
    });
  });

  it("rethrows a listing failure without logging it", async () => {
    // Pins current behavior; looks odd because the handler returns the
    // selection promise instead of awaiting it, so every failure raised after
    // the Octokit resolves escapes the catch block that logs.
    vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
      makeOctokit({
        listReleases: vi.fn(() =>
          Promise.reject(new Error("secondary rate limit"))
        ),
      })
    );

    await expect(getLatestElectronRelease()).rejects.toThrow(
      "secondary rate limit"
    );
    expect(mockLogError).not.toHaveBeenCalled();
  });
});

describe("getLatestElectronUpdaterFeed", () => {
  beforeEach(() => {
    resetGitHubClientMocks();
  });

  it("reads the feed from the desktop-latest channel release", async () => {
    const getReleaseByTag = vi.fn(async () => ({
      data: toGitHubRelease(
        makeDesktopRelease({ tagName: DesktopReleaseChannel })
      ),
    }));
    vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
      makeOctokit({
        getReleaseByTag,
        request: vi.fn(async () => ({ data: FEED_TEXT })),
      })
    );

    await expect(getLatestElectronUpdaterFeed(PROMOTED_ONLY)).resolves.toBe(
      FEED_TEXT
    );
    expect(getReleaseByTag).toHaveBeenCalledWith({
      owner: DesktopReleaseOwner,
      repo: DesktopReleaseRepo,
      tag: DesktopReleaseChannel,
    });
  });

  /**
   * ISS-9165 — the channel argument has to reach `getReleaseByTag`, not just be
   * accepted. Everything between the route and here returns a feed either way,
   * so this is the only place the wrong channel is observable.
   */
  it("reads the candidate release when asked for the candidate channel", async () => {
    const getReleaseByTag = vi.fn(async () => ({
      data: toGitHubRelease(
        makeDesktopRelease({ tagName: DesktopReleaseCandidateChannel })
      ),
    }));
    vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
      makeOctokit({
        getReleaseByTag,
        request: vi.fn(async () => ({ data: FEED_TEXT })),
      })
    );

    await expect(getLatestElectronUpdaterFeed(CANDIDATE_FIRST)).resolves.toBe(
      FEED_TEXT
    );
    expect(getReleaseByTag).toHaveBeenCalledWith({
      owner: DesktopReleaseOwner,
      repo: DesktopReleaseRepo,
      tag: DesktopReleaseCandidateChannel,
    });
  });

  /**
   * ISS-9165 — the internal ring's fallback, and the reason this change is safe
   * to land before the candidate workflow exists.
   *
   * `desktop-candidate` has no release until the candidate workflow first
   * publishes it, and it is legitimately re-pointed by hand when a candidate is
   * bad. Without this fallback both windows 404 the updater feed for every
   * internal-ring install — which is every ClosedLoop staff machine.
   */
  it("falls back to the promoted channel when the candidate release does not exist", async () => {
    const getReleaseByTag = vi.fn(({ tag }: { tag: string }) => {
      if (tag === DesktopReleaseCandidateChannel) {
        return Promise.reject(
          Object.assign(new Error("Not Found"), { status: 404 })
        );
      }
      return Promise.resolve({
        data: toGitHubRelease(
          makeDesktopRelease({ tagName: DesktopReleaseChannel })
        ),
      });
    });
    vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
      makeOctokit({
        getReleaseByTag,
        request: vi.fn(async () => ({ data: FEED_TEXT })),
      })
    );

    await expect(getLatestElectronUpdaterFeed(CANDIDATE_FIRST)).resolves.toBe(
      FEED_TEXT
    );
    // Order matters: the candidate is asked for FIRST, so a published candidate
    // always wins and the fallback only runs when there is nothing to win with.
    expect(getReleaseByTag.mock.calls.map(([args]) => args.tag)).toEqual([
      DesktopReleaseCandidateChannel,
      DesktopReleaseChannel,
    ]);
  });

  it("returns null when no channel in the list has a feed", async () => {
    vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
      makeOctokit({
        getReleaseByTag: vi.fn(() =>
          Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }))
        ),
      })
    );

    await expect(
      getLatestElectronUpdaterFeed(CANDIDATE_FIRST)
    ).resolves.toBeNull();
  });

  it("returns null when the channel release does not exist", async () => {
    vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
      makeOctokit({
        getReleaseByTag: vi.fn(() =>
          Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }))
        ),
      })
    );

    await expect(
      getLatestElectronUpdaterFeed(PROMOTED_ONLY)
    ).resolves.toBeNull();
  });

  it("returns null without reading assets when the channel release is a draft", async () => {
    const request = vi.fn();
    vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
      makeOctokit({
        getReleaseByTag: vi.fn(async () => ({
          data: toGitHubRelease(
            makeDesktopRelease({
              tagName: DesktopReleaseChannel,
              draft: true,
              body: null,
            })
          ),
        })),
        request,
      })
    );

    await expect(
      getLatestElectronUpdaterFeed(PROMOTED_ONLY)
    ).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("re-lists the channel when its listing predates the staged feed (ISS-12173)", async () => {
    const getReleaseByTag = mockFeedSwapRelisting();

    await expect(getLatestElectronUpdaterFeed(PROMOTED_ONLY)).resolves.toBe(
      FEED_TEXT
    );
    expect(getReleaseByTag).toHaveBeenCalledTimes(2);
    expect(getReleaseByTag).toHaveBeenLastCalledWith({
      owner: DesktopReleaseOwner,
      repo: DesktopReleaseRepo,
      tag: DesktopReleaseChannel,
    });
  });

  it("rethrows a channel lookup failure that is not a 404", async () => {
    const getReleaseByTag = vi.fn(() =>
      Promise.reject(Object.assign(new Error("Server Error"), { status: 500 }))
    );
    vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
      makeOctokit({ getReleaseByTag })
    );

    await expect(getLatestElectronUpdaterFeed(PROMOTED_ONLY)).rejects.toThrow(
      "Server Error"
    );
    // ISS-12175: a 5xx is retried exactly once, then still surfaces.
    expect(getReleaseByTag).toHaveBeenCalledTimes(2);
    expect(mockLogError).toHaveBeenCalledWith(expect.any(String), {
      error: "Server Error",
      upstreamStatus: 500,
    });
  });

  /**
   * ISS-12175: the two prod failure points in the 2026-09-30 to 10-07 window —
   * an empty-bodied 500 on the feed asset download and a 503 on the
   * installation lookup. One blip must not cost the client its feed, and only
   * the call that failed is repeated.
   */
  it.each([
    ["the feed asset download", 500, "request", { auth: 1, request: 2 }],
    ["the installation lookup", 503, "auth", { auth: 2, request: 1 }],
  ] as const)(
    "serves the feed when %s answers one GitHub %i",
    async (_name, status, failingCall, calls) => {
      const serverError = Object.assign(new Error("Server Error"), { status });
      const request = vi.fn(async () => ({ data: FEED_TEXT }));
      if (failingCall === "request") {
        request.mockRejectedValueOnce(serverError);
      }
      const octokit = makeOctokit({
        getReleaseByTag: vi.fn(async () => ({
          data: toGitHubRelease(
            makeDesktopRelease({ tagName: DesktopReleaseChannel })
          ),
        })),
        request,
      });
      vi.mocked(getAuthenticatedOctokit).mockResolvedValue(octokit);
      if (failingCall === "auth") {
        vi.mocked(getAuthenticatedOctokit).mockRejectedValueOnce(serverError);
      }

      await expect(getLatestElectronUpdaterFeed(PROMOTED_ONLY)).resolves.toBe(
        FEED_TEXT
      );
      expect(getAuthenticatedOctokit).toHaveBeenCalledTimes(calls.auth);
      expect(request).toHaveBeenCalledTimes(calls.request);
      expect(mockLogError).not.toHaveBeenCalled();
    }
  );

  // 403, not 404: a feed 404 re-lists the channel once (ISS-12173), which
  // would read the asset a second time for a reason other than a retry.
  it("does not retry a 4xx from GitHub", async () => {
    const request = vi.fn(() =>
      Promise.reject(Object.assign(new Error("Forbidden"), { status: 403 }))
    );
    vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
      makeOctokit({
        getReleaseByTag: vi.fn(async () => ({
          data: toGitHubRelease(
            makeDesktopRelease({ tagName: DesktopReleaseChannel })
          ),
        })),
        request,
      })
    );

    await expect(getLatestElectronUpdaterFeed(PROMOTED_ONLY)).rejects.toThrow(
      "Forbidden"
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalledWith(expect.any(String), {
      error: "Forbidden",
      upstreamStatus: 403,
    });
  });
});

describe("getElectronUpdaterAssetRedirectUrl", () => {
  beforeEach(() => {
    resetGitHubClientMocks();
  });

  it("rejects a non-updater asset name without contacting GitHub", async () => {
    await expect(
      getElectronUpdaterAssetRedirectUrl("notes.txt", PROMOTED_ONLY)
    ).resolves.toBeNull();
    expect(getAuthenticatedOctokit).not.toHaveBeenCalled();
  });

  it("redirects the current ZIP named by the channel feed", async () => {
    const request = vi.fn((_route: string, options: MockAssetRequestOptions) =>
      Promise.resolve(
        options.request?.redirect === "manual"
          ? { status: 302, headers: { location: SIGNED_REDIRECT_URL } }
          : { data: FEED_TEXT }
      )
    );
    vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
      makeOctokit({
        getReleaseByTag: vi.fn(async () => ({
          data: toGitHubRelease(
            makeDesktopRelease({ tagName: DesktopReleaseChannel })
          ),
        })),
        request,
      })
    );

    await expect(
      getElectronUpdaterAssetRedirectUrl(ZIP_ASSET, PROMOTED_ONLY)
    ).resolves.toBe(SIGNED_REDIRECT_URL);
    expect(request).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        asset_id: 3,
        request: { redirect: "manual" },
      })
    );
  });

  it("re-lists the channel when its listing predates the staged feed (ISS-12173)", async () => {
    const getReleaseByTag = mockFeedSwapRelisting();

    await expect(
      getElectronUpdaterAssetRedirectUrl(ZIP_ASSET, PROMOTED_ONLY)
    ).resolves.toBe(SIGNED_REDIRECT_URL);
    expect(getReleaseByTag).toHaveBeenCalledTimes(2);
    expect(getReleaseByTag).toHaveBeenLastCalledWith({
      owner: DesktopReleaseOwner,
      repo: DesktopReleaseRepo,
      tag: DesktopReleaseChannel,
    });
  });

  it("retries the feed read once when it answers a GitHub 5xx (ISS-12175)", async () => {
    let feedReads = 0;
    const request = vi.fn(
      (_route: string, options: MockAssetRequestOptions) => {
        if (options.request?.redirect === "manual") {
          return Promise.resolve({
            status: 302,
            headers: { location: SIGNED_REDIRECT_URL },
          });
        }
        feedReads += 1;
        return feedReads === 1
          ? Promise.reject(
              Object.assign(new Error("Server Error"), { status: 500 })
            )
          : Promise.resolve({ data: FEED_TEXT });
      }
    );
    vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
      makeOctokit({
        getReleaseByTag: vi.fn(async () => ({
          data: toGitHubRelease(
            makeDesktopRelease({ tagName: DesktopReleaseChannel })
          ),
        })),
        request,
      })
    );

    await expect(
      getElectronUpdaterAssetRedirectUrl(ZIP_ASSET, PROMOTED_ONLY)
    ).resolves.toBe(SIGNED_REDIRECT_URL);
    expect(feedReads).toBe(2);
  });

  it("redirects a stale ZIP from its matching versioned release after channel rollover", async () => {
    const staleVersion = "0.15.114";
    const staleZipAsset = getDesktopReleaseZipAssetName(staleVersion);
    const versionedRelease = makeDesktopReleaseForVersion(staleVersion);
    const getReleaseByTag = vi.fn((options: { tag: string }) =>
      Promise.resolve({
        data: toGitHubRelease(
          options.tag === DesktopReleaseChannel
            ? makeDesktopRelease({ tagName: DesktopReleaseChannel })
            : versionedRelease
        ),
      })
    );
    const request = vi.fn((_route: string, options: MockAssetRequestOptions) =>
      Promise.resolve(
        options.request?.redirect === "manual"
          ? { status: 302, headers: { location: SIGNED_REDIRECT_URL } }
          : { data: FEED_TEXT }
      )
    );
    vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
      makeOctokit({
        getReleaseByTag,
        request,
      })
    );

    await expect(
      getElectronUpdaterAssetRedirectUrl(staleZipAsset, PROMOTED_ONLY)
    ).resolves.toBe(SIGNED_REDIRECT_URL);
    expect(getReleaseByTag).toHaveBeenNthCalledWith(1, {
      owner: DesktopReleaseOwner,
      repo: DesktopReleaseRepo,
      tag: DesktopReleaseChannel,
    });
    expect(getReleaseByTag).toHaveBeenNthCalledWith(2, {
      owner: DesktopReleaseOwner,
      repo: DesktopReleaseRepo,
      tag: getDesktopReleaseTag(staleVersion),
    });
    expect(request).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        asset_id: 30,
        request: { redirect: "manual" },
      })
    );
  });

  it.each([
    [
      "missing",
      () =>
        Promise.reject(Object.assign(new Error("not found"), { status: 404 })),
    ],
    [
      "draft",
      () =>
        Promise.resolve({
          data: toGitHubRelease({
            ...makeDesktopReleaseForVersion("0.15.114"),
            draft: true,
          }),
        }),
    ],
  ])(
    "returns null when the matching versioned release is %s",
    async (_name, loadVersionedRelease) => {
      const staleVersion = "0.15.114";
      const staleZipAsset = getDesktopReleaseZipAssetName(staleVersion);
      const getReleaseByTag = vi.fn((options: { tag: string }) =>
        options.tag === DesktopReleaseChannel
          ? Promise.resolve({
              data: toGitHubRelease(
                makeDesktopRelease({ tagName: DesktopReleaseChannel })
              ),
            })
          : loadVersionedRelease()
      );
      const request = vi.fn(
        (_route: string, options: MockAssetRequestOptions) => {
          if (options.request?.redirect === "manual") {
            throw new Error("unexpected redirect request");
          }
          return Promise.resolve({ data: FEED_TEXT });
        }
      );
      vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
        makeOctokit({
          getReleaseByTag,
          request,
        })
      );

      await expect(
        getElectronUpdaterAssetRedirectUrl(staleZipAsset, PROMOTED_ONLY)
      ).resolves.toBeNull();
      expect(getReleaseByTag).toHaveBeenLastCalledWith({
        owner: DesktopReleaseOwner,
        repo: DesktopReleaseRepo,
        tag: getDesktopReleaseTag(staleVersion),
      });
    }
  );
});

describe("GitHub client failure logging", () => {
  beforeEach(() => {
    resetGitHubClientMocks();
  });

  it.each(GITHUB_CLIENT_ENTRY_POINTS)(
    "%s rethrows an auth failure and logs its message",
    async (_name, invoke) => {
      vi.mocked(getAuthenticatedOctokit).mockRejectedValue(
        new Error("installation token expired")
      );

      await expect(invoke()).rejects.toThrow("installation token expired");
      expect(mockLogError).toHaveBeenCalledWith(expect.any(String), {
        error: "installation token expired",
      });
    }
  );

  it.each(GITHUB_CLIENT_ENTRY_POINTS)(
    "%s logs Unknown error when a non-Error rejection escapes",
    async (_name, invoke) => {
      vi.mocked(getAuthenticatedOctokit).mockRejectedValue("ECONNRESET");

      await expect(invoke()).rejects.toBe("ECONNRESET");
      expect(mockLogError).toHaveBeenCalledWith(expect.any(String), {
        error: "Unknown error",
      });
    }
  );
});

type MockAssetRequestOptions = {
  asset_id: number;
  request?: { redirect?: string };
};

type MockGitHubOperation = (...args: never[]) => unknown;

// Payload keys stay snake_case: this is GitHub's REST wire format, which the
// release readers map into the camelCase DesktopRelease shape.
function toGitHubRelease(release: DesktopRelease) {
  return {
    tag_name: release.tagName,
    body: release.body,
    draft: release.draft,
    assets: release.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      browser_download_url: asset.browserDownloadUrl,
    })),
  };
}

function makeOctokit(mocks: {
  listReleases?: MockGitHubOperation;
  getReleaseByTag?: MockGitHubOperation;
  request?: MockGitHubOperation;
}): Octokit {
  return {
    repos: {
      listReleases: mocks.listReleases ?? vi.fn(),
      getReleaseByTag: mocks.getReleaseByTag ?? vi.fn(),
    },
    request: mocks.request ?? vi.fn(),
  } as unknown as Octokit;
}

function resetGitHubClientMocks() {
  vi.mocked(getAuthenticatedOctokit).mockReset();
  mockLogError.mockClear();
}

/**
 * The channel as listed just before a publish uploads the staged feed, then as
 * re-listed after the swap: the live feed's id is deleted in between.
 */
function mockFeedSwapRelisting() {
  const stale = makeDesktopRelease({ tagName: DesktopReleaseChannel });
  const relisted = makeDesktopRelease({
    tagName: DesktopReleaseChannel,
    assets: stale.assets.map((asset) =>
      asset.name === DesktopReleaseUpdaterMetadataAssetName
        ? makeAsset(8, DesktopReleaseStagedUpdaterMetadataAssetName)
        : asset
    ),
  });
  const getReleaseByTag = vi
    .fn()
    .mockResolvedValueOnce({ data: toGitHubRelease(stale) })
    .mockResolvedValueOnce({ data: toGitHubRelease(relisted) });
  const request = vi.fn((_route: string, options: MockAssetRequestOptions) => {
    if (options.asset_id === 4) {
      return Promise.reject(
        Object.assign(new Error("not found"), { status: 404 })
      );
    }
    return Promise.resolve(
      options.request?.redirect === "manual"
        ? { status: 302, headers: { location: SIGNED_REDIRECT_URL } }
        : { data: FEED_TEXT }
    );
  });
  vi.mocked(getAuthenticatedOctokit).mockResolvedValue(
    makeOctokit({ getReleaseByTag, request })
  );
  return getReleaseByTag;
}
