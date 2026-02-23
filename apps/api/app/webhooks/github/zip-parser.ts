import type AdmZip from "adm-zip";
import { ZIP_CONTENT_EXTRACTORS } from "./extractors/registry";
import { type ContentKey, ZipContentBag } from "./extractors/types";

export type ZipContentResult = {
  bag: ZipContentBag;
  entries: { name: string; data: Buffer }[];
};

/**
 * Apply a single accumulating extractor (one with mergeWith) to an entry.
 * Merges the parsed result into the bag if parsing succeeds.
 */
function applyMergingExtractor(
  bag: ZipContentBag,
  extractor: (typeof ZIP_CONTENT_EXTRACTORS)[number],
  data: Buffer,
  name: string
): void {
  const next = extractor.parse(data, name);
  if (next == null) {
    return;
  }
  const existing = bag.get(extractor.key as ContentKey<unknown>);
  const merged =
    existing != null
      ? extractor.mergeWith!(existing as never, next as never)
      : next;
  bag.setAccumulating(
    extractor.key as ContentKey<unknown>,
    merged,
    extractor.mergeWith! as (a: unknown, b: unknown) => unknown
  );
}

/**
 * Apply a single priority-based extractor to an entry.
 * Stores the parsed result if it wins the priority contest for its key.
 */
function applyPriorityExtractor(
  bag: ZipContentBag,
  extractor: (typeof ZIP_CONTENT_EXTRACTORS)[number],
  data: Buffer,
  name: string
): void {
  if (extractor.priority <= bag.getPriority(extractor.key)) {
    return;
  }
  const result = extractor.parse(data, name);
  if (result != null) {
    bag.set(extractor.key as ContentKey<unknown>, result, extractor.priority);
  }
}

/**
 * Run all registered extractors against a single zip entry and update the bag.
 *
 * Accumulating extractors (those with mergeWith) do NOT break — all matching
 * accumulators for a file must run so their results can be merged. Priority-based
 * extractors break after the first match because the registry is ordered by
 * descending priority and applyPriorityExtractor already guards against lower-
 * priority overwrites; continuing would only waste work.
 */
function processZipEntry(bag: ZipContentBag, data: Buffer, name: string): void {
  for (const extractor of ZIP_CONTENT_EXTRACTORS) {
    if (!extractor.matches(name)) {
      continue;
    }
    if (extractor.mergeWith) {
      applyMergingExtractor(bag, extractor, data, name);
    } else {
      applyPriorityExtractor(bag, extractor, data, name);
    }
  }
}

/**
 * Search a zip for content using the registered extractors.
 *
 * Iterates all zip entries and runs each through the extractor registry.
 * When multiple extractors share the same key, the highest-priority match wins
 * regardless of zip entry order.
 */
export function findContentInZip(zip: AdmZip): ZipContentResult {
  const bag = new ZipContentBag();
  const entries: { name: string; data: Buffer }[] = [];

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      continue;
    }
    const data = entry.getData();
    const name = entry.entryName;
    entries.push({ name, data });
    processZipEntry(bag, data, name);
  }

  return { bag, entries };
}
