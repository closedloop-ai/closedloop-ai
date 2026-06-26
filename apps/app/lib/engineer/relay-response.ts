type ParsedRelayHttpResponse = {
  status: number;
  headers: Headers;
  body: unknown;
};

/**
 * Normalizes HTTP-like responses returned by Electron through relay transports.
 * Returns null when an object is missing the expected response envelope.
 */
export function parseRelayHttpResponse(
  value: unknown
): ParsedRelayHttpResponse | null {
  if (typeof value !== "object" || value === null) {
    return {
      status: 200,
      headers: new Headers(),
      body: value,
    };
  }

  const record = value as Record<string, unknown>;

  // Electron gateway wraps results as { statusCode, success, data } while the
  // relay envelope uses { status, body }. Handle both.
  let status: number | undefined;
  if (typeof record.status === "number") {
    status = record.status;
  } else if (typeof record.statusCode === "number") {
    status = record.statusCode;
  }

  let body: unknown;
  if ("body" in record) {
    body = record.body;
  } else if ("data" in record) {
    body = record.data;
  }

  if (status !== undefined && body !== undefined) {
    return {
      status,
      headers: new Headers(
        typeof record.headers === "object" && record.headers !== null
          ? (record.headers as Record<string, string>)
          : undefined
      ),
      body,
    };
  }

  return null;
}
