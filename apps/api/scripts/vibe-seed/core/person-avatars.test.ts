import { readFileSync } from "node:fs";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { vibeSeedAvatar } from "./person-avatars";
import {
  VIBE_GOLDEN_USERS,
  VIBE_SEED_OWNER,
  VIBE_SEED_SIGNED_IN_PERSON,
  VIBE_SEED_TEAMMATES,
} from "./seed-people";

// ISS-12135, ISS-12406: retain source portrait/provenance coverage while the
// product uses the compact raster copy mandated for collaboration auth.

const WEBP_DATA_URI_PREFIX = "data:image/webp;base64,";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const CC0_LICENSE = "https://creativecommons.org/publicdomain/zero/1.0/";
const VIEW_BOX = /^0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)$/;
const EXTERNAL_REFERENCE = /(?:href|src)\s*=\s*["'](?!#)|url\(\s*["']?(?!#)/i;
const SCRIPT = /<script|\son[a-z]+\s*=/i;

const HANDLES = [
  VIBE_SEED_OWNER.githubUsername,
  VIBE_SEED_SIGNED_IN_PERSON.githubUsername,
  ...VIBE_SEED_TEAMMATES.map((person) => person.githubUsername),
  ...VIBE_GOLDEN_USERS.map((person) => person.avatarHandle),
];

describe("vibeSeedAvatar", () => {
  it.each(HANDLES)(
    "serves %s as a compact WebP with a licensed, self-contained SVG source",
    (handle) => {
      const avatar = vibeSeedAvatar(handle) ?? "";
      expect(avatar.startsWith(WEBP_DATA_URI_PREFIX)).toBe(true);
      const encoded = avatar.slice(WEBP_DATA_URI_PREFIX.length);
      const bytes = Buffer.from(encoded, "base64");
      expect(bytes.toString("base64")).toBe(encoded);
      expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
      expect(bytes.toString("ascii", 8, 12)).toBe("WEBP");
      expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length);
      const svg = readFileSync(
        new URL(`./avatars/${handle}.svg`, import.meta.url),
        "utf8"
      );

      expect(XMLValidator.validate(svg)).toBe(true);
      const root = new XMLParser({ ignoreAttributes: false }).parse(svg).svg;
      expect(root).toBeDefined();
      expect(root["@_xmlns"]).toBe(SVG_NAMESPACE);
      const artwork = root.metadata["rdf:RDF"]["rdf:Description"];
      expect(artwork["dc:title"]).toBe("Lorelei");
      expect(artwork["dc:creator"]).toBe("Lisa Wischofsky");
      expect(artwork["dcterms:license"]["#text"]).toBe(CC0_LICENSE);
      const [, width, height] = VIEW_BOX.exec(root["@_viewBox"] ?? "") ?? [];
      expect(Number(width)).toBeGreaterThan(0);
      expect(width).toBe(height);
      expect(svg).not.toMatch(EXTERNAL_REFERENCE);
      expect(svg).not.toMatch(SCRIPT);
    }
  );

  it("gives every seeded person a portrait of their own", () => {
    const avatars = HANDLES.map(vibeSeedAvatar);

    expect(new Set(avatars).size).toBe(HANDLES.length);
  });

  it("has no portrait for a handle outside the roster or the avatar directory", () => {
    expect(vibeSeedAvatar("someone-else")).toBeNull();
    expect(vibeSeedAvatar("../person-avatars")).toBeNull();
    expect(vibeSeedAvatar("")).toBeNull();
  });
});
