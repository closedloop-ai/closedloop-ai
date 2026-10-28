import type pg from "pg";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";

/** The stored Yjs state, or `null` for a document never stored. */
export async function loadDocumentState(
  pool: pg.Pool,
  name: string
): Promise<Uint8Array | null> {
  const { rows } = await pool.query<{ state: Buffer }>(
    "SELECT state FROM document_state WHERE name = $1",
    [name]
  );
  return rows[0] ? new Uint8Array(rows[0].state) : null;
}

/**
 * Merges `update` into the stored state, never overwriting it, so a save from
 * a stale copy cannot drop updates another writer stored, including when two
 * first saves of a document race or the row is deleted mid-save.
 */
export async function saveDocumentState(
  pool: pg.Pool,
  name: string,
  update: Uint8Array
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let attempt = 0;
    while (!(await insertOrMerge(client, name, update))) {
      attempt += 1;
      if (attempt >= SAVE_ATTEMPTS) {
        throw new Error(
          `document_state row ${name} was deleted under ${SAVE_ATTEMPTS} consecutive saves`
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Removes a document's stored state; `true` when a row existed. The delete
 * sticks only once the document is unloaded, because the next store of a
 * loaded document re-inserts the row: the delete command (ISS-12506) must
 * close the document's connections and unload it before calling this.
 */
export async function deleteDocumentState(
  pool: pg.Pool,
  name: string
): Promise<boolean> {
  const { rowCount } = await pool.query(
    "DELETE FROM document_state WHERE name = $1 RETURNING name",
    [name]
  );
  return (rowCount ?? 0) > 0;
}

export async function documentStateExists(
  pool: pg.Pool,
  name: string
): Promise<boolean> {
  const { rowCount } = await pool.query(
    "SELECT 1 FROM document_state WHERE name = $1 LIMIT 1",
    [name]
  );
  return (rowCount ?? 0) > 0;
}

export async function listDocumentNames(
  pool: pg.Pool,
  after: string | undefined,
  limit: number
): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM document_state
     WHERE ($1::text IS NULL OR name > $1)
     ORDER BY name
     LIMIT $2`,
    [after ?? null, limit]
  );
  return rows.map((row) => row.name);
}

const SAVE_ATTEMPTS = 3;

/**
 * Inserts the row or merges into the locked one; `false` when a delete
 * committed between the insert's conflict and the lock, so nothing was stored.
 */
async function insertOrMerge(
  client: pg.PoolClient,
  name: string,
  update: Uint8Array
): Promise<boolean> {
  const inserted = await client.query(
    `INSERT INTO document_state (name, state) VALUES ($1, $2)
     ON CONFLICT (name) DO NOTHING
     RETURNING name`,
    [name, Buffer.from(update)]
  );
  if (inserted.rowCount !== 0) {
    return true;
  }
  const { rows } = await client.query<{ state: Buffer }>(
    "SELECT state FROM document_state WHERE name = $1 FOR UPDATE",
    [name]
  );
  const stored = rows[0]?.state;
  if (!stored) {
    return false;
  }
  await client.query(
    `UPDATE document_state SET state = $2, updated_at = now()
     WHERE name = $1`,
    [name, Buffer.from(merged(new Uint8Array(stored), update))]
  );
  return true;
}

/**
 * Applies both states to one garbage-collecting doc rather than
 * `mergeUpdates`, which keeps the content of text a later state deleted.
 */
function merged(stored: Uint8Array, update: Uint8Array): Uint8Array {
  const doc = new Doc({ gc: true });
  try {
    applyUpdate(doc, stored);
    applyUpdate(doc, update);
    return encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
