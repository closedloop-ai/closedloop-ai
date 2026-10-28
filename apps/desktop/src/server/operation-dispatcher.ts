import type { IncomingMessage, ServerResponse } from "node:http";
import { SymphonyDirNotConfiguredError } from "./operations/symphony-utils.js";

export type OperationRequestContext = {
  method: string;
  pathname: string;
  params: Record<string, string>;
  query: URLSearchParams;
  rawBody: Buffer;
  body: string;
  request: IncomingMessage;
  response: ServerResponse;
};

export type OperationHandler = (
  context: OperationRequestContext
) => Promise<void> | void;

export class OperationDispatcher {
  private readonly handlers: Array<{
    method: string;
    pathnamePattern: string;
    matcher: RegExp;
    parameterNames: string[];
    handler: OperationHandler;
  }> = [];

  register(method: string, pathname: string, handler: OperationHandler): void {
    const { matcher, parameterNames } = compilePathPattern(pathname);
    this.handlers.push({
      method: method.toUpperCase(),
      pathnamePattern: pathname,
      matcher,
      parameterNames,
      handler,
    });
  }

  async dispatch(context: OperationRequestContext): Promise<boolean> {
    for (const route of this.handlers) {
      if (route.method !== context.method.toUpperCase()) {
        continue;
      }

      const match = route.matcher.exec(context.pathname);
      if (!match) {
        continue;
      }

      const params = decodeRouteParams(route.parameterNames, match);
      if (params === null) {
        context.response.statusCode = 400;
        context.response.setHeader("content-type", "application/json");
        context.response.end(
          JSON.stringify({
            error: "malformed percent-encoding in path",
          })
        );
        return true;
      }

      try {
        await route.handler({
          ...context,
          params,
        });
      } catch (error) {
        if (error instanceof SymphonyDirNotConfiguredError) {
          context.response.statusCode = 503;
          context.response.setHeader("content-type", "application/json");
          context.response.end(
            JSON.stringify({
              error: "Server not configured — complete onboarding",
            })
          );
          return true;
        }
        throw error;
      }
      return true;
    }
    return false;
  }
}

function compilePathPattern(pathnamePattern: string): {
  matcher: RegExp;
  parameterNames: string[];
} {
  const parameterNames: string[] = [];
  const escapedPattern = pathnamePattern
    .split("/")
    .map((part) => {
      if (part.startsWith(":")) {
        parameterNames.push(part.slice(1));
        return "([^/]+)";
      }
      if (part.startsWith("*")) {
        parameterNames.push(part.slice(1));
        return "(.+)";
      }
      return part.replaceAll(/[$()*+.?[\\\]^{|}]/g, "\\$&");
    })
    .join("/");

  return {
    matcher: new RegExp(`^${escapedPattern}$`),
    parameterNames,
  };
}

/**
 * Returns null — never throws — when a captured segment is not valid
 * percent-encoding (`decodeURIComponent` raises `URIError` on a truncated
 * escape such as `%E0%A4%A`), so the caller can answer 400.
 *
 * Deliberately OUTSIDE the handler try/catch in `dispatch`: a `URIError` raised
 * inside a handler is that handler's own bug and must keep propagating, so the
 * two cannot share one catch without reporting a server fault as a client one.
 * Falling back to the raw undecoded segment is also wrong — handlers treat
 * params as filesystem paths, so it would hand them a value the client never
 * sent.
 */
function decodeRouteParams(
  parameterNames: string[],
  match: RegExpExecArray
): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let index = 0; index < parameterNames.length; index += 1) {
    const parameterName = parameterNames[index];
    const value = match[index + 1] ?? "";
    try {
      params[parameterName] = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return params;
}
