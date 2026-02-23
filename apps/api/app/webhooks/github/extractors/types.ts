/**
 * Protocol and container types for the zip content extractor registry.
 *
 * The extractor pattern follows Open-Closed Principle: new content types
 * are added by creating an extractor file and registering it, without
 * modifying the extraction engine.
 */

import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { ExecutionResult } from "@repo/api/src/types/execution-result";
import type { PerfSummary } from "@repo/api/src/types/performance";
import type { PromptsSnapshot } from "./prompt-types";

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
  | ZipContentExtractor<string, typeof ExtractorOutputType.String>
  | ZipContentExtractor<
      ExecutionResult,
      typeof ExtractorOutputType.ExecutionResult
    >
  | ZipContentExtractor<JudgesReport, typeof ExtractorOutputType.JudgesReport>
  | ZipContentExtractor<PerfSummary, typeof ExtractorOutputType.PerfSummary>
  | ZipContentExtractor<
      PromptsSnapshot,
      typeof ExtractorOutputType.PromptsSnapshot
    >;

/**
 * Container for heterogeneous extractor results.
 * Provides typed access via ContentKey<T> tokens.
 */
export class ZipContentBag {
  private readonly store = new Map<string, unknown>();
  private readonly priorities = new Map<string, number>();
  private readonly mergeFunctions = new Map<
    string,
    (a: unknown, b: unknown) => unknown
  >();

  get<T>(key: ContentKey<T>): T | null {
    return (this.store.get(key) as T) ?? null;
  }

  set<T>(key: ContentKey<T>, value: T, priority?: number): void {
    this.store.set(key, value);
    if (priority !== undefined) {
      this.priorities.set(key, priority);
    }
  }

  /**
   * Store a value for an accumulating key and register its merge function.
   * Used by extractors that define mergeWith — ensures mergeFrom() can
   * accumulate across bags rather than applying priority-wins logic.
   */
  setAccumulating<T>(
    key: ContentKey<T>,
    value: T,
    mergeFn: (existing: T, next: T) => T
  ): void {
    this.store.set(key, value);
    this.mergeFunctions.set(
      key,
      mergeFn as (a: unknown, b: unknown) => unknown
    );
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  getPriority(key: string): number {
    return this.priorities.get(key) ?? -1;
  }

  /**
   * Merge another bag into this one.
   *
   * - Accumulating keys (registered via setAccumulating): values are merged
   *   using the stored merge function so prompts/snapshots from multiple inner
   *   zips are combined rather than the first-one-wins behaviour of priority logic.
   * - Priority-based keys: highest priority wins (e.g. plan.json at 10 beats
   *   implementation-plan.md at 5).
   */
  mergeFrom(other: ZipContentBag): void {
    for (const [key, value] of other.store) {
      if (value == null) {
        continue;
      }

      const mergeFn =
        this.mergeFunctions.get(key) ?? other.mergeFunctions.get(key);
      if (mergeFn != null) {
        const existing = this.store.get(key);
        const merged = existing != null ? mergeFn(existing, value) : value;
        this.store.set(key, merged);
        if (!this.mergeFunctions.has(key)) {
          this.mergeFunctions.set(key, mergeFn);
        }
        continue;
      }

      const incomingPriority = other.priorities.get(key) ?? 0;
      const existingPriority = this.priorities.get(key) ?? -1;
      if (incomingPriority > existingPriority) {
        this.store.set(key, value);
        this.priorities.set(key, incomingPriority);
      }
    }
  }

  /** All keys that have values. */
  keys(): string[] {
    return [...this.store.keys()];
  }
}
