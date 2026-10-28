import type { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";

/**
 * ISS-12056: a vibe environment shares stage's buckets, so every key it sends
 * is moved under its own per-schema prefix here, below every caller. Callers
 * keep writing the keys they always wrote; the prefix is added on the way out
 * and stripped from listed keys on the way back, so nothing above the client
 * can see or forget it.
 *
 * Applied as an `initialize` step middleware, which also runs for presigned
 * URLs: `getSignedUrl` resolves the command against a clone of the client's
 * stack, so a URL handed to a browser or Desktop points at the prefixed key.
 */
export type S3KeyspacePrefixResolver = () => Promise<string>;

/**
 * ISS-12135: on a `Symbol.for` slot rather than a module binding. apps/api
 * installs the resolver from its instrumentation entry, and a route bundle can
 * carry its own copy of this module; a module binding left the route's copy
 * with no resolver, so a vibe preview signed transcript URLs at stage's
 * unprefixed keys.
 */
const PREFIX_RESOLVER_SLOT = Symbol.for(
  "closedloop.aws.s3KeyspacePrefixResolver"
);

type PrefixResolverSlot = {
  [PREFIX_RESOLVER_SLOT]?: S3KeyspacePrefixResolver | null;
};

/** `null` removes the resolver, and every key is sent as given. */
export function setKeyspacePrefixResolver(
  resolver: S3KeyspacePrefixResolver | null
): void {
  prefixResolverSlot()[PREFIX_RESOLVER_SLOT] = resolver;
}

/** Idempotent: re-adding replaces the same named middleware. */
export function installKeyspacePrefixMiddleware(client: S3Client): void {
  client.middlewareStack.add(keyspacePrefixMiddleware, {
    step: "initialize",
    priority: "high",
    name: KEYSPACE_PREFIX_MIDDLEWARE_NAME,
    override: true,
  });
}

/** The key-bearing input fields any command this package sends can carry. */
const keyedInputSchema = z.object({
  Key: z.string().optional(),
  Prefix: z.string().optional(),
  StartAfter: z.string().optional(),
  CopySource: z.string().optional(),
  Delete: z
    .looseObject({ Objects: z.array(z.looseObject({ Key: z.string() })) })
    .optional(),
});

const optionalKeyEntry = z.looseObject({ Key: z.string().optional() });

/** The key-bearing output fields, stripped so callers never see the prefix. */
const keyedOutputSchema = z.object({
  Key: z.string().optional(),
  Prefix: z.string().optional(),
  StartAfter: z.string().optional(),
  Contents: z.array(optionalKeyEntry).optional(),
  CommonPrefixes: z
    .array(z.looseObject({ Prefix: z.string().optional() }))
    .optional(),
  Deleted: z.array(optionalKeyEntry).optional(),
  Errors: z.array(optionalKeyEntry).optional(),
});

const KEYSPACE_PREFIX_MIDDLEWARE_NAME = "closedloopKeyspacePrefixMiddleware";

/**
 * Listing commands scope to the prefix even when the caller passed none, so an
 * unprefixed listing cannot walk stage's objects.
 */
const LISTING_COMMANDS: ReadonlySet<string> = new Set([
  "ListObjectsV2Command",
  "ListObjectsCommand",
  "ListObjectVersionsCommand",
  "ListMultipartUploadsCommand",
]);

type InitializeArgs<I> = { input: I };
type InitializeResult<O> = { output: O; response: unknown };
type InitializeHandler<I, O> = (
  args: InitializeArgs<I>
) => Promise<InitializeResult<O>>;

function keyspacePrefixMiddleware<I extends object, O extends object>(
  next: InitializeHandler<I, O>,
  context: { commandName?: string }
): InitializeHandler<I, O> {
  return async (args) => {
    const prefix = await resolveKeyspacePrefix();
    if (prefix === "") {
      return await next(args);
    }
    const isListing = LISTING_COMMANDS.has(context.commandName ?? "");
    const result = await next({
      ...args,
      input: prefixInput(args.input, prefix, isListing),
    });
    return { ...result, output: stripOutput(result.output, prefix) };
  };
}

/**
 * A resolver failure rejects the S3 call. Falling back to no prefix would put
 * a vibe environment's writes into stage's keyspace.
 */
async function resolveKeyspacePrefix(): Promise<string> {
  const prefixResolver = prefixResolverSlot()[PREFIX_RESOLVER_SLOT] ?? null;
  if (prefixResolver === null) {
    return "";
  }
  const prefix = await prefixResolver();
  if (prefix !== "" && !(prefix.endsWith("/") && !prefix.startsWith("/"))) {
    throw new Error(
      `S3 keyspace prefix must be empty or a relative path ending in "/" (got "${prefix}")`
    );
  }
  return prefix;
}

function prefixInput<I extends object>(
  input: I,
  prefix: string,
  isListing: boolean
): I {
  const parsed = keyedInputSchema.parse(input);
  const overrides: Record<string, unknown> = {};
  if (parsed.Key !== undefined) {
    overrides.Key = prefix + parsed.Key;
  }
  if (parsed.Prefix !== undefined || isListing) {
    overrides.Prefix = prefix + (parsed.Prefix ?? "");
  }
  if (parsed.StartAfter !== undefined) {
    overrides.StartAfter = prefix + parsed.StartAfter;
  }
  if (parsed.CopySource !== undefined) {
    overrides.CopySource = prefixCopySource(parsed.CopySource, prefix);
  }
  if (parsed.Delete !== undefined) {
    overrides.Delete = {
      ...parsed.Delete,
      Objects: parsed.Delete.Objects.map((entry) => ({
        ...entry,
        Key: prefix + entry.Key,
      })),
    };
  }
  return { ...input, ...overrides };
}

function stripOutput<O extends object>(output: O, prefix: string): O {
  const parsed = keyedOutputSchema.parse(output);
  const strip = (value: string | undefined) =>
    value?.startsWith(prefix) ? value.slice(prefix.length) : value;
  const stripKeys = (entries: z.infer<typeof optionalKeyEntry>[] | undefined) =>
    entries?.map((entry) => ({ ...entry, Key: strip(entry.Key) }));
  const overrides: Record<string, unknown> = {};
  for (const field of ["Key", "Prefix", "StartAfter"] as const) {
    if (parsed[field] !== undefined) {
      overrides[field] = strip(parsed[field]);
    }
  }
  for (const field of ["Contents", "Deleted", "Errors"] as const) {
    if (parsed[field] !== undefined) {
      overrides[field] = stripKeys(parsed[field]);
    }
  }
  if (parsed.CommonPrefixes !== undefined) {
    overrides.CommonPrefixes = parsed.CommonPrefixes.map((entry) => ({
      ...entry,
      Prefix: strip(entry.Prefix),
    }));
  }
  return { ...output, ...overrides };
}

/**
 * `CopySource` is `[/]bucket/url-encoded-key[?versionId=...]`; the prefix is
 * inserted after the bucket, encoded the way callers encode their keys.
 */
function prefixCopySource(copySource: string, prefix: string): string {
  const lead = copySource.startsWith("/") ? "/" : "";
  const rest = copySource.slice(lead.length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    throw new Error(`CopySource "${copySource}" names no key`);
  }
  const encodedPrefix = prefix.split("/").map(encodeURIComponent).join("/");
  return `${lead}${rest.slice(0, slash + 1)}${encodedPrefix}${rest.slice(slash + 1)}`;
}

function prefixResolverSlot(): PrefixResolverSlot {
  return globalThis as PrefixResolverSlot;
}
