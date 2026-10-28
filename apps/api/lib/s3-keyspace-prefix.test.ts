import { TracingDisabledReason } from "@repo/observability/tracing/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-12056: the S3 keyspace a runtime writes to. Only a preview runtime whose
 * schema carries the vibe marker gets a prefix; nothing else reads the
 * database, and a failed read never degrades to "no prefix".
 */

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  setS3KeyspacePrefixResolver: vi.fn(),
  setPoolTelemetrySink: vi.fn(),
  setSchemaBootstrapHook: vi.fn(),
  initTracing: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  setPoolTelemetrySink: mocks.setPoolTelemetrySink,
  setSchemaBootstrapHook: mocks.setSchemaBootstrapHook,
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

vi.mock("@repo/aws/s3-client", () => ({
  setS3KeyspacePrefixResolver: mocks.setS3KeyspacePrefixResolver,
}));

vi.mock("@repo/observability/tracing/provider", () => ({
  initTracing: mocks.initTracing,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitDbPoolMetric: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/preview-schema-bootstrap", () => ({
  ensurePreviewSchemaBootstrap: vi.fn(),
}));

import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import {
  formatVibeEnvironmentMarker,
  VibeEnvironmentMode,
  VibeEnvironmentState,
  vibeEnvironmentKeyPrefix,
} from "@repo/database/scripts/vibe-environment";
import { registerNodeInstrumentation } from "@/instrumentation.node";
import {
  createVibeKeyspacePrefixResolver,
  KEYSPACE_PREFIX_CACHE_TTL_MS,
  readRuntimeSchemaComment,
  runtimePreviewSchema,
  runtimeRequiresVibeMarker,
} from "./s3-keyspace-prefix";

const BRANCH = "feat/vibe-env";
const SCHEMA = normalizePreviewSchemaName(BRANCH);
const VIBE_BRANCH = "vibe/bulk-tags";
const VIBE_SCHEMA = normalizePreviewSchemaName(VIBE_BRANCH);
const VIBE_COMMENT = formatVibeEnvironmentMarker({
  mode: VibeEnvironmentMode.Seeded,
  state: VibeEnvironmentState.Ready,
});

function previewEnv(): Parameters<typeof runtimePreviewSchema>[0] {
  return { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: BRANCH };
}

function mockCommentRows(rows: Array<{ comment: string | null }>): {
  queries: unknown[];
} {
  const queries: unknown[] = [];
  mocks.withDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      $queryRaw: (query: unknown) => {
        queries.push(query);
        return Promise.resolve(rows);
      },
    })
  );
  return { queries };
}

describe("runtimePreviewSchema", () => {
  it("answers the branch's preview schema on a Vercel preview", () => {
    expect(runtimePreviewSchema(previewEnv())).toBe(SCHEMA);
  });

  it("answers an explicit preview PGSCHEMA", () => {
    expect(runtimePreviewSchema({ PGSCHEMA: "preview_local_abc" })).toBe(
      "preview_local_abc"
    );
  });

  it.each([
    ["production", { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" }],
    ["stage (no schema)", {}],
    ["an explicit non-preview schema", { PGSCHEMA: "public" }],
  ])(
    "answers null on %s",
    (_name, env: Parameters<typeof runtimePreviewSchema>[0]) => {
      expect(runtimePreviewSchema(env)).toBeNull();
    }
  );
});

describe("runtimeRequiresVibeMarker", () => {
  it("requires a marker for a vibe preview branch", () => {
    expect(
      runtimeRequiresVibeMarker({
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: VIBE_BRANCH,
      })
    ).toBe(true);
  });

  it.each([
    [
      "regular preview",
      { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: BRANCH },
    ],
    [
      "production",
      { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: VIBE_BRANCH },
    ],
  ])("does not require a marker for %s", (_name, env) => {
    expect(runtimeRequiresVibeMarker(env)).toBe(false);
  });
});

describe("createVibeKeyspacePrefixResolver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers the schema's vibe prefix when the schema carries the marker", async () => {
    const resolve = createVibeKeyspacePrefixResolver(SCHEMA, () =>
      Promise.resolve(VIBE_COMMENT)
    );

    await expect(resolve()).resolves.toBe(vibeEnvironmentKeyPrefix(SCHEMA));
  });

  it.each([
    ["no comment", null],
    ["a comment that is not the marker", "owned by someone else"],
  ])("answers no prefix for a schema with %s", async (_name, comment) => {
    const resolve = createVibeKeyspacePrefixResolver(SCHEMA, () =>
      Promise.resolve(comment)
    );

    await expect(resolve()).resolves.toBe("");
  });

  it("refuses a vibe preview before its marker exists, then retries the read", async () => {
    const read = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(VIBE_COMMENT);
    const resolve = createVibeKeyspacePrefixResolver(VIBE_SCHEMA, read, true);

    await expect(resolve()).rejects.toThrow("has no valid marker");
    await expect(resolve()).resolves.toBe(
      vibeEnvironmentKeyPrefix(VIBE_SCHEMA)
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reuses one read until the TTL lapses, then reads again", async () => {
    const read = vi.fn(() => Promise.resolve<string | null>(VIBE_COMMENT));
    const resolve = createVibeKeyspacePrefixResolver(SCHEMA, read);

    await resolve();
    vi.advanceTimersByTime(KEYSPACE_PREFIX_CACHE_TTL_MS - 1);
    await resolve();
    expect(read).toHaveBeenCalledTimes(1);

    read.mockResolvedValueOnce(null);
    vi.advanceTimersByTime(1);
    await expect(resolve()).resolves.toBe("");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight read between concurrent callers", async () => {
    let release: (comment: string) => void = () => undefined;
    const read = vi.fn(
      () =>
        new Promise<string | null>((resolveRead) => {
          release = resolveRead;
        })
    );
    const resolve = createVibeKeyspacePrefixResolver(SCHEMA, read);

    const first = resolve();
    const second = resolve();
    release(VIBE_COMMENT);

    await expect(Promise.all([first, second])).resolves.toEqual([
      vibeEnvironmentKeyPrefix(SCHEMA),
      vibeEnvironmentKeyPrefix(SCHEMA),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects on a failed read instead of answering no prefix, and caches nothing", async () => {
    const read = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(VIBE_COMMENT);
    const resolve = createVibeKeyspacePrefixResolver(SCHEMA, read);

    await expect(resolve()).rejects.toThrow("connection refused");
    await expect(resolve()).resolves.toBe(vibeEnvironmentKeyPrefix(SCHEMA));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects after an expired answer when the re-read fails, rather than reusing it", async () => {
    const read = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("connection refused"));
    const resolve = createVibeKeyspacePrefixResolver(SCHEMA, read);

    await expect(resolve()).resolves.toBe("");
    vi.advanceTimersByTime(KEYSPACE_PREFIX_CACHE_TTL_MS);

    await expect(resolve()).rejects.toThrow("connection refused");
  });
});

describe("readRuntimeSchemaComment", () => {
  it("reads the schema's catalog comment, binding the name as a value", async () => {
    const { queries } = mockCommentRows([{ comment: VIBE_COMMENT }]);

    await expect(readRuntimeSchemaComment(SCHEMA)).resolves.toBe(VIBE_COMMENT);

    const query = queries[0] as { strings: string[]; values: unknown[] };
    expect(query.strings.join("?")).toContain(
      "obj_description(oid, 'pg_namespace')"
    );
    expect(query.values).toEqual([SCHEMA]);
  });

  it("answers null when the schema does not exist", async () => {
    mockCommentRows([]);

    await expect(readRuntimeSchemaComment(SCHEMA)).resolves.toBeNull();
  });
});

describe("registerNodeInstrumentation keyspace wiring", () => {
  beforeEach(() => {
    mocks.initTracing.mockReturnValue({
      enabled: false,
      reason: TracingDisabledReason.NotDeployed,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("installs a resolver on a preview runtime that answers from the runtime's schema comment", async () => {
    vi.stubEnv("PGSCHEMA", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", BRANCH);
    const { queries } = mockCommentRows([{ comment: VIBE_COMMENT }]);

    await registerNodeInstrumentation();

    expect(mocks.setS3KeyspacePrefixResolver).toHaveBeenCalledTimes(1);
    const resolver = mocks.setS3KeyspacePrefixResolver.mock.calls[0][0] as
      | (() => Promise<string>)
      | null;
    await expect(resolver?.()).resolves.toBe(vibeEnvironmentKeyPrefix(SCHEMA));
    const query = queries[0] as { values: unknown[] };
    expect(query.values).toEqual([SCHEMA]);
  });

  it("installs nothing, and reads nothing, outside a preview runtime", async () => {
    vi.stubEnv("PGSCHEMA", "");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "main");

    await registerNodeInstrumentation();

    expect(mocks.setS3KeyspacePrefixResolver).not.toHaveBeenCalled();
    expect(mocks.withDb).not.toHaveBeenCalled();
  });

  it("refuses unprefixed S3 calls before a vibe preview has its marker", async () => {
    vi.stubEnv("PGSCHEMA", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", VIBE_BRANCH);
    mockCommentRows([{ comment: null }]);

    await registerNodeInstrumentation();

    const resolver = mocks.setS3KeyspacePrefixResolver.mock.calls[0]?.[0] as
      | (() => Promise<string>)
      | undefined;
    await expect(resolver?.()).rejects.toThrow("has no valid marker");
  });
});
