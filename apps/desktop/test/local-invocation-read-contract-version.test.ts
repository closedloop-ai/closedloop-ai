/**
 * @file local-invocation-read-contract-version.test.ts
 * @description ISS-7580. What the exact-invocation-evidence reader puts on the
 * wire for `normalizerContractVersion` when the stored cell is not a number.
 *
 * `normalizer_contract_version` is declared INTEGER, but SQLite columns hold
 * whatever was written — affinity converts what it can and stores the rest
 * verbatim — so a corrupt cell reaches the mapper as a TEXT value. The mapper
 * used to coerce it with `numberOrZero`, which returned `NaN`; once ISS-7580
 * made that helper finite-safe it would have returned `0` instead, a version no
 * normalizer has ever emitted and one a reader cannot tell from a real one.
 *
 * A version is an identity, not a count, so this reader omits the field — the
 * same shape a NULL column already produces, and the omission the optional
 * cross-repo field already means by "not known".
 *
 * ISS-7580 (@whitlockk review): a general numeric coercion cannot serve here, which
 * is why the reading is now a dedicated version parser shared with the sync-item
 * producer. `Number("")` and `Number("   ")` are FINITE ZEROES, so a finite
 * check alone still emitted version `0` for a blank cell; the wire constraint is
 * `z.number().int().positive().optional()`, so zero, negative, and fractional
 * are as wrong as `NaN`. Each of those spellings is a case below.
 */

import assert from "node:assert/strict";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { test } from "vitest";
import { readAgentComponentInvocationPage } from "../src/main/dashboard/local-invocation-read.js";
import { insertInvocations } from "./agent-components-test-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const COMPONENT_KEY = "contract-version-check";
const SESSION_ID = "session-contract-version";

/**
 * The stored cell, and what the reader must put on the wire for it. SQL literals
 * because these are written past the typed writer on purpose — see below.
 *
 * A FRACTIONAL cell is deliberately absent from this table: it is not reachable
 * at this layer. Measured rather than reasoned — `node:sqlite` keeps `1.5` in an
 * INTEGER-declared column as a REAL (`typeof` = `real`), but the Prisma libSQL
 * adapter this reader goes through hands JS an integer `1`, so the mapper never
 * sees a fraction no matter what is written. The parser rejects one anyway; that
 * case is covered where a fraction can actually arrive — the parser's own unit
 * test and the sync-item suite, both of which inject the value directly.
 */
const STORED_VERSION_CELLS = [
  ["inv-valid", "3", 3],
  ["inv-corrupt", "'n/a'", "absent"],
  ["inv-blank", "''", "absent"],
  ["inv-whitespace", "'   '", "absent"],
  ["inv-zero", "0", "absent"],
  ["inv-negative", "-1", "absent"],
  ["inv-null", "NULL", "absent"],
] as const;

test("ISS-7580: an unreadable normalizer contract version is omitted, never 0", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertInvocations(
      prisma,
      STORED_VERSION_CELLS.map(([id], sequence) => ({
        id,
        sessionId: SESSION_ID,
        componentKind: AgentComponentInvocationKind.Skill,
        componentKey: COMPONENT_KEY,
        anchorKind: AgentComponentInvocationAnchorKind.Session,
        anchorValue: SESSION_ID,
        sequence,
      }))
    );
    // Written past the typed writer on purpose: the types constrain what this
    // process writes, not what an older build, a partial migration, or a
    // hand-repaired store left in the column.
    await prisma.write(async (client) => {
      for (const [id, cell] of STORED_VERSION_CELLS) {
        await client.$executeRawUnsafe(
          `UPDATE agent_component_invocations SET normalizer_contract_version = ${cell} WHERE id = '${id}'`
        );
      }
    });

    const page = await readAgentComponentInvocationPage(
      prisma,
      AgentComponentInvocationKind.Skill,
      COMPONENT_KEY,
      []
    );
    const versionsById = Object.fromEntries(
      (page?.items ?? []).map((item) => [
        item.id,
        "normalizerContractVersion" in item
          ? item.normalizerContractVersion
          : "absent",
      ])
    );
    assert.deepEqual(
      versionsById,
      Object.fromEntries(
        STORED_VERSION_CELLS.map(([id, , expected]) => [id, expected])
      )
    );
  } finally {
    await close();
  }
});
