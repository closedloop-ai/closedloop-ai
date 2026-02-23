/**
 * Protocol and container types for the zip content extractor registry.
 *
 * The extractor pattern follows Open-Closed Principle: new content types
 * are added by creating an extractor file and registering it, without
 * modifying the extraction engine.
 */

import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { PerfSummary } from "@repo/api/src/types/performance";
import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import type { ExecutionResult } from "../zip-parser";

/** Discriminant for all possible extractor output types. */
export const ExtractorOutputType = {
  String: "string",
  ExecutionResult: "ExecutionResult",
  JudgesReport: "JudgesReport",
  PerfSummary: "PerfSummary",
  PromptsSnapshot: "PromptsSnapshot",
} as const;
export type ExtractorOutputType =
  (typeof ExtractorOutputType)[keyof typeof ExtractorOutputType];

/**
 * A typed key for accessing extractor results from ZipContentBag.
 * The phantom type parameter T ensures get() returns the correct type.
 */
export type ContentKey<T> = string & { readonly __brand: T };

/** Create a typed content key. */
export function contentKey<T>(key: string): ContentKey<T> {
  return key as ContentKey<T>;
}

/**
 * Protocol for extracting a single typed content from zip entries.
 *
 * Each extractor declares:
 * - A unique string key used to store/retrieve its result
 * - A discriminant outputType from ExtractorOutputType
 * - A priority for competing extractors on the same key (higher wins)
 * - A match predicate that tests filename patterns
 * - A parse function that converts raw buffer to typed output
 * - An optional mergeWith function for accumulating extractors (e.g., collecting
 *   multiple files into a single container). When present, the priority check is
 *   skipped and results are merged rather than replaced.
 */
export type ZipContentExtractor<
  T,
  Kind extends ExtractorOutputType = ExtractorOutputType,
> = {
  /** Unique identifier for this content slot (e.g., "planContent", "judgesReport") */
  readonly key: string;
  /** Discriminant for narrowing the output type in control flow. */
  readonly outputType: Kind;
  /** Priority within the same key. Higher wins when two extractors share a key. */
  readonly priority: number;
  /** Test whether this entry's filename matches this extractor. */
  matches(entryName: string): boolean;
  /** Parse the matched entry's data. Return null if parsing fails. */
  parse(data: Buffer, entryName: string): T | null;
  /**
   * Optional merge function for accumulating extractors.
   * When defined, every matching entry is parsed and merged into the running
   * result rather than replacing it. The priority check is bypassed so all
   * matching entries are processed.
   */
  mergeWith?(existing: T, next: T): T;
};

/** Discriminated union of all registered extractor types. */
export type AnyZipContentExtractor =
  | ZipContentExtractor<string, ExtractorOutputType.String>
  | ZipContentExtractor<ExecutionResult, ExtractorOutputType.ExecutionResult>
  | ZipContentExtractor<JudgesReport, ExtractorOutputType.JudgesReport>
  | ZipContentExtractor<PerfSummary, ExtractorOutputType.PerfSummary>
  | ZipContentExtractor<PromptsSnapshot, ExtractorOutputType.PromptsSnapshot>;

/**
 * Container for heterogeneous extractor results.
 * Provides typed access via ContentKey<T> tokens.
 */
export class ZipContentBag {
  private readonly store = new Map<string, unknown>();
  private readonly priorities = new Map<string, number>();

  get<T>(key: ContentKey<T>): T | null {
    return (this.store.get(key) as T) ?? null;
  }

  set<T>(key: ContentKey<T>, value: T, priority?: number): void {
    this.store.set(key, value);
    if (priority !== undefined) {
      this.priorities.set(key, priority);
    }
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  getPriority(key: string): number {
    return this.priorities.get(key) ?? -1;
  }

  /**
   * Merge another bag into this one. First non-null wins per key.
   * Mirrors the merge semantics used across nested zip processing.
   */
  mergeFrom(other: ZipContentBag): void {
    for (const [key, value] of other.store) {
      if (!this.store.has(key) && value != null) {
        this.store.set(key, value);
      }
    }
  }

  /** All keys that have values. */
  keys(): string[] {
    return [...this.store.keys()];
  }
}
