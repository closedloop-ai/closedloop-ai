type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

export function withErrorHandling(
  fn: () => Promise<ToolResult>
): Promise<ToolResult> {
  return fn().catch((error: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      },
    ],
    isError: true,
  }));
}

/**
 * Encode a user-supplied ID for safe interpolation into a URL path segment.
 * Prevents path traversal attacks (e.g. "../../admin") by URI-encoding
 * slashes and other special characters.
 */
export function encodePathSegment(id: string): string {
  return encodeURIComponent(id);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...[truncated]`;
}

export function buildPaginatedPayload<T>(
  items: T[],
  options: {
    limit?: number;
    offset?: number;
    mapItem: (item: T) => unknown;
    defaultLimit?: number;
  }
): {
  total: number;
  offset: number;
  limit: number;
  returned: number;
  hasMore: boolean;
  nextOffset: number | null;
  items: unknown[];
} {
  const resolvedOffset = options.offset ?? 0;
  const resolvedLimit =
    options.limit ?? options.defaultLimit ?? DEFAULT_PAGE_LIMIT;
  const page = items
    .slice(resolvedOffset, resolvedOffset + resolvedLimit)
    .map(options.mapItem);
  const hasMore = resolvedOffset + page.length < items.length;
  return {
    total: items.length,
    offset: resolvedOffset,
    limit: resolvedLimit,
    returned: page.length,
    hasMore,
    nextOffset: hasMore ? resolvedOffset + page.length : null,
    items: page,
  };
}
