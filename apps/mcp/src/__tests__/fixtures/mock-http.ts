/**
 * Shared Node HTTP request/response doubles for the MCP HTTP-entrypoint suites.
 *
 * `dispatchHttpRequest` and the OAuth handlers take raw `IncomingMessage` /
 * `ServerResponse`, so every suite that drives a real entrypoint needs the same
 * pair of doubles. Extracted so the fixture lives in one place instead of being
 * copied per suite.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export type MockResponse = {
  body: string;
  headers: Record<string, string>;
  statusCode: number;
  headersSent: boolean;
  writeHead: (...args: unknown[]) => MockResponse;
  end: (...args: unknown[]) => MockResponse;
  setHeader: (
    name: string,
    value: string | number | readonly string[]
  ) => MockResponse;
};

export type MockRequestOptions = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
};

export function createMockRequest(
  options: MockRequestOptions
): IncomingMessage {
  const body = options.body ?? "";
  const req = {
    method: options.method,
    url: options.url,
    headers: options.headers ?? {},
    socket: { remoteAddress: "127.0.0.1" },
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next: () => {
          if (sent || body.length === 0) {
            return Promise.resolve({ done: true, value: undefined });
          }
          sent = true;
          return Promise.resolve({
            done: false,
            value: Buffer.from(body, "utf8"),
          });
        },
      };
    },
  };

  return req as unknown as IncomingMessage;
}

export function createMockResponse(): MockResponse {
  const response: MockResponse = {
    body: "",
    headers: {},
    statusCode: 200,
    headersSent: false,
    writeHead(...args: unknown[]) {
      const statusCode = args[0];
      const maybeHeaders = args[1];
      if (typeof statusCode === "number") {
        response.statusCode = statusCode;
      }
      if (
        maybeHeaders &&
        typeof maybeHeaders === "object" &&
        !Array.isArray(maybeHeaders)
      ) {
        response.headers = {
          ...response.headers,
          ...(maybeHeaders as Record<string, string>),
        };
      }
      response.headersSent = true;
      return response;
    },
    end(...args: unknown[]) {
      const chunk = args[0];
      if (chunk !== undefined) {
        response.body += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
      }
      response.headersSent = true;
      return response;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      response.headers[name] = Array.isArray(value)
        ? value.join(", ")
        : String(value);
      return response;
    },
  };

  return response;
}

export function asServerResponse(response: MockResponse): ServerResponse {
  return response as unknown as ServerResponse;
}
