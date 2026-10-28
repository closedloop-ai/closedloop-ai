import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DesktopReleaseMetadataSchema } from "./desktop-release.ts";
import {
  getDesktopReleaseLinuxUpdaterAssetNameFromFeed,
  isDesktopReleaseLinuxUpdaterAssetName,
} from "./desktop-release-linux.ts";

const appImage = "Closedloop-0.17.123-linux-x64.AppImage";
const deb = "Closedloop-0.17.123-linux-x64.deb";
const feed = `version: 0.17.123\nfiles:\n  - url: ${appImage}\n  - url: ${deb}\npath: ${appImage}\n`;

describe("Linux updater artifact contract", () => {
  it("selects either format from the same feed", () => {
    expect(getDesktopReleaseLinuxUpdaterAssetNameFromFeed(feed, appImage)).toBe(
      appImage
    );
    expect(getDesktopReleaseLinuxUpdaterAssetNameFromFeed(feed, deb)).toBe(deb);
  });
  it.each([
    `../${deb}`,
    `https://example.com/${deb}`,
    "Closedloop-0.17.123-linux-arm64.deb",
    "Closedloop-0.17.123-linux-x64.rpm",
    "Closedloop-01.17.123-linux-x64.deb",
    `${deb}.blockmap`,
  ])("refuses an unsupported or unsafe basename: %s", (name) => {
    expect(isDesktopReleaseLinuxUpdaterAssetName(name)).toBe(false);
    expect(
      getDesktopReleaseLinuxUpdaterAssetNameFromFeed(
        `version: 0.17.123\npath: ${name}`,
        name
      )
    ).toBeNull();
  });
  it("refuses a feed naming a different version", () => {
    expect(
      getDesktopReleaseLinuxUpdaterAssetNameFromFeed(
        feed.replace("version: 0.17.123", "version: 0.17.124"),
        deb
      )
    ).toBeNull();
  });
  it("refuses a URL even when its basename resembles the package", () => {
    expect(
      getDesktopReleaseLinuxUpdaterAssetNameFromFeed(
        `version: 0.17.123\nfiles:\n  - url: https://example.com/${deb}`,
        deb
      )
    ).toBeNull();
  });
  it("does not require platform metadata from an older release", () => {
    const metadata = {
      owner: "closedloop-ai",
      repo: "closedloop-ai",
      version: "0.17.123",
      tagName: "desktop-v0.17.123",
      channel: "desktop-latest",
      targetCommitish: "abc",
      assets: {
        dmg: "Closedloop-0.17.123-universal.dmg",
        zip: "Closedloop-0.17.123-universal-mac.zip",
        updaterMetadata: "latest-mac.yml",
      },
      downloadUrl:
        "https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-v0.17.123/Closedloop-0.17.123-universal.dmg",
    };
    expect(DesktopReleaseMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(
      DesktopReleaseMetadataSchema.safeParse({
        ...metadata,
        platforms: {
          future: {
            version: "0.17.123",
            tagName: "desktop-v0.17.123",
            targetCommitish: "abc",
            artifacts: { installer: "future-package" },
            updaterMetadata: "future.yml",
          },
        },
      }).success
    ).toBe(true);
  });
});

// Frozen from published Desktop 0.17.427 at
// a884a3a1a2c006f738b09797761e10bef10f0057, not derived from the new schema.
const previousVersionRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const previousMacSchema = z.object({
  owner: z.literal("closedloop-ai"),
  repo: z.literal("closedloop-ai"),
  version: z.string().refine((value) => previousVersionRegex.test(value)),
  tagName: z.string().min(1),
  channel: z.union([
    z.literal("desktop-latest"),
    z.literal("desktop-candidate"),
  ]),
  targetCommitish: z.string().min(1),
  assets: z.object({
    dmg: z.string().min(1),
    zip: z.string().min(1),
    updaterMetadata: z.literal("latest-mac.yml"),
  }),
  downloadUrl: z.string().min(1),
});

it("the published macOS schema accepts multi-platform metadata without changing its legacy fields", () => {
  const legacy = {
    owner: "closedloop-ai",
    repo: "closedloop-ai",
    version: "0.17.123",
    tagName: "desktop-v0.17.123",
    channel: "desktop-latest",
    targetCommitish: "abc",
    assets: {
      dmg: "Closedloop-0.17.123-universal.dmg",
      zip: "Closedloop-0.17.123-universal-mac.zip",
      updaterMetadata: "latest-mac.yml",
    },
    downloadUrl:
      "https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-v0.17.123/Closedloop-0.17.123-universal.dmg",
  };
  expect(
    previousMacSchema.parse({
      ...legacy,
      platforms: {
        linux: {
          version: "0.17.123",
          tagName: "desktop-v0.17.123",
          targetCommitish: "abc",
          artifacts: { deb, appImage },
          updaterMetadata: "latest-linux.yml",
        },
      },
    })
  ).toEqual(legacy);
});
