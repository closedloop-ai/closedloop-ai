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

      const params: Record<string, string> = {};
      for (let index = 0; index < route.parameterNames.length; index += 1) {
        const parameterName = route.parameterNames[index];
        const value = match[index + 1] ?? "";
        params[parameterName] = decodeURIComponent(value);
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
