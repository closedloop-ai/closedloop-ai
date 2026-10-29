/**
 * The reading half of `openapi-batch-item-results.test.ts` (ISS-9464): what the
 * App Router serves, what a Zod body actually enforces, and how much of the
 * published document one operation really covers. The suite keeps the
 * expectations; nothing here knows what they are.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export type JsonSchema = {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  not?: JsonSchema;
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  maxProperties?: number;
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  $ref?: string;
};

export type Operation = {
  operationId?: string;
  security?: unknown[];
  requestBody?: {
    content: Record<string, { schema: JsonSchema; example?: unknown }>;
  };
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema: JsonSchema }>;
    }
  >;
};

const SCHEMA_REF_PATTERN = /#\/components\/schemas\/[A-Za-z0-9_]+/g;
/** The `...` of a catch-all segment; `[...slug]` is still one `{slug}` path key. */
const CATCH_ALL_PREFIX = /^\.\.\.?/;

/**
 * The `/v2` route paths this app ships, read from the App Router tree the way
 * Next.js resolves them: a directory named `v2` holding a `route.ts`.
 *
 * Segments are translated, not copied. A route group contributes nothing to the
 * URL and a dynamic segment is spelled `{id}` in OpenAPI, so a `[id]` or `(x)`
 * passed through verbatim would produce a path no document can ever match and
 * red as "the spec omits a route" when the reader is what is wrong.
 */
export function collectShippedV2Routes(
  directory: string,
  urlPrefix = ""
): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const childUrl = urlPrefix + urlSegment(entry.name);
    const childPath = path.join(directory, entry.name);
    if (entry.name === "v2" && readdirSync(childPath).includes("route.ts")) {
      routes.push(childUrl);
    }
    routes.push(...collectShippedV2Routes(childPath, childUrl));
  }
  return routes;
}

/** The keys a Zod object body actually accepts. */
export function acceptedProperties(schema: {
  shape: Record<string, unknown>;
}): string[] {
  return Object.keys(schema.shape).sort();
}

/**
 * The bounds a Zod member actually enforces, expressed as JSON Schema so the
 * published `minItems`/`maxItems` are compared against the validator itself
 * rather than against a number someone typed into both places.
 */
export function enforcedArrayBound(
  schema: { shape: Record<string, z.ZodType> },
  field: string
): { minItems?: number; maxItems?: number } {
  return z.toJSONSchema(member(schema, field));
}

/**
 * The closed set a Zod member actually accepts, read off the member the way
 * {@link enforcedArrayBound} reads its bounds. A `z.enum` converts to `enum`
 * and a `z.literal` to a single `const`; both are the same claim about what the
 * route will take.
 *
 * Only usable where the member REFUSES everything outside the set. A `.catch`
 * upstream of the narrowing makes the vocabulary open at the wire however
 * closed it looks here — the batch PRIORITY `surface` is that case — so its
 * conversion is not an answer about what the route accepts.
 */
export function enforcedVocabulary(
  schema: { shape: Record<string, z.ZodType> },
  field: string
): readonly string[] {
  const converted: { const?: unknown; enum?: unknown[] } = z.toJSONSchema(
    member(schema, field)
  );
  const accepted =
    converted.enum ??
    (converted.const === undefined ? undefined : [converted.const]);
  if (!accepted) {
    throw new Error(
      `the validator's \`${field}\` member accepts no closed vocabulary, so the spec has nothing to agree with`
    );
  }
  return accepted.map(String);
}

/**
 * The shape of the `too_big` issue an `expected<Field>ById` container reports
 * for a map over its key cap, so {@link reportedKeyCap} reads a validated
 * number rather than casting an issue.
 */
const KEY_CAP_ISSUE = z.object({
  code: z.literal(z.ZodIssueCode.too_big),
  maximum: z.number(),
  path: z.array(z.string()),
});

/**
 * The key cap the validator itself reported for `field`, read off its own
 * issue.
 *
 * NOT off `.success`: a map one key past the cap also breaks the "every key is
 * one of the selected ids" rule, so a bare rejection looks identical whether or
 * not anything still enforces the cap — which is how this case passed under a
 * validator whose cap had been loosened by one.
 */
export function reportedKeyCap(
  result: { error?: { issues: readonly unknown[] } },
  field: string
): number | undefined {
  for (const issue of result.error?.issues ?? []) {
    const reported = KEY_CAP_ISSUE.safeParse(issue);
    if (reported.success && reported.data.path.join(".") === field) {
      return reported.data.maximum;
    }
  }
  return undefined;
}

/**
 * One operation plus every component schema it reaches, transitively, as JSON
 * text.
 *
 * A scan over the operation alone sees `$ref` STRINGS where the shared response
 * lives, so the schemas six operations have in common — the ones likeliest to
 * grow the keyword a scan is hunting for — are exactly what it cannot see
 * (ISS-9464 review).
 */
export function operationWithResolvedSchemas(
  operation: Operation,
  schemas: Record<string, JsonSchema>
): string {
  const resolved = new Map<string, JsonSchema>();
  const pending = schemaRefNames(operation);
  while (pending.length > 0) {
    const name = pending.pop() as string;
    const schema = schemas[name];
    if (!schema || resolved.has(name)) {
      continue;
    }
    resolved.set(name, schema);
    pending.push(...schemaRefNames(schema));
  }
  return JSON.stringify([operation, Object.fromEntries(resolved)]);
}

/** The component-schema names one value references, at any depth. */
export function schemaRefNames(value: unknown): string[] {
  const refs = JSON.stringify(value).match(SCHEMA_REF_PATTERN) ?? [];
  return refs.map((ref) => ref.split("/").pop() as string);
}

/**
 * Every component-schema name one value reaches, following refs through the
 * schemas it lands on. A name with no definition is still returned, so a caller
 * checking that each one resolves sees the dangling one rather than the walk
 * quietly stopping at it.
 */
export function reachableSchemaNames(
  value: unknown,
  schemas: Record<string, JsonSchema>
): string[] {
  const seen = new Set<string>();
  const pending = schemaRefNames(value);
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const schema = schemas[name];
    if (schema) {
      pending.push(...schemaRefNames(schema));
    }
  }
  return [...seen];
}

/** The keys every one of these objects carries, and the keys any of them do. */
export function sharedAndUnionKeys(objects: readonly object[]): {
  shared: string[];
  union: string[];
} {
  const keySets = objects.map((item) => Object.keys(item));
  const union = [...new Set(keySets.flat())].sort();
  return {
    shared: union.filter((key) => keySets.every((keys) => keys.includes(key))),
    union,
  };
}

function member(
  schema: { shape: Record<string, z.ZodType> },
  field: string
): z.ZodType {
  const found = schema.shape[field];
  if (!found) {
    throw new Error(`no validator member accepts the documented \`${field}\``);
  }
  return found;
}

/** One App Router directory's contribution to the URL Next.js serves it at. */
function urlSegment(name: string): string {
  if (name.startsWith("(") && name.endsWith(")")) {
    return "";
  }
  if (name.startsWith("[") && name.endsWith("]")) {
    return `/{${name.slice(1, -1).replace(CATCH_ALL_PREFIX, "")}}`;
  }
  return `/${name}`;
}
