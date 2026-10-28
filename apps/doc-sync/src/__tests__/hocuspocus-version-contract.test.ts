import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hocuspocus } from "@hocuspocus/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/** PLN-2099 E2: the oldest Hocuspocus this service runs on. */
const HOCUSPOCUS_FLOOR = "4.7.0";

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/;
/** The lowest version a `^x.y.z`, `~x.y.z` or exact range admits. */
const RANGE_FLOOR_PATTERN = /^[\^~]?(\d+\.\d+\.\d+(?:-.+)?)$/;
const HOCUSPOCUS_SCOPE = "@hocuspocus/";
const MANIFEST_PATH = fileURLToPath(
  new URL("../../package.json", import.meta.url)
);
const manifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
});

/** Numeric `major.minor.patch`; a prerelease sorts below its release. */
function isAtLeast(version: string, floor: string): boolean {
  const [actual, wanted] = [version, floor].map((each) => {
    const match = VERSION_PATTERN.exec(each);
    if (!match) {
      throw new Error(`not a version: ${each}`);
    }
    return {
      parts: [match[1], match[2], match[3]].map(Number),
      prerelease: match[4] !== undefined,
    };
  });
  if (!(actual && wanted)) {
    return false;
  }
  for (const [index, part] of actual.parts.entries()) {
    const other = wanted.parts[index] ?? 0;
    if (part !== other) {
      return part > other;
    }
  }
  return !actual.prerelease || wanted.prerelease;
}

describe("Hocuspocus version contract", () => {
  it(`runs Hocuspocus ${HOCUSPOCUS_FLOOR} or later`, async () => {
    let seen: string | undefined;
    new Hocuspocus({
      extensions: [
        {
          onConfigure: ({ version }) => {
            seen = version;
            return Promise.resolve();
          },
        },
      ],
    });
    await Promise.resolve();

    expect(seen).toBeDefined();
    expect(isAtLeast(seen ?? "", HOCUSPOCUS_FLOOR)).toBe(true);
  });

  it(`declares every ${HOCUSPOCUS_SCOPE}* dependency at ${HOCUSPOCUS_FLOOR} or later`, () => {
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
    );
    const ranges = Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    }).filter(([name]) => name.startsWith(HOCUSPOCUS_SCOPE));

    expect(ranges.length).toBeGreaterThan(0);
    for (const [name, range] of ranges) {
      const floor = RANGE_FLOOR_PATTERN.exec(range)?.[1];
      expect(floor, `${name}@${range}`).toBeDefined();
      expect(isAtLeast(floor ?? "", HOCUSPOCUS_FLOOR), `${name}@${range}`).toBe(
        true
      );
    }
  });

  it.each([
    ["4.7.0", true],
    ["4.10.0", true],
    ["5.0.0", true],
    ["4.6.9", false],
    ["3.9.9", false],
    ["4.7.0-rc.1", false],
  ])("isAtLeast(%s, floor) is %s", (version, expected) => {
    expect(isAtLeast(version, HOCUSPOCUS_FLOOR)).toBe(expected);
  });
});
