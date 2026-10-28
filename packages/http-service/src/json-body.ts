import type { Env, MiddlewareHandler } from "hono";
import type { z } from "zod";
import { errorResponse, HttpServiceErrorCode } from "./errors";

/**
 * Validates the JSON body with `schema` and hands the result to the handler
 * as `c.req.valid("json")`, the slot `hono/validator` fills. The body is read
 * here rather than through `validator("json")`, which skips a body without a
 * JSON content-type and throws on malformed JSON. With `anyContentType` off,
 * a missing or non-JSON `content-type` is refused before the body is read;
 * on, the body is parsed as JSON whatever the header says. A body that is not
 * JSON, or that the schema refuses, answers 400.
 */
export function jsonBody<S extends z.ZodType<object>>(
  schema: S,
  {
    anyContentType = false,
    code = HttpServiceErrorCode.InvalidBody,
  }: { anyContentType?: boolean; code?: string | null } = {}
): MiddlewareHandler<
  Env,
  string,
  { in: { json: z.input<S> }; out: { json: z.output<S> } }
> {
  return async (c, next) => {
    if (!(anyContentType || isJsonContentType(c.req.header("content-type")))) {
      return errorResponse(c, HTTP_BAD_REQUEST, code);
    }
    const parsed = schema.safeParse(parseJson(await c.req.text()));
    if (!parsed.success) {
      return errorResponse(c, HTTP_BAD_REQUEST, code);
    }
    c.req.addValidatedData("json", parsed.data);
    await next();
  };
}

function isJsonContentType(contentType: string | undefined): boolean {
  return contentType !== undefined && JSON_CONTENT_TYPE.test(contentType);
}

/** `undefined` for a body that is not JSON, which no body schema accepts. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `hono/validator`'s own test for a JSON body. */
const JSON_CONTENT_TYPE =
  /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/;
const HTTP_BAD_REQUEST = 400;
