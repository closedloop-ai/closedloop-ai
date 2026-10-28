/**
 * Reads the variation axes (the `fvar` table) out of a WOFF2 font, so a test
 * can pin that a bundled font is a variable face and which weight range it
 * covers. Implements only what that needs from the W3C WOFF2 spec: the header,
 * the table directory, and the Brotli-compressed table stream. Font
 * collections are rejected.
 */
import { brotliDecompressSync } from "node:zlib";

export type FontVariationAxis = {
  tag: string;
  min: number;
  defaultValue: number;
  max: number;
};

type Woff2TableEntry = { tag: string; streamLength: number };

const WOFF2_SIGNATURE = "wOF2";
const COLLECTION_FLAVOR = "ttcf";
const HEADER_SIZE = 48;
const NUM_TABLES_OFFSET = 12;
const COMPRESSED_SIZE_OFFSET = 20;
const ARBITRARY_TAG_INDEX = 63;
/** A flags byte holds the tag index in its low six bits and the transform version in its top two. */
const TAG_INDEX_RANGE = 64;
/** A UIntBase128 byte carries seven value bits; the high bit means another byte follows. */
const BASE128_DIGIT_RANGE = 128;
const BASE128_MAX_BYTES = 5;
const FIXED_POINT_ONE = 65_536;
const FVAR_TAG = "fvar";
const FVAR_AXES_OFFSET = 4;
const FVAR_AXIS_COUNT_OFFSET = 8;
const FVAR_AXIS_SIZE_OFFSET = 10;

/** WOFF2 "known table tags", indexed by the low six bits of an entry's flags. */
const KNOWN_TABLE_TAGS = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
  "CFF ",
  "VORG",
  "EBDT",
  "EBLC",
  "gasp",
  "hdmx",
  "kern",
  "LTSH",
  "PCLT",
  "VDMX",
  "vhea",
  "vmtx",
  "BASE",
  "GDEF",
  "GPOS",
  "GSUB",
  "EBSC",
  "JSTF",
  "MATH",
  "CBDT",
  "CBLC",
  "COLR",
  "CPAL",
  "SVG ",
  "sbix",
  "acnt",
  "avar",
  "bdat",
  "bloc",
  "bsln",
  "cvar",
  "fdsc",
  "feat",
  "fmtx",
  "fvar",
  "gvar",
  "hsty",
  "just",
  "lcar",
  "mort",
  "morx",
  "opbd",
  "prop",
  "trak",
  "Zapf",
  "Silf",
  "Glat",
  "Gloc",
  "Feat",
  "Sill",
] as const;

/** Returns the font's variation axes, or an empty list for a static face. */
export function readWoff2VariationAxes(bytes: Uint8Array): FontVariationAxis[] {
  const font = Buffer.from(bytes);
  if (font.toString("latin1", 0, 4) !== WOFF2_SIGNATURE) {
    throw new Error("not a WOFF2 font");
  }
  if (font.toString("latin1", 4, 8) === COLLECTION_FLAVOR) {
    throw new Error("WOFF2 font collections are not supported");
  }
  const { tables, streamOffset } = readTableDirectory(font);
  const stream = brotliDecompressSync(
    font.subarray(
      streamOffset,
      streamOffset + font.readUInt32BE(COMPRESSED_SIZE_OFFSET)
    )
  );
  const expectedLength = tables.reduce(
    (sum, table) => sum + table.streamLength,
    0
  );
  if (stream.length !== expectedLength) {
    throw new Error(
      `WOFF2 table stream is ${stream.length} bytes, directory says ${expectedLength}`
    );
  }
  let offset = 0;
  for (const table of tables) {
    if (table.tag === FVAR_TAG) {
      return readFvarAxes(stream.subarray(offset, offset + table.streamLength));
    }
    offset += table.streamLength;
  }
  return [];
}

function readTableDirectory(font: Buffer): {
  tables: Woff2TableEntry[];
  streamOffset: number;
} {
  const cursor = { offset: HEADER_SIZE };
  const tables: Woff2TableEntry[] = [];
  const tableCount = font.readUInt16BE(NUM_TABLES_OFFSET);
  for (let index = 0; index < tableCount; index++) {
    const flags = font[cursor.offset++] ?? 0;
    const tagIndex = flags % TAG_INDEX_RANGE;
    let tag: string = KNOWN_TABLE_TAGS[tagIndex] ?? "";
    if (tagIndex === ARBITRARY_TAG_INDEX) {
      tag = font.toString("latin1", cursor.offset, cursor.offset + 4);
      cursor.offset += 4;
    }
    const originalLength = readUIntBase128(font, cursor);
    const transformed = isTransformed(tag, Math.floor(flags / TAG_INDEX_RANGE));
    const streamLength = transformed
      ? readUIntBase128(font, cursor)
      : originalLength;
    tables.push({ tag, streamLength });
  }
  return { tables, streamOffset: cursor.offset };
}

/** `glyf` and `loca` use version 0 for their transform; every other table uses 0 for none. */
function isTransformed(tag: string, transformVersion: number): boolean {
  if (tag === "glyf" || tag === "loca") {
    return transformVersion === 0;
  }
  return transformVersion !== 0;
}

function readUIntBase128(font: Buffer, cursor: { offset: number }): number {
  let value = 0;
  for (let index = 0; index < BASE128_MAX_BYTES; index++) {
    const byte = font[cursor.offset++] ?? 0;
    value = value * BASE128_DIGIT_RANGE + (byte % BASE128_DIGIT_RANGE);
    if (byte < BASE128_DIGIT_RANGE) {
      return value;
    }
  }
  throw new Error("WOFF2 UIntBase128 value runs past five bytes");
}

function readFvarAxes(fvar: Buffer): FontVariationAxis[] {
  const axesOffset = fvar.readUInt16BE(FVAR_AXES_OFFSET);
  const axisCount = fvar.readUInt16BE(FVAR_AXIS_COUNT_OFFSET);
  const axisSize = fvar.readUInt16BE(FVAR_AXIS_SIZE_OFFSET);
  const axes: FontVariationAxis[] = [];
  for (let index = 0; index < axisCount; index++) {
    const start = axesOffset + index * axisSize;
    axes.push({
      tag: fvar.toString("latin1", start, start + 4),
      min: fvar.readInt32BE(start + 4) / FIXED_POINT_ONE,
      defaultValue: fvar.readInt32BE(start + 8) / FIXED_POINT_ONE,
      max: fvar.readInt32BE(start + 12) / FIXED_POINT_ONE,
    });
  }
  return axes;
}
