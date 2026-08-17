/**
 * @file plugin-child-kinds-sql.test.ts
 * @description ISS-6094 — the desktop-owned SQL rendering of the shared
 * `PLUGIN_CHILD_KINDS` contract.
 *
 * The kind LIST is a cross-surface contract and is pinned in `@repo/api`
 * (`src/types/__tests__/plugin-child-kinds.test.ts`). Rendering it into SQLite
 * statement text is desktop persistence, so both the helper and its coverage
 * live here (PR #4916 review — wongk).
 *
 * The three rollup queries in `dashboard/shared-agent-components-api.ts` and the
 * `pack_id` backfill in `packs/component-scanner.ts` interpolate this string
 * directly, so its exact shape — quoted, comma-separated, in the constant's own
 * order — is load-bearing rather than cosmetic.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentComponentKind,
  PLUGIN_CHILD_KINDS,
} from "@repo/api/src/types/agent-component";
import { PLUGIN_CHILD_KINDS_SQL_LIST } from "../src/main/database/db-helpers.js";

test("renders every plugin child kind as a quoted SQL literal, in the constant's order", () => {
  // Built from the const-object members rather than re-spelling the strings, so
  // this pins order and membership without declaring a third copy of the list.
  assert.equal(
    PLUGIN_CHILD_KINDS_SQL_LIST,
    [
      AgentComponentKind.Skill,
      AgentComponentKind.Command,
      AgentComponentKind.Subagent,
      AgentComponentKind.Mcp,
    ]
      .map((kind) => `'${kind}'`)
      .join(", ")
  );
});

test("quotes every member so the rendered list cannot break out of the IN clause", () => {
  const quoted = PLUGIN_CHILD_KINDS_SQL_LIST.split(", ");
  assert.equal(quoted.length, PLUGIN_CHILD_KINDS.length);
  for (const [index, member] of quoted.entries()) {
    assert.equal(member, `'${PLUGIN_CHILD_KINDS[index]}'`);
  }
});
