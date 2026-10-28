/**
 * @file import-session-created-at.test.ts
 * @description ISS-12251 (PLN-2176 T-6.4): the import writes
 * `sessions.created_at = ISO(fileCreatedAt ?? startedAt)` on INSERT. On
 * re-import a birth time fills a NULL or lowers the stored value, the startedAt
 * fallback only fills a NULL, and a `created_at`-only change leaves
 * `updated_at` alone (it is the record-mutation clock); the live-hook and Codex OTel row creators leave it NULL for a later
 * import to fill. Drives the real importer, lifecycle and OTel writer against a
 * migrated store and asserts the persisted row.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { createSqliteTokenUsageStore } from "../src/main/database/read-stores.js";
import { createSqliteImporter } from "../src/main/database/write-core.js";
import {
  importedSessionCreatedAt,
  mergeSessionCreatedAt,
} from "../src/main/database/write-core-session-created-at.js";
import { persistCodexOtelBatch } from "../src/main/otel/codex-otel-writer.js";
import { openLiveHookHarness } from "./live-hook-coverage-harness.js";
import { makeSession } from "./normalized-session-test-utils.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

const NOW = "2026-08-12T12:00:00.000Z";
const NOW_PLUS_ONE_MS = "2026-08-12T12:00:00.001Z";
const STARTED_AT = "2026-08-12T11:00:00.000Z";
const ENDED_AT = "2026-08-12T11:30:00.000Z";
const FILE_CREATED_AT = "2026-08-10T09:15:00.000Z";
const EARLIER_FILE_CREATED_AT = "2026-08-01T08:00:00.000Z";
const LATER_FILE_CREATED_AT = "2026-08-11T10:00:00.000Z";
/** A birth time after STARTED_AT, as for a transcript copied mid-session. */
const COPIED_FILE_CREATED_AT = "2026-08-12T11:45:00.000Z";
const ORIGINAL_NAME = "Original session";
const RENAMED_NAME = "Renamed session";
/** Well before the recent-activity window of NOW, so imports are terminal. */
const OLD_FILE_MTIME_MS = Date.parse("2026-08-11T00:00:00.000Z");

type CreatedAtRow = { created_at: string | null; updated_at: string | null };

function importerFor(prisma: OpenTestPrisma["prisma"]) {
  return createSqliteImporter(prisma, createSqliteTokenUsageStore(prisma), {
    detectBillingMode: () => "metered_api",
    now: () => NOW,
    log: () => {
      // discarded: no case asserts on import log output
    },
  });
}

function session(
  sessionId: string,
  overrides: Partial<NormalizedSession> = {}
): NormalizedSession {
  return makeSession({
    sessionId,
    cwd: "/sandbox/project",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    fileModifiedAt: OLD_FILE_MTIME_MS,
    ...overrides,
  });
}

async function readCreatedAt(
  prisma: OpenTestPrisma["prisma"],
  sessionId: string
): Promise<CreatedAtRow | undefined> {
  const rows = await prisma.client.$queryRawUnsafe<CreatedAtRow[]>(
    "SELECT created_at, updated_at FROM sessions WHERE id = $1",
    sessionId
  );
  return rows[0];
}

function clearCreatedAt(
  prisma: OpenTestPrisma["prisma"],
  sessionId: string
): Promise<unknown> {
  return prisma.write((client) =>
    client.$executeRawUnsafe(
      "UPDATE sessions SET created_at = NULL WHERE id = $1",
      sessionId
    )
  );
}

async function withStore(
  run: (h: OpenTestPrisma) => Promise<void>
): Promise<void> {
  const h = await openTestPrisma();
  try {
    await run(h);
  } finally {
    await h.close();
  }
}

describe("ISS-12251: import INSERT binds created_at", () => {
  test("from the transcript's birth time when present", async () => {
    await withStore(async (h) => {
      await importerFor(h.prisma).importSession(
        session("born", { fileCreatedAt: Date.parse(FILE_CREATED_AT) }),
        "claude"
      );
      assert.equal(
        (await readCreatedAt(h.prisma, "born"))?.created_at,
        FILE_CREATED_AT
      );
    });
  });

  test("from startedAt, canonicalized, when there is no birth time", async () => {
    await withStore(async (h) => {
      await importerFor(h.prisma).importSession(
        session("started-only", { startedAt: "2026-08-12T13:00:00+02:00" }),
        "claude"
      );
      assert.equal(
        (await readCreatedAt(h.prisma, "started-only"))?.created_at,
        STARTED_AT
      );
    });
  });

  // The importer refuses a session with no startedAt at all, so the reachable
  // "neither" case is a startedAt that is not an instant.
  test("as NULL when neither a birth time nor a usable startedAt exists", async () => {
    await withStore(async (h) => {
      await importerFor(h.prisma).importSession(
        session("no-instant", { startedAt: "not-a-timestamp" }),
        "claude"
      );
      const row = await readCreatedAt(h.prisma, "no-instant");
      assert.ok(row, "the row was imported");
      assert.equal(row.created_at, null);
    });
  });
});

describe("ISS-12251: re-import merges created_at fill-or-min", () => {
  test("fills a NULL value without moving updated_at", async () => {
    await withStore(async (h) => {
      const importer = importerFor(h.prisma);
      const born = session("fill", {
        fileCreatedAt: Date.parse(FILE_CREATED_AT),
      });
      await importer.importSession(born, "claude");
      await clearCreatedAt(h.prisma, "fill");

      await importer.importSession(born, "claude");
      assert.deepEqual(await readCreatedAt(h.prisma, "fill"), {
        created_at: FILE_CREATED_AT,
        updated_at: NOW,
      });
    });
  });

  test("keeps the stored value against a later birth time, without advancing the watermark", async () => {
    await withStore(async (h) => {
      const importer = importerFor(h.prisma);
      await importer.importSession(
        session("later", { fileCreatedAt: Date.parse(FILE_CREATED_AT) }),
        "claude"
      );
      await importer.importSession(
        session("later", { fileCreatedAt: Date.parse(LATER_FILE_CREATED_AT) }),
        "claude"
      );
      assert.deepEqual(await readCreatedAt(h.prisma, "later"), {
        created_at: FILE_CREATED_AT,
        updated_at: NOW,
      });
    });
  });

  test("lowers the stored value to an earlier birth time without moving updated_at", async () => {
    await withStore(async (h) => {
      const importer = importerFor(h.prisma);
      await importer.importSession(
        session("earlier", { fileCreatedAt: Date.parse(FILE_CREATED_AT) }),
        "claude"
      );
      await importer.importSession(
        session("earlier", {
          fileCreatedAt: Date.parse(EARLIER_FILE_CREATED_AT),
        }),
        "claude"
      );
      assert.deepEqual(await readCreatedAt(h.prisma, "earlier"), {
        created_at: EARLIER_FILE_CREATED_AT,
        updated_at: NOW,
      });
    });
  });

  test("a created_at-only change leaves a stored updated_at untouched", async () => {
    await withStore(async (h) => {
      const importer = importerFor(h.prisma);
      await importer.importSession(
        session("untouched", { fileCreatedAt: Date.parse(FILE_CREATED_AT) }),
        "claude"
      );
      await h.prisma.write((client) =>
        client.$executeRawUnsafe(
          "UPDATE sessions SET updated_at = $1 WHERE id = $2",
          ENDED_AT,
          "untouched"
        )
      );

      await importer.importSession(
        session("untouched", {
          fileCreatedAt: Date.parse(EARLIER_FILE_CREATED_AT),
        }),
        "claude"
      );
      assert.deepEqual(await readCreatedAt(h.prisma, "untouched"), {
        created_at: EARLIER_FILE_CREATED_AT,
        updated_at: ENDED_AT,
      });
    });
  });

  test("leaves an unchanged value and the watermark alone", async () => {
    await withStore(async (h) => {
      const importer = importerFor(h.prisma);
      const born = session("same", {
        fileCreatedAt: Date.parse(FILE_CREATED_AT),
      });
      await importer.importSession(born, "claude");
      await importer.importSession(born, "claude");
      assert.deepEqual(await readCreatedAt(h.prisma, "same"), {
        created_at: FILE_CREATED_AT,
        updated_at: NOW,
      });
    });
  });
});

describe("ISS-12251: rows created outside the import", () => {
  test("the live hook leaves created_at NULL and a later import fills it", async () => {
    const h = await openLiveHookHarness();
    try {
      await h.send("SessionStart", {
        session_id: "live",
        cwd: "/sandbox/project",
      });
      assert.equal((await readCreatedAt(h.prisma, "live"))?.created_at, null);

      await importerFor(h.prisma).importSession(
        session("live", { fileCreatedAt: Date.parse(FILE_CREATED_AT) }),
        "claude"
      );
      assert.equal(
        (await readCreatedAt(h.prisma, "live"))?.created_at,
        FILE_CREATED_AT
      );
    } finally {
      await h.close();
    }
  });

  test("the Codex OTel upsert leaves created_at NULL and a later import fills it", async () => {
    await withStore(async (h) => {
      await persistCodexOtelBatch({
        prisma: h.prisma,
        now: NOW,
        batch: {
          spans: [],
          tokenUsage: [
            {
              sessionId: "otel",
              observedAt: STARTED_AT,
              model: "gpt-5-codex",
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          ],
        },
      });
      assert.equal((await readCreatedAt(h.prisma, "otel"))?.created_at, null);

      await importerFor(h.prisma).importSession(
        session("otel", { fileCreatedAt: Date.parse(FILE_CREATED_AT) }),
        "codex"
      );
      assert.equal(
        (await readCreatedAt(h.prisma, "otel"))?.created_at,
        FILE_CREATED_AT
      );
    });
  });
});

describe("ISS-12251: a content-changing re-import carries the merged created_at", () => {
  test("keeps the stored value against a later birth time", async () => {
    await withStore(async (h) => {
      const importer = importerFor(h.prisma);
      await importer.importSession(
        session("renamed-later", {
          name: ORIGINAL_NAME,
          fileCreatedAt: Date.parse(FILE_CREATED_AT),
        }),
        "claude"
      );
      await importer.importSession(
        session("renamed-later", {
          name: RENAMED_NAME,
          fileCreatedAt: Date.parse(LATER_FILE_CREATED_AT),
        }),
        "claude"
      );
      assert.deepEqual(await readCreatedAt(h.prisma, "renamed-later"), {
        created_at: FILE_CREATED_AT,
        updated_at: NOW_PLUS_ONE_MS,
      });
    });
  });

  test("lowers the stored value to an earlier birth time", async () => {
    await withStore(async (h) => {
      const importer = importerFor(h.prisma);
      await importer.importSession(
        session("renamed-earlier", {
          name: ORIGINAL_NAME,
          fileCreatedAt: Date.parse(FILE_CREATED_AT),
        }),
        "claude"
      );
      await importer.importSession(
        session("renamed-earlier", {
          name: RENAMED_NAME,
          fileCreatedAt: Date.parse(EARLIER_FILE_CREATED_AT),
        }),
        "claude"
      );
      assert.deepEqual(await readCreatedAt(h.prisma, "renamed-earlier"), {
        created_at: EARLIER_FILE_CREATED_AT,
        updated_at: NOW_PLUS_ONE_MS,
      });
    });
  });
});

const REIMPORT_ARMS = [
  { arm: "unchanged content", name: ORIGINAL_NAME, keptWatermark: NOW },
  {
    arm: "changed content",
    name: RENAMED_NAME,
    keptWatermark: NOW_PLUS_ONE_MS,
  },
] as const;

describe("ISS-12251: the startedAt fallback only fills a NULL created_at", () => {
  for (const { arm, name, keptWatermark } of REIMPORT_ARMS) {
    test(`keeps a stored birth time later than startedAt (${arm})`, async () => {
      await withStore(async (h) => {
        const importer = importerFor(h.prisma);
        await importer.importSession(
          session("kept", {
            name: ORIGINAL_NAME,
            fileCreatedAt: Date.parse(COPIED_FILE_CREATED_AT),
          }),
          "claude"
        );
        await importer.importSession(session("kept", { name }), "claude");
        assert.deepEqual(await readCreatedAt(h.prisma, "kept"), {
          created_at: COPIED_FILE_CREATED_AT,
          updated_at: keptWatermark,
        });
      });
    });

    test(`fills a NULL value with startedAt (${arm})`, async () => {
      await withStore(async (h) => {
        const importer = importerFor(h.prisma);
        await importer.importSession(
          session("filled", {
            name: ORIGINAL_NAME,
            fileCreatedAt: Date.parse(COPIED_FILE_CREATED_AT),
          }),
          "claude"
        );
        await clearCreatedAt(h.prisma, "filled");
        await importer.importSession(session("filled", { name }), "claude");
        assert.deepEqual(await readCreatedAt(h.prisma, "filled"), {
          created_at: STARTED_AT,
          updated_at: keptWatermark,
        });
      });
    });
  }
});

describe("ISS-12251: created_at values at the write boundary", () => {
  test("an unusable birth time falls back to startedAt", () => {
    for (const fileCreatedAt of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Date.parse("+010000-01-01T00:00:00.000Z"),
    ]) {
      assert.deepEqual(
        importedSessionCreatedAt({ fileCreatedAt, startedAt: STARTED_AT }),
        { value: STARTED_AT, fromFile: false },
        `fileCreatedAt ${fileCreatedAt}`
      );
    }
  });

  test("an unparseable stored value takes an incoming birth time", () => {
    assert.equal(
      mergeSessionCreatedAt("not-a-timestamp", {
        value: FILE_CREATED_AT,
        fromFile: true,
      }),
      FILE_CREATED_AT
    );
  });

  test("an unparseable stored value takes the startedAt fallback", () => {
    assert.equal(
      mergeSessionCreatedAt("not-a-timestamp", {
        value: STARTED_AT,
        fromFile: false,
      }),
      STARTED_AT
    );
  });

  test("no incoming value keeps the stored one, NULL included", () => {
    const none = { value: null, fromFile: false } as const;
    assert.equal(mergeSessionCreatedAt(FILE_CREATED_AT, none), FILE_CREATED_AT);
    assert.equal(mergeSessionCreatedAt(null, none), null);
  });
});
