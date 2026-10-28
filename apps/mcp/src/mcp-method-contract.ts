/**
 * The public HTTP method contract at `/mcp`.
 *
 * `Allow` is a wire value external MCP clients read off the `405` that refuses
 * the Streamable HTTP standalone SSE stream (ISS-8272), so it is owned here
 * rather than written inline at the one place that serves it. A literal
 * repeated in an assertion only proves the test agrees with itself; importing
 * this makes the served header and its coverage the same value.
 */
export const MCP_ALLOWED_METHODS = "POST, DELETE" as const;
