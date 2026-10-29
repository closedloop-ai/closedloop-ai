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

import { createHash } from "node:crypto";
import { withDb } from "@repo/database";
import {
  indexKeyCandidates,
  projectIndexKey,
  storedIndexKeyCandidates,
} from "@/lib/index-key-projection";
import {
  TranscriptIdentityOrigin,
  transcriptSearchIndexService,
} from "./transcript-search-indexer";

/**
 * A HIGH-ENTROPY session id past every index-key budget. Entropy matters for the
 * same reason it does in the integration suites: a low-entropy string compresses
 * and would not exercise the bound it claims to.
 */
function overLimitSessionId(): string {
  let digest = "iss-8125-indexer";
  let out = "";
  while (out.length < 2048) {
    digest = createHash("sha256").update(digest).digest("hex");
    out += digest;
  }
  return out.slice(0, 2048);
}

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
  /** The session artifact's stored priority; unset when omitted. */
  priority?: string | null;
  /** The session artifact's assignee (its Owner, ISS-12251). */
  assigneeId?: string;
}) {
  const executeRaw = vi.fn().mockResolvedValue(1);
  const sessionOrg = options.organizationId ?? ORG;
  const hasSession = options.hasSession ?? true;
  const transcriptUploaded = options.transcriptUploaded ?? true;
  const priority = options.priority ?? null;

  const db = {
    $executeRaw: executeRaw,
    sessionDetail: {
      findFirst: vi.fn(
        (args: {
          where: {
            artifact: { is: { organizationId: string } };
            externalSessionId?: unknown;
          };
        }) => {
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
              assigneeId: options.assigneeId ?? "user-1",
              priority,
              updatedAt: new Date("2026-02-02"),
              organization: { searchIncludeTranscripts: options.gateOn },
            },
          });
        }
      ),
    },
    sessionTranscript: {
      findFirst: vi.fn((_args: { where: { externalSessionId?: unknown } }) =>
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

  it("projects the session artifact's priority into the row (ISS-10332)", async () => {
    const { executeRaw } = installDb({ gateOn: true, priority: "URGENT" });
    const readTranscriptBytes = vi
      .fn()
      .mockResolvedValue(Buffer.from(MAIN_TRANSCRIPT, "utf8"));

    await transcriptSearchIndexService.index(input(), { readTranscriptBytes });

    // The value the `:priority` filter compares against is the artifact's own,
    // read in the same statement as the title and owner — not a hardcoded null.
    expect(interpolatedValues(executeRaw)).toContain("URGENT");
  });

  it("projects the session artifact's assignee into the row (ISS-12251)", async () => {
    const { executeRaw } = installDb({
      gateOn: true,
      assigneeId: "user-assignee-12251",
    });
    const readTranscriptBytes = vi
      .fn()
      .mockResolvedValue(Buffer.from(MAIN_TRANSCRIPT, "utf8"));

    await transcriptSearchIndexService.index(input(), { readTranscriptBytes });

    // `@owner` search matches a session by this column, so it is the artifact's
    // assignee — the Owner ingest sets — not a fixed or recording user.
    expect(interpolatedValues(executeRaw)).toContain("user-assignee-12251");
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

describe("transcriptSearchIndexService.index — ISS-8125 projected identity", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  /**
   * ISS-8125 (review, davetho): `complete/route.ts` hands this the RAW wire
   * identity, but both tables it reads store that identity PROJECTED. An exact
   * raw match finds neither row for a long id, so the upload reports `Uploaded`
   * while the search document is silently skipped.
   *
   * Asserted on the `where` the production path actually issues, because that
   * is the contract that broke: the mock returns the same row whatever it is
   * asked for, so a test that only checked the return value would stay green
   * with the raw lookup restored.
   */
  it("probes a long session id by its PROJECTED key first, never by the raw wire value", async () => {
    const longSessionId = overLimitSessionId();
    const { db } = installDb({ gateOn: true });
    const readTranscriptBytes = vi
      .fn()
      .mockResolvedValue(Buffer.from(MAIN_TRANSCRIPT, "utf8"));

    await transcriptSearchIndexService.index(
      { ...input(), externalSessionId: longSessionId },
      { readTranscriptBytes }
    );

    const sessionWhere = db.sessionDetail.findFirst.mock.calls[0]?.[0].where;
    const transcriptWhere =
      db.sessionTranscript.findFirst.mock.calls[0]?.[0].where;

    // ISS-8200 (review, davetho): the ORDERED probe, so the first statement
    // each table receives asks for the projected key — the one every write
    // since ISS-8069 lands on. `SessionDetail` and `SessionTranscript` both
    // store `externalSessionId` at `INDEX_KEY_MAX_BYTES`, so one rule serves
    // both and the pair cannot settle on different rows.
    const [projectedKey, rawKey] = indexKeyCandidates(longSessionId);
    expect(sessionWhere.externalSessionId).toBe(projectedKey);
    expect(transcriptWhere.externalSessionId).toBe(projectedKey);

    // Not vacuous: the projected key really is a different string, and the raw
    // wire value is still reachable as the SECOND candidate — just never first.
    expect(projectedKey).not.toBe(longSessionId);
    expect(rawKey).toBe(longSessionId);

    // The first probe hit, so the legacy candidate cost nothing.
    expect(db.sessionDetail.findFirst).toHaveBeenCalledTimes(1);
    expect(db.sessionTranscript.findFirst).toHaveBeenCalledTimes(1);
  });

  /**
   * ISS-8200 (review, davetho): the defect the ordered probe removes.
   *
   * Both tables can hold a legacy raw row AND its projected sibling — exactly
   * the duplicate pair a pre-ISS-8069 ingest could mint. The two reads are
   * separate statements, so under the old unordered `in` lists Postgres could
   * answer one from the raw row and the other from the projected one, pairing
   * one row's session metadata with the other row's transcript.
   */
  it("resolves the session and its transcript onto the SAME row when a legacy raw sibling also exists", async () => {
    const longSessionId = overLimitSessionId();
    const [projectedKey, rawKey] = indexKeyCandidates(longSessionId);
    const { db, executeRaw } = installDb({ gateOn: true });
    const artifactFor = (key: unknown) => ({
      artifactId: key === projectedKey ? "artifact-projected" : "artifact-raw",
      artifact: {
        name: "Login bug session",
        assigneeId: "user-1",
        priority: null,
        updatedAt: new Date("2026-02-02"),
        organization: { searchIncludeTranscripts: true },
      },
    });
    db.sessionDetail.findFirst.mockImplementation(
      (args: {
        where: {
          artifact: { is: { organizationId: string } };
          externalSessionId?: unknown;
        };
      }) => Promise.resolve(artifactFor(args.where.externalSessionId))
    );
    db.sessionTranscript.findFirst.mockImplementation(
      (args: { where: { externalSessionId?: unknown } }) =>
        Promise.resolve({
          objectStorageKey:
            args.where.externalSessionId === projectedKey
              ? "projected-row.jsonl"
              : "raw-row.jsonl",
        })
    );
    const readTranscriptBytes = vi
      .fn()
      .mockResolvedValue(Buffer.from(MAIN_TRANSCRIPT, "utf8"));

    await transcriptSearchIndexService.index(
      { ...input(), externalSessionId: longSessionId },
      { readTranscriptBytes }
    );

    // Both halves came from the PROJECTED row — the metadata indexed and the
    // transcript object read cannot belong to different rows.
    expect(interpolatedValues(executeRaw)).toContain("artifact-projected");
    expect(readTranscriptBytes.mock.calls[0]?.[0]).toBe("projected-row.jsonl");

    // Positive control on the same selectors: the raw row WAS reachable, so the
    // assertions above pin a precedence rather than an empty store.
    await expect(
      db.sessionTranscript.findFirst({
        where: { externalSessionId: rawKey },
      })
    ).resolves.toEqual({ objectStorageKey: "raw-row.jsonl" });
  });
});

describe("transcriptSearchIndexService.index — ISS-8125 stored identity", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("asks for a STORED id as itself, never re-projected", async () => {
    // ISS-8125 (operator review): `scripts/backfill-transcript-search.ts` pages
    // over `SessionTranscript` and hands this the value it SELECTed, which is
    // already whatever the column holds. Projecting it again digests the
    // projection rather than the session id and lands on a key neither table
    // holds — the sweep then indexes nothing for exactly the sessions whose id
    // had to be bound, and a missed lookup is indistinguishable from a session
    // with nothing to index.
    const storedId = projectIndexKey(overLimitSessionId()).value;
    const { db } = installDb({ gateOn: true });
    const readTranscriptBytes = vi
      .fn()
      .mockResolvedValue(Buffer.from(MAIN_TRANSCRIPT, "utf8"));

    await transcriptSearchIndexService.index(
      {
        ...input(),
        externalSessionId: storedId,
        identityOrigin: TranscriptIdentityOrigin.Stored,
      },
      { readTranscriptBytes }
    );

    const sessionWhere = db.sessionDetail.findFirst.mock.calls[0]?.[0].where;
    const transcriptWhere =
      db.sessionTranscript.findFirst.mock.calls[0]?.[0].where;

    // ISS-8200: the ordered probe asks for one key at a time, and for a stored
    // value that key is the value itself — the stored rule offers nothing else.
    expect(sessionWhere.externalSessionId).toBe(storedId);
    expect(transcriptWhere.externalSessionId).toBe(storedId);
    expect(db.sessionDetail.findFirst).toHaveBeenCalledTimes(1);
    // The default wire handling really would ask for something else, so the
    // assertions above are not vacuously true.
    expect(indexKeyCandidates(storedId)).not.toEqual(
      storedIndexKeyCandidates(storedId)
    );
  });
});
