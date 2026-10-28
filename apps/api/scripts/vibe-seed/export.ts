/**
 * ISS-12056: CLI that packs a seeded local vibe database for the vibe
 * environment workflow to load into a branch's preview schema through the
 * stage API (`/preview-schemas/vibe-environment/*`).
 *
 * Usage (from `apps/api`; refuses anything but a local control_* database,
 * exactly as the seed does):
 *   pnpm vibe:export --database-url postgresql://…@localhost:5432/control_x --out <dir>
 *
 * Writes `<dir>/manifest.json` plus one file per row batch (`rows/*.json`, the
 * JSON array text Postgres produced, never parsed into JavaScript numbers) and
 * one file per uploaded transcript (`objects/*`, read back from the local
 * object store the seed uploaded to). Prints the manifest's counts on stdout.
 */

import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { getTranscriptObjectBytesRange } from "@repo/aws/transcript-storage";
import { quoteIdentifier } from "@repo/database/scripts/db-utils";
import { NEVER_RESTORED_TABLES } from "@repo/database/scripts/vibe-environment-restore";
import pg from "pg";
import { z } from "zod";
import { checkVibeDatabaseUrl } from "./guards";

/**
 * A batch's rows as JSON text stay under this, so the request that carries
 * them as an escaped JSON string stays under the rows route's 4 MiB cap.
 */
export const EXPORT_BATCH_MAX_ESCAPED_BYTES = 3 * 1024 * 1024;

/** Every byte of a transcript object; S3 and MinIO answer with the whole object. */
const WHOLE_OBJECT_BYTES = Number.MAX_SAFE_INTEGER;

export type RowBatch = { table: string; json: string; count: number };

export type ExportManifest = {
  rows: { file: string; table: string; count: number }[];
  objects: { file: string; key: string; checksumCrc64Nvme: string }[];
};

/**
 * Packs one table's row texts into JSON arrays whose escaped size stays under
 * `maxEscapedBytes`. A single row that cannot fit is an error, not a silent
 * drop: the environment would come up missing it.
 */
export function batchRows(
  table: string,
  rows: readonly string[],
  maxEscapedBytes: number = EXPORT_BATCH_MAX_ESCAPED_BYTES
): RowBatch[] {
  const batches: RowBatch[] = [];
  let current: string[] = [];
  let currentBytes = 2;
  for (const row of rows) {
    const rowBytes = escapedLength(row) + 1;
    if (rowBytes + 2 > maxEscapedBytes) {
      throw new Error(
        `a ${table} row is ${rowBytes} bytes escaped, over the ${maxEscapedBytes}-byte batch limit`
      );
    }
    if (currentBytes + rowBytes > maxEscapedBytes && current.length > 0) {
      batches.push(toBatch(table, current));
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length > 0) {
    batches.push(toBatch(table, current));
  }
  return batches;
}

export async function exportVibeSeed(
  databaseUrl: string,
  outDir: string,
  readObject: (key: string) => Promise<Buffer | null> = (key) =>
    getTranscriptObjectBytesRange(key, WHOLE_OBJECT_BYTES)
): Promise<ExportManifest> {
  const target = checkVibeDatabaseUrl(databaseUrl);
  if (!target.ok) {
    throw new Error(`${target.error.code}: ${target.error.message}`);
  }
  const client = new pg.Client({ connectionString: target.value.databaseUrl });
  await client.connect();
  try {
    await mkdir(join(outDir, "rows"), { recursive: true });
    await mkdir(join(outDir, "objects"), { recursive: true });
    const manifest: ExportManifest = { rows: [], objects: [] };
    for (const table of await listTables(client)) {
      const { rows } = await client.query<{ row: string }>(
        `SELECT to_jsonb(t)::text AS row FROM "public".${quoteIdentifier(table)} AS t`
      );
      for (const batch of batchRows(
        table,
        rows.map((r) => r.row)
      )) {
        const file = `rows/${String(manifest.rows.length).padStart(5, "0")}.json`;
        await writeFile(join(outDir, file), batch.json);
        manifest.rows.push({ file, table, count: batch.count });
      }
    }
    await exportObjects(client, outDir, manifest, readObject);
    await writeFile(
      join(outDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    return manifest;
  } finally {
    await client.end();
  }
}

async function listTables(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
     ORDER BY c.relname`
  );
  return rows
    .map((row) => row.name)
    .filter((name) => !NEVER_RESTORED_TABLES.has(name));
}

async function exportObjects(
  client: pg.Client,
  outDir: string,
  manifest: ExportManifest,
  readObject: (key: string) => Promise<Buffer | null>
): Promise<void> {
  const { rows } = await client.query<{ key: string; crc: string | null }>(
    `SELECT object_storage_key AS key, crc64nvme AS crc FROM "public"."session_transcript"
     WHERE upload_status = $1 ORDER BY object_storage_key`,
    [TranscriptUploadStatus.Uploaded]
  );
  for (const row of rows) {
    if (row.crc === null) {
      throw new Error(
        `uploaded transcript ${row.key} has no recorded checksum`
      );
    }
    const bytes = await readObject(row.key);
    if (bytes === null) {
      throw new Error(
        `uploaded transcript ${row.key} is not in the local object store`
      );
    }
    const file = `objects/${String(manifest.objects.length).padStart(5, "0")}`;
    await writeFile(join(outDir, file), bytes);
    manifest.objects.push({ file, key: row.key, checksumCrc64Nvme: row.crc });
  }
}

function toBatch(table: string, rows: string[]): RowBatch {
  return { table, json: `[${rows.join(",")}]`, count: rows.length };
}

function escapedLength(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

const argsSchema = z.object({
  "database-url": z.string().min(1),
  out: z.string().min(1),
});

export async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "database-url": { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });
  const args = argsSchema.parse(values);
  const manifest = await exportVibeSeed(
    args["database-url"],
    resolve(args.out)
  );
  process.stdout.write(
    `${JSON.stringify({ batches: manifest.rows.length, objects: manifest.objects.length })}\n`
  );
  return 0;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url ===
    pathToFileURL(realpathSync(resolve(process.argv[1]))).href;

if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(
        `[vibe-export] ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exit(1);
    }
  );
}
