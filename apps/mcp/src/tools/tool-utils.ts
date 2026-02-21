type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

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
