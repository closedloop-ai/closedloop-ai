import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

const waitUntilMock = vi.hoisted(() => vi.fn());

vi.mock("@vercel/functions", () => ({
  waitUntil: waitUntilMock,
}));

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  // `searchIndexService.upsert` delegates to the shared multi-row `upsertMany`
  // (FEA-4011), which builds each row with `Prisma.sql` and stitches the rows
  // with `Prisma.join`. Both must exist on the mock; the returned `{ strings,
  // values }` fragments nest, and `interpolatedValues` below flattens them so a
  // test can still assert on the interpolated scalars.
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (fragments: unknown[]) => ({
      strings: [] as unknown as TemplateStringsArray,
      values: fragments,
    }),
  },
}));

import { withDb } from "@repo/database";
import { transcriptSearchIndexService } from "./transcript-search-indexer";

const mockWithDb = withDb as unknown as Mock;

const ORG = "org-1";
const OTHER_ORG = "org-2";
const COMPUTE_TARGET = "ct-1";
const EXTERNAL_SESSION = "ext-session-1";
const ARTIFACT_ID = "artifact-1";
const OBJECT_KEY = "org-1/ct-1/ext-session-1/main.jsonl";

const MAIN_TRANSCRIPT = `${JSON.stringify({
  type: "user",
  message: { role: "user", content: "Fix the login bug" },
})}\n${JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "Patched." }] },
})}`;

/**
 * Fake `withDb` backed by an in-memory session + transcript row. `gateOn`
 * controls the org's `searchIncludeTranscripts`. Captures the upsert's
 * `$executeRaw` call so a test can assert the projection write shape/body. When
 * `session` is null the session lookup misses (unmaterialized session).
 */
function installDb(options: {
  gateOn: boolean;
  organizationId?: string;
  hasSession?: boolean;
  transcriptUploaded?: boolean;
}) {
  const executeRaw = vi.fn().mockResolvedValue(1);
  const sessionOrg = options.organizationId ?? ORG;
  const hasSession = options.hasSession ?? true;
  const transcriptUploaded = options.transcriptUploaded ?? true;

  const db = {
    $executeRaw: executeRaw,
    sessionDetail: {
      findFirst: vi.fn(
        (args: { where: { artifact: { is: { organizationId: string } } } }) => {
          // Org-scoping: the session is only visible to its owning org.
          if (
            !hasSession ||
            args.where.artifact.is.organizationId !== sessionOrg
          ) {
            return Promise.resolve(null);
          }
          return Promise.resolve({
            artifactId: ARTIFACT_ID,
            artifact: {
              name: "Login bug session",
              assigneeId: "user-1",
              updatedAt: new Date("2026-02-02"),
              organization: { searchIncludeTranscripts: options.gateOn },
            },
          });
        }
      ),
    },
    sessionTranscript: {
      findFirst: vi.fn(() =>
        Promise.resolve(
          transcriptUploaded ? { objectStorageKey: OBJECT_KEY } : null
        )
      ),
    },
  };
  mockWithDb.mockImplementation((cb: (d: unknown) => unknown) => cb(db));
  return { db, executeRaw };
}

/**
 * Read the interpolated scalar values from a `$executeRaw` tagged-template mock
 * call: `db.$executeRaw\`... ${a} ${b}\`` invokes the mock as `(strings, a, b)`,
 * so the interpolated values are every arg after the template-strings array.
 *
 * The multi-row upsert (FEA-4011) interpolates a single `Prisma.join(...)`
 * fragment carrying nested `Prisma.sql` row fragments, so the raw args are
 * `{ strings, values }` objects rather than flat scalars. Recursively flatten
 * any such fragment so a test can still assert on the interpolated scalars
 * (entity type, id, extracted body) regardless of single- vs multi-row nesting.
 */
function interpolatedValues(executeRaw: Mock): unknown[] {
  return flattenSqlValues(executeRaw.mock.calls[0].slice(1));
}

function isSqlFragment(value: unknown): value is { values: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { values?: unknown }).values)
  );
}

function flattenSqlValues(values: unknown[]): unknown[] {
  const flat: unknown[] = [];
  for (const value of values) {
    if (isSqlFragment(value)) {
      flat.push(...flattenSqlValues(value.values));
    } else {
      flat.push(value);
    }
  }
  return flat;
}

function input(over: { organizationId?: string; fileKey?: string } = {}) {
  return {
    organizationId: over.organizationId ?? ORG,
    computeTargetId: COMPUTE_TARGET,
    externalSessionId: EXTERNAL_SESSION,
    fileKey: over.fileKey ?? "main",
  };
}

describe("transcriptSearchIndexService.index — gating", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("indexes the transcript when the org gate is ON", async () => {
    const { executeRaw } = installDb({ gateOn: true });
    const readTranscriptBytes = vi
      .fn()
      .mockResolvedValue(Buffer.from(MAIN_TRANSCRIPT, "utf8"));

    const indexed = await transcriptSearchIndexService.index(input(), {
      readTranscriptBytes,
    });

    expect(indexed).toBe(true);
    expect(readTranscriptBytes).toHaveBeenCalledWith(
      OBJECT_KEY,
      expect.any(Number)
    );
    // The upsert ran and carried the agent_session entity type + extracted body.
    // `$executeRaw` is a tagged template: calls[0] = [strings, ...interpolated].
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const sqlValues = interpolatedValues(executeRaw);
    expect(sqlValues).toContain(SearchEntityType.AgentSession);
    expect(sqlValues).toContain(ARTIFACT_ID);
    expect(sqlValues).toContain("Fix the login bug\nPatched.");
  });

  it("does NOT index (no S3 read, no upsert) when the org gate is OFF", async () => {
    const { executeRaw } = installDb({ gateOn: false });
    const readTranscriptBytes = vi.fn();

    const indexed = await transcriptSearchIndexService.index(input(), {
      readTranscriptBytes,
    });

    expect(indexed).toBe(false);
    // Privacy: the gate is checked before any S3 read or projection write.
    expect(readTranscriptBytes).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("skips subagent files — only the main transcript feeds the body", async () => {
    const { executeRaw } = installDb({ gateOn: true });
    const readTranscriptBytes = vi.fn();

    const indexed = await transcriptSearchIndexService.index(
      input({ fileKey: "subagent:abc" }),
      { readTranscriptBytes }
    );

    expect(indexed).toBe(false);
    expect(readTranscriptBytes).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("does not index when the session is not materialized", async () => {
    const { executeRaw } = installDb({ gateOn: true, hasSession: false });
    const readTranscriptBytes = vi.fn();

    const indexed = await transcriptSearchIndexService.index(input(), {
      readTranscriptBytes,
    });

    expect(indexed).toBe(false);
    expect(readTranscriptBytes).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("does not index when there is no verified uploaded main transcript", async () => {
    const { executeRaw } = installDb({
      gateOn: true,
      transcriptUploaded: false,
    });
    const readTranscriptBytes = vi.fn();

    const indexed = await transcriptSearchIndexService.index(input(), {
      readTranscriptBytes,
    });

    expect(indexed).toBe(false);
    expect(readTranscriptBytes).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("does not index (and does not throw) when the S3 object is missing", async () => {
    const { executeRaw } = installDb({ gateOn: true });
    const readTranscriptBytes = vi.fn().mockResolvedValue(null);

    const indexed = await transcriptSearchIndexService.index(input(), {
      readTranscriptBytes,
    });

    expect(indexed).toBe(false);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("upserts a null body when the transcript has no extractable text", async () => {
    const { executeRaw } = installDb({ gateOn: true });
    const noText = JSON.stringify({ type: "session_meta", payload: {} });
    const readTranscriptBytes = vi
      .fn()
      .mockResolvedValue(Buffer.from(noText, "utf8"));

    const indexed = await transcriptSearchIndexService.index(input(), {
      readTranscriptBytes,
    });

    // Still writes the row (title/route are useful) but with a null body.
    expect(indexed).toBe(true);
    const sqlValues = interpolatedValues(executeRaw);
    expect(sqlValues).toContain(null);
    expect(sqlValues).toContain("Login bug session");
  });
});

describe("transcriptSearchIndexService.index — org scoping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not index when the session belongs to a different org", async () => {
    // The stored session belongs to ORG, but the request comes in scoped to
    // OTHER_ORG — the org-scoped session lookup misses, so nothing is indexed
    // (no cross-org transcript leak).
    const { executeRaw } = installDb({ gateOn: true, organizationId: ORG });
    const readTranscriptBytes = vi.fn();

    const indexed = await transcriptSearchIndexService.index(
      input({ organizationId: OTHER_ORG }),
      { readTranscriptBytes }
    );

    expect(indexed).toBe(false);
    expect(readTranscriptBytes).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });
});

describe("transcriptSearchIndexService.indexAfterCommit — fail-open", () => {
  beforeEach(() => vi.clearAllMocks());

  it("schedules the index via waitUntil and never throws to the caller", async () => {
    installDb({ gateOn: true });
    const readTranscriptBytes = vi
      .fn()
      .mockResolvedValue(Buffer.from(MAIN_TRANSCRIPT, "utf8"));

    expect(() =>
      transcriptSearchIndexService.indexAfterCommit(input(), {
        readTranscriptBytes,
      })
    ).not.toThrow();
    expect(waitUntilMock).toHaveBeenCalledTimes(1);
    // Draining the scheduled work settles without rejecting (resolves to the
    // index() result — true here — since the success path is not caught).
    await expect(waitUntilMock.mock.calls[0][0]).resolves.toBe(true);
  });

  it("swallows an indexing failure (logged, never rethrown)", async () => {
    installDb({ gateOn: true });
    const readTranscriptBytes = vi
      .fn()
      .mockRejectedValue(new Error("s3 unavailable"));

    transcriptSearchIndexService.indexAfterCommit(input(), {
      readTranscriptBytes,
    });

    await expect(waitUntilMock.mock.calls[0][0]).resolves.toBeUndefined();
  });
});
