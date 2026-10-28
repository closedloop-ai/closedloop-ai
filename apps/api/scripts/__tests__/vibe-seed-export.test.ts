import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const pgMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));

vi.mock("pg", () => ({
  default: {
    Client: class {
      connect = pgMocks.connect;
      query = pgMocks.query;
      end = pgMocks.end;
    },
  },
}));

import { batchRows, exportVibeSeed } from "../vibe-seed/export";

const ROW = '{"id":1,"name":"Acme Co"}';
/** One row's escaped size plus its comma, as the batcher counts it. */
const ROW_COST = JSON.stringify(ROW).length - 2 + 1;

describe("batchRows (ISS-12056)", () => {
  it("packs rows into JSON arrays under the escaped-size limit, keeping order", () => {
    const rows = ["1", "2", "3", "4", "5"].map((id) => ROW.replace("1", id));
    const batches = batchRows("organizations", rows, 2 + ROW_COST * 2);

    expect(batches.map((b) => b.count)).toEqual([2, 2, 1]);
    expect(batches.flatMap((b) => JSON.parse(b.json))).toEqual(
      rows.map((row) => JSON.parse(row))
    );
    for (const batch of batches) {
      expect(batch.table).toBe("organizations");
      expect(JSON.stringify(batch.json).length - 2).toBeLessThanOrEqual(
        2 + ROW_COST * 2
      );
    }
  });

  it("keeps big integers as the text Postgres wrote", () => {
    const [batch] = batchRows("users", ['{"byte_size":9007199254740993}']);

    expect(batch?.json).toBe('[{"byte_size":9007199254740993}]');
  });

  it("emits nothing for an empty table", () => {
    expect(batchRows("tags", [])).toEqual([]);
  });

  it("fails on a row that can never fit rather than dropping it", () => {
    expect(() => batchRows("events", [ROW], ROW_COST)).toThrow("over the");
  });
});

describe("exportVibeSeed (ISS-12056)", () => {
  it("writes row batches and local object bytes into one manifest", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "vibe-export-"));
    const transcript = Buffer.from("session transcript");
    pgMocks.query.mockImplementation((sql: string) => {
      if (sql.includes("pg_catalog.pg_class")) {
        return {
          rows: [
            { name: "_prisma_migrations" },
            { name: "organizations" },
            { name: "session_transcript" },
          ],
        };
      }
      if (
        sql.includes("to_jsonb(t)::text") &&
        sql.includes('"organizations"')
      ) {
        return { rows: [{ row: ROW }] };
      }
      if (
        sql.includes("to_jsonb(t)::text") &&
        sql.includes('"session_transcript"')
      ) {
        return {
          rows: [{ row: '{"id":2,"object_storage_key":"session/one"}' }],
        };
      }
      if (sql.includes("SELECT object_storage_key")) {
        return { rows: [{ key: "session/one", crc: "checksum" }] };
      }
      throw new Error(`unexpected export query: ${sql}`);
    });
    const readObject = vi.fn().mockResolvedValue(transcript);
    try {
      const manifest = await exportVibeSeed(
        "postgresql://u:p@127.0.0.1:5432/control_export",
        outDir,
        readObject
      );

      expect(manifest.rows).toEqual([
        { file: "rows/00000.json", table: "organizations", count: 1 },
        { file: "rows/00001.json", table: "session_transcript", count: 1 },
      ]);
      expect(manifest.objects).toEqual([
        {
          file: "objects/00000",
          key: "session/one",
          checksumCrc64Nvme: "checksum",
        },
      ]);
      expect(readObject).toHaveBeenCalledExactlyOnceWith("session/one");
      expect(readFileSync(join(outDir, "rows/00000.json"), "utf8")).toBe(
        `[${ROW}]`
      );
      expect(readFileSync(join(outDir, "objects/00000"))).toEqual(transcript);
      expect(
        JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))
      ).toEqual(manifest);
      expect(
        pgMocks.query.mock.calls.some(([sql]) =>
          String(sql).includes('"_prisma_migrations"')
        )
      ).toBe(false);
      expect(pgMocks.end).toHaveBeenCalledOnce();
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("refuses a database that is not a local control_* one before connecting", async () => {
    const readObject = vi.fn();
    await expect(
      exportVibeSeed(
        "postgresql://u:p@stage.rds.amazonaws.com:5432/closedloop",
        "/tmp/unused",
        readObject
      )
    ).rejects.toThrow("database_url_not_local");
    await expect(
      exportVibeSeed(
        "postgresql://postgres@localhost:5432/symphony",
        "/tmp/unused",
        readObject
      )
    ).rejects.toThrow("database_not_throwaway");
    expect(readObject).not.toHaveBeenCalled();
  });
});
