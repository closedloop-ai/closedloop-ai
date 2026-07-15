import "server-only";

import AdmZip from "adm-zip";
import {
  classifyComponentPath,
  dedupeComponents,
  type ParsedComponent,
} from "./pack-component-parse";

/**
 * Total decompressed-bytes budget for a Pack zip. The upload path caps the
 * COMPRESSED upload at 50 MB (`ZIP_MAX_BYTES`), but that does NOT bound the
 * decompressed footprint — a 50 MB zip bomb can inflate to many GB and OOM the
 * shared API worker. We therefore additionally cap the sum of the entries'
 * uncompressed sizes at 300 MB, a ~6× headroom over the compressed cap that is
 * generous for any legitimate plugin/shared-asset bundle (which is text-heavy
 * markdown/JSON) while still bounding the in-memory footprint. If this ever
 * rejects a real pack, raise it deliberately rather than removing the guard.
 */
export const ZIP_MAX_DECOMPRESSED_BYTES = 300 * 1024 * 1024;

/**
 * Maximum number of entries (files + directories) a Pack zip may contain. Caps
 * a "zip of many tiny files" amplification / per-entry overhead attack that the
 * byte budget alone does not stop. A canonical Claude Code plugin has on the
 * order of tens of components; 5000 is far above any legitimate bundle.
 */
export const ZIP_MAX_ENTRIES = 5000;

/**
 * Thrown when a Pack zip exceeds the decompressed-size or entry-count budget.
 * The caller maps this to a 4xx rather than letting the worker OOM/crash.
 */
export class PackZipTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackZipTooLargeError";
  }
}

/**
 * Parse a Pack `.zip` in the canonical Claude Code plugin layout into the
 * agentic components it should contribute. Tolerant of a leading root folder
 * and an optional `.claude/` prefix, so both a bare plugin zip and a
 * `shared_repo_with_stuff.zip` (with `agents/`, `skills/`, … inside) parse.
 * Classification + dedupe are shared with the repo importer
 * (`pack-component-parse`) so the two ingest paths stay identical.
 *
 * Decompression is bounded: the sum of the entries' declared uncompressed
 * sizes (and each individual entry) is checked against
 * `ZIP_MAX_DECOMPRESSED_BYTES`, and the entry count against `ZIP_MAX_ENTRIES`,
 * BEFORE any `entry.getData()` inflate, so a zip bomb is rejected with a clear
 * error instead of OOM-ing the worker. `getData()` itself also validates the
 * inflated length against the header, so a lying header cannot bypass the cap.
 */
export function parsePackZip(buffer: Buffer): ParsedComponent[] {
  const zip = new AdmZip(buffer);
  const components: ParsedComponent[] = [];

  const entries = zip.getEntries();

  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new PackZipTooLargeError(
      `Pack zip has too many entries (${entries.length} > ${ZIP_MAX_ENTRIES}).`
    );
  }

  // Sum the declared uncompressed sizes across ALL entries before inflating any
  // of them, so a bomb is rejected up front rather than after it has already
  // been expanded into memory.
  let totalDecompressed = 0;
  for (const entry of entries) {
    const declared = entry.header.size;
    if (declared > ZIP_MAX_DECOMPRESSED_BYTES) {
      throw new PackZipTooLargeError(
        `Pack zip entry "${entry.entryName}" declares an uncompressed size ` +
          `(${declared} bytes) over the ${ZIP_MAX_DECOMPRESSED_BYTES}-byte budget.`
      );
    }
    totalDecompressed += declared;
    if (totalDecompressed > ZIP_MAX_DECOMPRESSED_BYTES) {
      throw new PackZipTooLargeError(
        "Pack zip decompressed size exceeds the " +
          `${ZIP_MAX_DECOMPRESSED_BYTES}-byte budget.`
      );
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory) {
      continue;
    }
    const parsed = classifyComponentPath(entry.entryName, () =>
      entry.getData().toString("utf-8")
    );
    if (parsed) {
      components.push(...parsed);
    }
  }

  return dedupeComponents(components);
}
