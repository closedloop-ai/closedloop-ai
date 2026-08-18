/**
 * Shared numeric limits for the historical-parse worker boundary (extracted
 * from `historical-parse-worker-protocol.ts`, FEA-4093). Kept in its own module
 * so both the protocol schema/response code and the stderr-sanitizer can import
 * the caps without a circular dependency between those two modules.
 */
export const HistoricalParseWorkerLimits = {
  maxWorkerSessionsPerSource: 50_000,
  // Per-array cap. Kept in line with the response-wide item budget below so a
  // single long session (tens of thousands of messages) is not rejected by a
  // limit far tighter than the real memory guard. The producer clamps to these
  // limits before sending (see clampSessionsForWorkerResponse), so the response
  // always validates and an oversized session degrades to truncated detail
  // arrays instead of killing the worker.
  maxSessionArrayItems: 50_000,
  maxWorkerResponseArrayItems: 50_000,
  maxWorkerResponseTextBytes: 8_000_000,
  maxUnknownDepth: 8,
  maxUnknownArrayItems: 1000,
  maxUnknownObjectKeys: 250,
  maxShortTextLength: 8192,
  maxLongTextLength: 2_000_000,
  maxWorkerStderrPreviewBytes: 512,
} as const;
